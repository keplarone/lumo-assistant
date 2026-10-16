//! Downloads of the speech model's files: https only, resumable, and moved into place only once
//! each file's size and SHA-256 match its pin.

use crate::core::Core;
use crate::error::{LumoError, Result};
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Where model files come from (tests point it at a mock server).
pub const DOWNLOAD_HOST: &str = "https://huggingface.co";

pub fn models_dir(core: &Core) -> PathBuf {
    core.paths.data_dir.join("models")
}

pub(crate) fn download_host(core: &Core) -> String {
    core.endpoints.lock().model_downloads.clone()
}

/// The client for model files: https only, including every redirect (Hugging Face redirects to its
/// storage CDN), and a stall timeout instead of a total one, since the weights are hundreds of megabytes.
fn download_client() -> Result<reqwest::Client> {
    let https_only = !cfg!(test);
    reqwest::Client::builder()
        .user_agent(concat!("Lumo/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(60))
        .https_only(https_only)
        .redirect(reqwest::redirect::Policy::custom(move |a| {
            if a.previous().len() >= 10 {
                a.error("too many redirects")
            } else if https_only && a.url().scheme() != "https" {
                a.error("model downloads must use https")
            } else {
                a.follow()
            }
        }))
        .build()
        .map_err(LumoError::Http)
}

/// A file pinned by size and SHA-256.
pub(crate) struct PinnedFile<'a> {
    pub url: String,
    pub dest: PathBuf,
    /// Where the download collects until it is verified.
    pub part: PathBuf,
    pub size: u64,
    pub sha256: &'a str,
}

/// Download a pinned file, resuming a partial one, and move it into place only once its size and
/// SHA-256 match. Progress goes to `emit(status, completed, total, done)`.
pub(crate) async fn download_pinned(
    pinned: &PinnedFile<'_>,
    cancel: &tokio_util::sync::CancellationToken,
    emit: &(dyn Fn(&str, u64, u64, bool) + Sync),
) -> Result<()> {
    if let Some(dir) = pinned.dest.parent() {
        tokio::fs::create_dir_all(dir).await?;
    }
    let part = pinned.part.clone();
    let total = pinned.size;

    // Hash what an earlier attempt already saved, so the check covers the whole file.
    let mut hasher = Sha256::new();
    let mut have = tokio::fs::metadata(&part).await.map(|m| m.len()).unwrap_or(0);
    if have > total {
        tokio::fs::remove_file(&part).await?;
        have = 0;
    }
    if have > 0 {
        emit("checking", 0, 0, false);
        let mut f = tokio::fs::File::open(&part).await?;
        let mut buf = vec![0u8; 1 << 20];
        loop {
            if cancel.is_cancelled() {
                return Err(LumoError::Cancelled);
            }
            let n = f.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
    }

    let mut req = download_client()?.get(&pinned.url);
    if have > 0 {
        req = req.header(reqwest::header::RANGE, format!("bytes={have}-"));
    }
    let resp = tokio::select! {
        r = req.send() => r.map_err(|e| LumoError::Unavailable(format!("Couldn't reach the download server ({e}). Check your internet connection and try again.")))?,
        _ = cancel.cancelled() => return Err(LumoError::Cancelled),
    };
    let status = resp.status();
    let mut file = if have > 0 && status == reqwest::StatusCode::PARTIAL_CONTENT {
        tokio::fs::OpenOptions::new().append(true).open(&part).await?
    } else if status.is_success() {
        // The server sent the whole file: start over.
        have = 0;
        hasher = Sha256::new();
        tokio::fs::File::create(&part).await?
    } else {
        return Err(LumoError::Unavailable(format!("The download server answered HTTP {}. Try again later.", status.as_u16())));
    };

    let mut done = have;
    let mut last = Instant::now();
    emit("downloading", done, total, false);
    let mut stream = resp.bytes_stream();
    loop {
        let chunk = tokio::select! {
            c = stream.next() => c,
            _ = cancel.cancelled() => {
                file.flush().await?;
                return Err(LumoError::Cancelled);
            }
        };
        let Some(chunk) = chunk else { break };
        let chunk = chunk
            .map_err(|e| LumoError::Unavailable(format!("The download stopped ({e}). Download again to continue where it stopped.")))?;
        if done + chunk.len() as u64 > total {
            drop(file);
            let _ = tokio::fs::remove_file(&part).await;
            return Err(LumoError::Unavailable("The download was larger than expected, so it was discarded.".into()));
        }
        hasher.update(&chunk);
        file.write_all(&chunk).await?;
        done += chunk.len() as u64;
        if last.elapsed() >= Duration::from_millis(250) {
            last = Instant::now();
            emit("downloading", done, total, false);
        }
    }
    file.flush().await?;
    file.sync_all().await?;
    drop(file);
    if done < total {
        return Err(LumoError::Unavailable("The download stopped before it finished. Download again to continue where it stopped.".into()));
    }
    emit("verifying", total, total, false);
    let digest = hex::encode(hasher.finalize());
    if digest != pinned.sha256 {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(LumoError::Unavailable("The downloaded file didn't match the expected checksum, so it was deleted. Try again.".into()));
    }
    tokio::fs::rename(&part, &pinned.dest).await?;
    Ok(())
}
