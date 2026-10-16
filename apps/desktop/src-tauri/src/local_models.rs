//! On-device models: Lumo's own model configurations (Orbit 3.8, Nebula 4.2, Solar 5.4, Nova 5.5 and
//! Nebula Vision 4.2, the same product names Keplar uses in Space Studio), each an open-weight model
//! that runs on the user's computer, so requests cost nothing and never leave the machine. Nebula
//! Vision can also see images, so on-device users get screen control: its screenshots stay on the
//! computer too.
//!
//! Lumo runs them itself with its built-in llama.cpp engine (`model::local`); nothing else needs to
//! be installed. Lumo does not ship the weights: it downloads only the files in its own catalog,
//! over https from Hugging Face, each pinned to a repository revision and checked against its
//! SHA-256 before it is used. A vision model has a second pinned file, its image projector
//! ("mmproj"), downloaded and checked the same way; the model counts as installed only with both.
//! All are Apache-2.0 licensed, and the original model name and license are shown to the user. The
//! webview only ever sees catalog ids, never file paths.

use crate::core::Core;
use crate::error::{invalid, LumoError, Result};
use crate::model::local::format::Family;
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Label for the on-device engine as a whole.
pub const BRAND: &str = "Lumo on-device models";
/// Where catalog files are downloaded from. Tests point `Core::endpoints` elsewhere.
pub const DOWNLOAD_HOST: &str = "https://huggingface.co";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    /// Catalog id, e.g. "qwen3:8b". Stored in settings and plans; not a file name.
    pub id: &'static str,
    /// Product name shown to the user, e.g. "Nebula 4.2".
    pub tier: &'static str,
    /// The underlying open model, always shown for attribution.
    pub base_model: &'static str,
    pub license: &'static str,
    pub license_url: &'static str,
    /// The Hugging Face repository the weights come from, for attribution.
    pub source_repo: &'static str,
    pub download_gb: f32,
    pub min_memory_gb: u32,
    pub summary: &'static str,
    /// Sees images (screenshots and attachments), which is what screen control needs.
    pub vision: bool,
    /// Repository revision (commit) the download is pinned to.
    #[serde(skip)]
    pub revision: &'static str,
    #[serde(skip)]
    pub file_name: &'static str,
    #[serde(skip)]
    pub size_bytes: u64,
    /// SHA-256 of the file (Hugging Face's LFS object id).
    #[serde(skip)]
    pub sha256: &'static str,
    #[serde(skip)]
    pub family: Family,
    /// Context window Lumo allocates for this model (bounds its memory use).
    #[serde(skip)]
    pub context_tokens: u32,
    /// The image projector a vision model needs, from the same repository and revision.
    #[serde(skip)]
    pub projector: Option<Projector>,
}

/// A vision model's second file: the projector that turns an image into tokens the model reads.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Projector {
    pub file_name: &'static str,
    pub size_bytes: u64,
    /// SHA-256 of the file (Hugging Face's LFS object id).
    pub sha256: &'static str,
}

/// One pinned file of a catalog entry: the model, or its projector.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PinnedFile {
    pub file_name: &'static str,
    pub size_bytes: u64,
    pub sha256: &'static str,
}

impl CatalogEntry {
    /// The pinned download address under a host such as `DOWNLOAD_HOST`.
    pub fn url(&self, host: &str) -> String {
        self.file_url(host, self.file_name)
    }

    /// The pinned download address of one of this entry's files.
    pub fn file_url(&self, host: &str, file_name: &str) -> String {
        format!("{}/{}/resolve/{}/{}", host.trim_end_matches('/'), self.source_repo, self.revision, file_name)
    }

    /// Every file this entry needs, the model first.
    pub fn files(&self) -> Vec<PinnedFile> {
        let mut v = vec![PinnedFile { file_name: self.file_name, size_bytes: self.size_bytes, sha256: self.sha256 }];
        if let Some(p) = self.projector {
            v.push(PinnedFile { file_name: p.file_name, size_bytes: p.size_bytes, sha256: p.sha256 });
        }
        v
    }

    /// Bytes to download for the whole entry.
    pub fn total_bytes(&self) -> u64 {
        self.files().iter().map(|f| f.size_bytes).sum()
    }
}

pub const CATALOG: &[CatalogEntry] = &[
    CatalogEntry {
        id: "qwen3:4b",
        tier: "Orbit 3.8",
        base_model: "Qwen3 4B",
        license: "Apache-2.0",
        license_url: "https://www.apache.org/licenses/LICENSE-2.0",
        source_repo: "Qwen/Qwen3-4B-GGUF",
        download_gb: 2.5,
        min_memory_gb: 8,
        vision: false,
        summary: "Quick answers and simple tasks on most laptops.",
        revision: "bc640142c66e1fdd12af0bd68f40445458f3869b",
        file_name: "Qwen3-4B-Q4_K_M.gguf",
        size_bytes: 2_497_280_256,
        sha256: "7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5",
        family: Family::Qwen3,
        context_tokens: 16_384,
        projector: None,
    },
    CatalogEntry {
        id: "qwen3:8b",
        tier: "Nebula 4.2",
        base_model: "Qwen3 8B",
        license: "Apache-2.0",
        license_url: "https://www.apache.org/licenses/LICENSE-2.0",
        source_repo: "Qwen/Qwen3-8B-GGUF",
        download_gb: 5.0,
        min_memory_gb: 16,
        vision: false,
        summary: "Good everyday choice for planning and using tools.",
        revision: "7c41481f57cb95916b40956ab2f0b139b296d974",
        file_name: "Qwen3-8B-Q4_K_M.gguf",
        size_bytes: 5_027_783_488,
        sha256: "d98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785",
        family: Family::Qwen3,
        context_tokens: 16_384,
        projector: None,
    },
    CatalogEntry {
        id: "gpt-oss:20b",
        tier: "Solar 5.4",
        base_model: "gpt-oss 20B",
        license: "Apache-2.0",
        license_url: "https://www.apache.org/licenses/LICENSE-2.0",
        // gpt-oss is published in its native MXFP4 quantization (there is no Q4_K_M build).
        source_repo: "ggml-org/gpt-oss-20b-GGUF",
        download_gb: 12.1,
        min_memory_gb: 16,
        vision: false,
        summary: "Stronger reasoning; needs a recent computer with 16 GB of memory or more.",
        revision: "ef9b12f2ff56c69cf32153a02784e7a3c88bf524",
        file_name: "gpt-oss-20b-MXFP4.gguf",
        size_bytes: 12_109_566_624,
        sha256: "27cd6c432c7672cb812a92f611cf3ba7bbc35928262bb1e1253ff4ee6ae35901",
        family: Family::Harmony,
        context_tokens: 32_768,
        projector: None,
    },
    CatalogEntry {
        id: "qwen3:30b",
        tier: "Nova 5.5",
        base_model: "Qwen3 30B-A3B",
        license: "Apache-2.0",
        license_url: "https://www.apache.org/licenses/LICENSE-2.0",
        source_repo: "Qwen/Qwen3-30B-A3B-GGUF",
        download_gb: 18.6,
        min_memory_gb: 32,
        vision: false,
        summary: "The most capable on-device option, for machines with 32 GB of memory or more.",
        revision: "e4d4bafdfb96a411a163846265362aceb0b9c63a",
        file_name: "Qwen3-30B-A3B-Q4_K_M.gguf",
        size_bytes: 18_556_685_824,
        sha256: "0d003f6662faee786ed5da3e31b29c978de5ae5d275c8794c606a7f3c01aa8f5",
        family: Family::Qwen3,
        context_tokens: 16_384,
        projector: None,
    },
    CatalogEntry {
        id: "qwen3-vl:8b",
        tier: "Nebula Vision 4.2",
        base_model: "Qwen3-VL 8B Instruct",
        license: "Apache-2.0",
        license_url: "https://www.apache.org/licenses/LICENSE-2.0",
        source_repo: "Qwen/Qwen3-VL-8B-Instruct-GGUF",
        // Model 5.03 GB + image projector 0.75 GB.
        download_gb: 5.8,
        min_memory_gb: 16,
        vision: true,
        summary: "Sees your screen, so it can use apps for you without the cloud. Needs 16 GB of memory or more.",
        revision: "f982a07559d4a2f6c8744d840bf6fccab30eea96",
        file_name: "Qwen3VL-8B-Instruct-Q4_K_M.gguf",
        size_bytes: 5_027_784_800,
        sha256: "67d1659bfe71b89d50b45a4ad1a9e5b997e5bb16ce5da66a6a6167abd569e9e2",
        family: Family::Qwen3Vl,
        // A screenshot is about 1,000 tokens and the prompt keeps the latest two, next to the
        // system prompt and every tool. 24k tokens of KV cache is about 3.6 GB at f16 (36 layers,
        // 8 KV heads of 128), so weights, projector and cache stay near 10 GB on a 16 GB computer.
        context_tokens: 24_576,
        projector: Some(Projector {
            file_name: "mmproj-Qwen3VL-8B-Instruct-Q8_0.gguf",
            size_bytes: 752_289_728,
            sha256: "c6ba85508d82f42590e6eb77d5340369ab6fecf107a7561d809523d8aa5f3bfd",
        }),
    },
];

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalModel {
    #[serde(flatten)]
    pub entry: CatalogEntry,
    /// "Nebula 4.2".
    pub display_name: String,
    pub installed: bool,
    /// Bytes of an unfinished download that the next download continues from (0 if none).
    pub partial_bytes: u64,
    pub fits: bool,
    pub selected: bool,
    /// The cheapest plan that includes this model, when the current plan doesn't ("lite").
    pub required_plan: Option<&'static str>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalStatus {
    pub brand: &'static str,
    /// The engine is built into Lumo, so it is always available.
    pub engine: &'static str,
    /// What runs the models: "Metal", "Vulkan" or "CPU".
    pub accelerator: String,
    pub memory_gb: u32,
    pub models: Vec<LocalModel>,
}

pub fn memory_gb() -> u32 {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    (sys.total_memory() as f64 / 1_073_741_824.0).round() as u32
}

pub fn catalog_entry(id: &str) -> Result<&'static CatalogEntry> {
    CATALOG.iter().find(|e| same_tag(e.id, id)).ok_or_else(|| invalid(format!("'{id}' is not one of Lumo's on-device models")))
}

/// Id equality that treats "name" and "name:latest" as the same model (ids saved by older versions).
pub fn same_tag(a: &str, b: &str) -> bool {
    let norm = |s: &str| if s.contains(':') { s.to_string() } else { format!("{s}:latest") };
    norm(a) == norm(b)
}

pub fn models_dir(core: &Core) -> PathBuf {
    core.paths.data_dir.join("models")
}

/// Where a catalog model lives once downloaded. Core-only: never sent to the webview.
pub fn model_path(core: &Core, e: &CatalogEntry) -> PathBuf {
    models_dir(core).join(e.file_name)
}

/// Where a vision model's projector lives: next to the model, where the engine looks for it.
pub fn projector_path(core: &Core, e: &CatalogEntry) -> Option<PathBuf> {
    e.projector.map(|p| models_dir(core).join(p.file_name))
}

fn file_path(core: &Core, f: &PinnedFile) -> PathBuf {
    models_dir(core).join(f.file_name)
}

fn partial_path(core: &Core, f: &PinnedFile) -> PathBuf {
    models_dir(core).join(format!("{}.part", f.file_name))
}

fn file_complete(core: &Core, f: &PinnedFile) -> bool {
    std::fs::metadata(file_path(core, f)).map(|m| m.is_file() && m.len() == f.size_bytes).unwrap_or(false)
}

/// Every file of the entry is in place (a vision model needs its projector too).
pub fn is_installed(core: &Core, e: &CatalogEntry) -> bool {
    e.files().iter().all(|f| file_complete(core, f))
}

/// Bytes already on disk toward an unfinished download: finished files and partial ones.
fn downloaded_bytes(core: &Core, e: &CatalogEntry) -> u64 {
    if is_installed(core, e) {
        return 0;
    }
    e.files()
        .iter()
        .map(|f| if file_complete(core, f) { f.size_bytes } else { std::fs::metadata(partial_path(core, f)).map(|m| m.len()).unwrap_or(0) })
        .sum()
}

/// Compiled-in GPU support, for status; the engine falls back to the CPU at run time.
fn accelerator() -> String {
    static ACCEL: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    ACCEL.get_or_init(crate::model::local::engine::accelerator).clone()
}

pub async fn status(core: &Core) -> LocalStatus {
    let accel = tokio::task::spawn_blocking(accelerator).await.unwrap_or_else(|_| "CPU".into());
    status_with(core, memory_gb(), accel)
}

pub fn status_with(core: &Core, memory_gb: u32, accelerator: String) -> LocalStatus {
    let s = core.settings();
    let models = CATALOG
        .iter()
        .map(|e| LocalModel {
            entry: e.clone(),
            display_name: e.tier.to_string(),
            installed: is_installed(core, e),
            partial_bytes: downloaded_bytes(core, e),
            fits: memory_gb == 0 || memory_gb >= e.min_memory_gb,
            selected: s.provider == "local" && same_tag(&s.local_model, e.id),
            required_plan: crate::plans::required_plan(core, e.id),
        })
        .collect();
    LocalStatus { brand: BRAND, engine: "llama.cpp", accelerator, memory_gb, models }
}

fn download_host(core: &Core) -> String {
    core.endpoints.lock().model_downloads.clone()
}

/// The client for model files: https only, including every redirect (Hugging Face redirects to its
/// storage CDN), and a stall timeout instead of a total one, since files are many gigabytes.
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

/// Download a catalog model into the app's data folder, broadcasting `local-model-progress` events
/// ({model, status, completed, total, done}). An interrupted or cancelled download continues where
/// it stopped next time. Each file is only moved into place after its size and SHA-256 match the
/// catalog. Progress covers all of the entry's files (a vision model's projector too).
pub async fn pull(core: &Core, id: &str, cancel: tokio_util::sync::CancellationToken) -> Result<()> {
    let entry = catalog_entry(id)?;
    let emit = |status: &str, completed: u64, total: u64, done: bool| {
        core.platform.broadcast(
            "local-model-progress",
            json!({"model": entry.id, "status": status, "completed": completed, "total": total, "done": done}),
        );
    };
    let res = download(core, entry, &cancel, &emit).await;
    match &res {
        Ok(()) => {
            emit("success", entry.total_bytes(), entry.total_bytes(), true);
            crate::audit::record(&core.db, "user", "local_model_download", Some(entry.id), None, "ok");
        }
        Err(LumoError::Cancelled) => emit("cancelled", 0, 0, true),
        Err(_) => emit("failed", 0, 0, true),
    }
    res
}

async fn download(
    core: &Core,
    entry: &CatalogEntry,
    cancel: &tokio_util::sync::CancellationToken,
    emit: &(dyn Fn(&str, u64, u64, bool) + Sync),
) -> Result<()> {
    if is_installed(core, entry) {
        return Ok(());
    }
    tokio::fs::create_dir_all(models_dir(core)).await?;
    let total = entry.total_bytes();
    let mut before = 0;
    for f in entry.files() {
        if !file_complete(core, &f) {
            download_file(core, entry, &f, before, total, cancel, emit).await?;
        }
        before += f.size_bytes;
    }
    Ok(())
}

/// Download one pinned file. Progress is reported for the whole entry: `before` bytes of earlier
/// files are done, out of `total`.
async fn download_file(
    core: &Core,
    entry: &CatalogEntry,
    f: &PinnedFile,
    before: u64,
    total: u64,
    cancel: &tokio_util::sync::CancellationToken,
    emit: &(dyn Fn(&str, u64, u64, bool) + Sync),
) -> Result<()> {
    let part = partial_path(core, f);
    let size = f.size_bytes;

    // Hash what an earlier attempt already saved, so the check covers the whole file.
    let mut hasher = Sha256::new();
    let mut have = tokio::fs::metadata(&part).await.map(|m| m.len()).unwrap_or(0);
    if have > size {
        tokio::fs::remove_file(&part).await?;
        have = 0;
    }
    if have > 0 {
        emit("checking", 0, 0, false);
        let mut file = tokio::fs::File::open(&part).await?;
        let mut buf = vec![0u8; 1 << 20];
        loop {
            if cancel.is_cancelled() {
                return Err(LumoError::Cancelled);
            }
            let n = file.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
    }

    let mut req = download_client()?.get(entry.file_url(&download_host(core), f.file_name));
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
    emit("downloading", before + done, total, false);
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
        if done + chunk.len() as u64 > size {
            drop(file);
            let _ = tokio::fs::remove_file(&part).await;
            return Err(LumoError::Unavailable("The download was larger than expected, so it was discarded.".into()));
        }
        hasher.update(&chunk);
        file.write_all(&chunk).await?;
        done += chunk.len() as u64;
        if last.elapsed() >= Duration::from_millis(250) {
            last = Instant::now();
            emit("downloading", before + done, total, false);
        }
    }
    file.flush().await?;
    file.sync_all().await?;
    drop(file);
    if done < size {
        return Err(LumoError::Unavailable("The download stopped before it finished. Download again to continue where it stopped.".into()));
    }
    emit("verifying", before + size, total, false);
    let digest = hex::encode(hasher.finalize());
    if digest != f.sha256 {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(LumoError::Unavailable("The downloaded file didn't match the expected checksum, so it was deleted. Try again.".into()));
    }
    tokio::fs::rename(&part, file_path(core, f)).await?;
    Ok(())
}

pub async fn delete(core: &Core, id: &str) -> Result<()> {
    let entry = catalog_entry(id)?;
    let engine = core.local_engine.clone();
    tokio::task::spawn_blocking(move || engine.unload_and_wait(Duration::from_secs(30))).await.ok();
    for p in entry.files().iter().flat_map(|f| [file_path(core, f), partial_path(core, f)]) {
        match tokio::fs::remove_file(&p).await {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                return Err(LumoError::Unavailable(format!("Couldn't remove the model file ({e}). Try again after quitting other apps.")))
            }
        }
    }
    crate::audit::record(&core.db, "user", "local_model_delete", Some(entry.id), None, "ok");
    Ok(())
}

/// Switch Lumo to a downloaded on-device model.
pub async fn select(core: &Core, id: &str) -> Result<()> {
    let entry = catalog_entry(id)?;
    crate::plans::check_model(crate::plans::current(core), "local", entry.id)?;
    if !is_installed(core, entry) {
        return Err(invalid("Download this model before choosing it."));
    }
    let mut s = core.settings();
    if s.local_model != entry.id {
        // Free the memory of the model in use; the new one loads on the next request.
        core.local_engine.unload();
    }
    s.provider = "local".into();
    s.local_model = entry.id.to_string();
    crate::settings::save(&core.db, &s)?;
    core.platform.broadcast("settings-changed", json!({}));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::testing::{core_with, FakePlatform};
    use std::sync::Arc;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn sha(body: &[u8]) -> &'static str {
        Box::leak(hex::encode(Sha256::digest(body)).into_boxed_str())
    }

    /// A catalog entry for a tiny stand-in file, at the same address as the real one.
    fn fake(entry: &'static CatalogEntry, body: &[u8]) -> &'static CatalogEntry {
        let e = CatalogEntry { size_bytes: body.len() as u64, sha256: sha(body), ..entry.clone() };
        Box::leak(Box::new(e))
    }

    /// The model file of an entry, as a pinned file.
    fn main_file(e: &CatalogEntry) -> PinnedFile {
        e.files()[0]
    }

    #[test]
    fn catalog_downloads_are_pinned_https_files() {
        for e in CATALOG {
            let url = url::Url::parse(&e.url(DOWNLOAD_HOST)).unwrap();
            assert_eq!((url.scheme(), url.host_str()), ("https", Some("huggingface.co")));
            assert!(url.path().contains(&format!("/resolve/{}/", e.revision)), "{url}");
            assert_eq!(e.revision.len(), 40);
            assert_eq!(e.sha256.len(), 64);
            assert!(e.sha256.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
            for f in e.files() {
                assert_eq!(f.sha256.len(), 64);
                assert!(f.sha256.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
                assert!(f.file_name.ends_with(".gguf") && !f.file_name.contains('/'));
                let url = url::Url::parse(&e.file_url(DOWNLOAD_HOST, f.file_name)).unwrap();
                assert!(url.path().starts_with(&format!("/{}/resolve/{}/", e.source_repo, e.revision)), "{url}");
            }
            assert!((e.total_bytes() as f64 / 1e9 - e.download_gb as f64).abs() < 0.1, "{}", e.id);
            // Vision models, and only they, carry an image projector; the format must match.
            assert_eq!(e.vision, e.projector.is_some(), "{}", e.id);
            assert_eq!(e.vision, e.family.sees_images(), "{}", e.id);
            assert_eq!(e.license, "Apache-2.0");
        }
        let names: Vec<_> = CATALOG.iter().map(|e| e.tier).collect();
        assert_eq!(names, ["Orbit 3.8", "Nebula 4.2", "Solar 5.4", "Nova 5.5", "Nebula Vision 4.2"]);
    }

    #[test]
    fn the_vision_model_is_pinned_with_its_projector() {
        let e = catalog_entry("qwen3-vl:8b").unwrap();
        assert!(e.vision && e.min_memory_gb == 16 && e.context_tokens > 16_384);
        assert_eq!(e.source_repo, "Qwen/Qwen3-VL-8B-Instruct-GGUF");
        assert_eq!(e.revision, "f982a07559d4a2f6c8744d840bf6fccab30eea96");
        let files = e.files();
        assert_eq!(
            files,
            [
                PinnedFile {
                    file_name: "Qwen3VL-8B-Instruct-Q4_K_M.gguf",
                    size_bytes: 5_027_784_800,
                    sha256: "67d1659bfe71b89d50b45a4ad1a9e5b997e5bb16ce5da66a6a6167abd569e9e2",
                },
                PinnedFile {
                    file_name: "mmproj-Qwen3VL-8B-Instruct-Q8_0.gguf",
                    size_bytes: 752_289_728,
                    sha256: "c6ba85508d82f42590e6eb77d5340369ab6fecf107a7561d809523d8aa5f3bfd",
                },
            ]
        );
        assert_eq!(e.total_bytes(), 5_780_074_528);
        // Text-only models have just the one file.
        assert_eq!(catalog_entry("qwen3:8b").unwrap().files().len(), 1);
        assert!(CATALOG.iter().filter(|e| e.vision).count() == 1);
    }

    async fn serve(server: &MockServer, entry: &CatalogEntry, body: Vec<u8>) {
        serve_file(server, entry, entry.file_name, body).await
    }

    async fn serve_file(server: &MockServer, entry: &CatalogEntry, file_name: &str, body: Vec<u8>) {
        let p = format!("/{}/resolve/{}/{}", entry.source_repo, entry.revision, file_name);
        Mock::given(method("GET"))
            .and(path(p.clone()))
            .and(header("range", "bytes=3-"))
            .respond_with(ResponseTemplate::new(206).set_body_bytes(body[3..].to_vec()))
            .with_priority(1)
            .mount(server)
            .await;
        Mock::given(method("GET"))
            .and(path(p))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(body))
            .with_priority(2)
            .mount(server)
            .await;
    }

    #[tokio::test]
    async fn downloads_verifies_selects_and_deletes() {
        let server = MockServer::start().await;
        let platform = Arc::new(FakePlatform::default());
        let (core, _dir) = core_with(platform.clone());
        core.endpoints.lock().model_downloads = server.uri();
        let body = b"GGUF fake model bytes".to_vec();
        let real = catalog_entry("qwen3:8b").unwrap();
        let e = fake(real, &body);
        serve(&server, e, body.clone()).await;

        let st = status_with(&core, 16, "CPU".into());
        assert_eq!((st.engine, st.accelerator.as_str()), ("llama.cpp", "CPU"));
        let m = st.models.iter().find(|m| m.entry.id == "qwen3:8b").unwrap();
        assert!(!m.installed && m.fits && !m.selected);
        assert_eq!(m.display_name, "Nebula 4.2");
        assert!(!st.models.iter().find(|m| m.entry.id == "qwen3:30b").unwrap().fits);
        // Paths never reach the webview.
        let json = serde_json::to_string(&st).unwrap();
        assert!(!json.contains(".gguf") && !json.contains(&core.paths.data_dir.display().to_string()), "{json}");

        // Choosing needs the download first.
        assert!(select(&core, "qwen3:8b").await.is_err());

        download(&core, e, &Default::default(), &|_, _, _, _| {}).await.unwrap();
        assert_eq!(std::fs::read(model_path(&core, e)).unwrap(), body);
        assert!(!partial_path(&core, &main_file(e)).exists());

        // Delete removes the file.
        std::fs::write(model_path(&core, real), b"x").unwrap();
        delete(&core, "qwen3:8b").await.unwrap();
        assert!(!model_path(&core, real).exists());
        assert!(pull(&core, "some/other-model", Default::default()).await.is_err());
    }

    #[tokio::test]
    async fn resumes_and_rejects_a_bad_checksum() {
        let server = MockServer::start().await;
        let (core, _dir) = core_with(Arc::new(FakePlatform::default()));
        core.endpoints.lock().model_downloads = server.uri();
        let body = b"0123456789abcdef".to_vec();
        let e = fake(catalog_entry("qwen3:4b").unwrap(), &body);
        serve(&server, e, body.clone()).await;

        // An earlier attempt left the first 3 bytes; the rest comes from a range request.
        std::fs::create_dir_all(models_dir(&core)).unwrap();
        std::fs::write(partial_path(&core, &main_file(e)), &body[..3]).unwrap();
        let events = parking_lot::Mutex::new(Vec::new());
        download(&core, e, &Default::default(), &|s, c, t, _| events.lock().push((s.to_string(), c, t))).await.unwrap();
        assert_eq!(std::fs::read(model_path(&core, e)).unwrap(), body);
        assert!(events.lock().iter().any(|(s, c, t)| s == "downloading" && *c == 3 && *t == 16));
        assert!(events.lock().iter().any(|(s, _, _)| s == "verifying"));

        // A file that doesn't match the catalog checksum is never moved into place.
        std::fs::remove_file(model_path(&core, e)).unwrap();
        let wrong = Box::leak(Box::new(CatalogEntry { sha256: "00", ..e.clone() }));
        let err = download(&core, wrong, &Default::default(), &|_, _, _, _| {}).await.unwrap_err().to_string();
        assert!(err.contains("checksum"), "{err}");
        assert!(!model_path(&core, e).exists() && !partial_path(&core, &main_file(e)).exists());

        // Cancelling keeps the partial file for later.
        let cancel = tokio_util::sync::CancellationToken::new();
        cancel.cancel();
        assert!(matches!(download(&core, e, &cancel, &|_, _, _, _| {}).await, Err(LumoError::Cancelled)));
    }

    #[tokio::test]
    async fn pull_broadcasts_progress_and_success() {
        let server = MockServer::start().await;
        let platform = Arc::new(FakePlatform::default());
        let (core, _dir) = core_with(platform.clone());
        core.endpoints.lock().model_downloads = server.uri();
        // A wrong file for the real catalog entry: the size check fails, and pull says so.
        let real = catalog_entry("qwen3:4b").unwrap();
        serve(&server, real, b"not the model".to_vec()).await;
        assert!(pull(&core, "qwen3:4b", Default::default()).await.is_err());
        let events = platform.broadcasts.lock().clone();
        assert!(events.iter().any(|(e, p)| e == "local-model-progress" && p["status"] == "downloading" && p["total"] == real.size_bytes));
        assert!(events.iter().any(|(_, p)| p["status"] == "failed" && p["done"] == true));
        assert!(!is_installed(&core, real));
    }

    #[tokio::test]
    async fn a_vision_model_downloads_verifies_and_deletes_both_files() {
        let server = MockServer::start().await;
        let (core, _dir) = core_with(Arc::new(FakePlatform::default()));
        core.endpoints.lock().model_downloads = server.uri();
        let real = catalog_entry("qwen3-vl:8b").unwrap();
        let model = b"GGUF fake vision model".to_vec();
        let proj = b"GGUF fake projector".to_vec();
        let p = real.projector.unwrap();
        let e: &'static CatalogEntry = Box::leak(Box::new(CatalogEntry {
            size_bytes: model.len() as u64,
            sha256: sha(&model),
            projector: Some(Projector { size_bytes: proj.len() as u64, sha256: sha(&proj), ..p }),
            ..real.clone()
        }));
        serve(&server, e, model.clone()).await;
        serve_file(&server, e, p.file_name, proj.clone()).await;
        let total = (model.len() + proj.len()) as u64;

        // An interrupted download of the model (3 bytes) continues; progress covers both files.
        std::fs::create_dir_all(models_dir(&core)).unwrap();
        std::fs::write(partial_path(&core, &main_file(e)), &model[..3]).unwrap();
        assert_eq!(downloaded_bytes(&core, e), 3);
        let events = parking_lot::Mutex::new(Vec::new());
        download(&core, e, &Default::default(), &|s, c, t, _| events.lock().push((s.to_string(), c, t))).await.unwrap();
        assert_eq!(std::fs::read(model_path(&core, e)).unwrap(), model);
        assert_eq!(std::fs::read(projector_path(&core, e).unwrap()).unwrap(), proj);
        assert!(is_installed(&core, e));
        let ev = events.lock().clone();
        assert!(ev.iter().all(|(s, _, t)| s == "checking" || *t == total), "{ev:?}");
        assert!(ev.iter().any(|(s, c, _)| s == "downloading" && *c == 3));
        // The projector's progress starts after the model's bytes.
        assert!(ev.iter().any(|(s, c, _)| s == "downloading" && *c == model.len() as u64));
        assert!(ev.iter().any(|(s, c, _)| s == "verifying" && *c == total));

        // Without its projector the model is not installed, and only the projector is fetched again.
        std::fs::remove_file(projector_path(&core, e).unwrap()).unwrap();
        assert!(!is_installed(&core, e));
        assert_eq!(downloaded_bytes(&core, e), model.len() as u64);
        let events = parking_lot::Mutex::new(Vec::new());
        download(&core, e, &Default::default(), &|s, c, t, _| events.lock().push((s.to_string(), c, t))).await.unwrap();
        assert!(is_installed(&core, e));
        assert!(events.lock().iter().filter(|(s, _, _)| s == "downloading").all(|(_, c, _)| *c >= model.len() as u64));

        // A projector that doesn't match its checksum is never moved into place.
        std::fs::remove_file(projector_path(&core, e).unwrap()).unwrap();
        let bad: &'static CatalogEntry =
            Box::leak(Box::new(CatalogEntry { projector: Some(Projector { sha256: sha(b"other"), ..e.projector.unwrap() }), ..e.clone() }));
        let err = download(&core, bad, &Default::default(), &|_, _, _, _| {}).await.unwrap_err().to_string();
        assert!(err.contains("checksum"), "{err}");
        assert!(!projector_path(&core, e).unwrap().exists() && !is_installed(&core, e));

        // Delete removes both files (and any partial ones) of the real entry.
        let real_files = real.files();
        for f in &real_files {
            std::fs::write(file_path(&core, f), b"x").unwrap();
            std::fs::write(partial_path(&core, f), b"x").unwrap();
        }
        delete(&core, "qwen3-vl:8b").await.unwrap();
        for f in &real_files {
            assert!(!file_path(&core, f).exists() && !partial_path(&core, f).exists(), "{}", f.file_name);
        }
    }

    #[tokio::test]
    async fn selecting_an_installed_model_uses_the_built_in_engine() {
        let (core, _dir) = core_with(Arc::new(FakePlatform::default()));
        let e = catalog_entry("qwen3:4b").unwrap();
        std::fs::create_dir_all(models_dir(&core)).unwrap();
        // Selection only checks the file is complete; a sparse file of the right size will do.
        let f = std::fs::File::create(model_path(&core, e)).unwrap();
        f.set_len(e.size_bytes).unwrap();
        select(&core, "qwen3:4b").await.unwrap();
        let s = core.settings();
        assert_eq!((s.provider.as_str(), s.local_model.as_str()), ("local", "qwen3:4b"));
        assert_eq!(core.provider().unwrap().name(), "local");
        assert!(status_with(&core, 16, "CPU".into()).models.iter().any(|m| m.selected && m.installed));
    }
}
