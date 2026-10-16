//! On-device speech-to-text: OpenAI's Whisper (base, multilingual, MIT licensed) run by Lumo itself,
//! so voice input is free and the recording never leaves the computer. The weights are downloaded
//! once from Hugging Face, pinned to a revision and checked against their SHA-256, like the chat
//! models in `local_models`. The webview decodes the recording to 16 kHz PCM, which works the same
//! on every platform Lumo runs on.

pub mod whisper;

use crate::core::Core;
use crate::error::{invalid, LumoError, Result};
use crate::local_models::{download_host, download_pinned, PinnedFile};
use base64::Engine as _;
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::json;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const REPO: &str = "openai/whisper-base";
pub const REVISION: &str = "e37978b90ca9030d5170a5c07aadb050351a65bb";
pub const LICENSE: &str = "MIT";

pub struct ModelFile {
    pub name: &'static str,
    pub size_bytes: u64,
    pub sha256: &'static str,
}

/// The files Lumo downloads, pinned by size and SHA-256 (checked in CI by check_model_pins.py).
pub const FILES: &[ModelFile] = &[
    ModelFile { name: "config.json", size_bytes: 1_983, sha256: "a153c53883a6799b6f056b4a8d1a515c9926d03994682ba88a7616618d7da0c1" },
    ModelFile { name: "tokenizer.json", size_bytes: 2_480_466, sha256: "27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566" },
    ModelFile {
        name: "model.safetensors",
        size_bytes: 290_403_936,
        sha256: "07cadb9f25677c8d50df603e66a98fbd842cce45047139baeb16e6219a1e807b",
    },
];

/// Free the model's memory after this long without use.
const IDLE_UNLOAD: Duration = Duration::from_secs(10 * 60);

pub fn dir(core: &Core) -> PathBuf {
    crate::local_models::models_dir(core).join("whisper-base")
}

pub fn total_bytes() -> u64 {
    FILES.iter().map(|f| f.size_bytes).sum()
}

pub fn is_installed(core: &Core) -> bool {
    let d = dir(core);
    FILES.iter().all(|f| std::fs::metadata(d.join(f.name)).map(|m| m.is_file() && m.len() == f.size_bytes).unwrap_or(false))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechModelStatus {
    pub installed: bool,
    pub downloading: bool,
    pub size_bytes: u64,
    pub name: &'static str,
    pub license: &'static str,
}

static DOWNLOADING: Mutex<Option<tokio_util::sync::CancellationToken>> = Mutex::new(None);

pub fn status(core: &Core) -> SpeechModelStatus {
    SpeechModelStatus {
        installed: is_installed(core),
        downloading: DOWNLOADING.lock().is_some(),
        size_bytes: total_bytes(),
        name: "Whisper base (OpenAI)",
        license: LICENSE,
    }
}

/// Download the speech model, broadcasting `speech-model-progress` ({status, completed, total, done}).
pub async fn pull(core: &Core) -> Result<()> {
    let cancel = {
        let mut slot = DOWNLOADING.lock();
        if slot.is_some() {
            return Err(invalid("The speech model is already downloading"));
        }
        let t = tokio_util::sync::CancellationToken::new();
        *slot = Some(t.clone());
        t
    };
    let res = pull_files(core, &cancel).await;
    *DOWNLOADING.lock() = None;
    let total = total_bytes();
    let emit_end = |status: &str| {
        core.platform.broadcast("speech-model-progress", json!({"status": status, "completed": total, "total": total, "done": true}))
    };
    match &res {
        Ok(()) => {
            emit_end("success");
            crate::audit::record(&core.db, "user", "speech_model_download", Some(REPO), None, "ok");
        }
        Err(LumoError::Cancelled) => emit_end("cancelled"),
        Err(_) => emit_end("failed"),
    }
    res
}

async fn pull_files(core: &Core, cancel: &tokio_util::sync::CancellationToken) -> Result<()> {
    let d = dir(core);
    let host = download_host(core);
    let total = total_bytes();
    let mut before = 0u64;
    for f in FILES {
        let base = before;
        let emit = |status: &str, completed: u64, _t: u64, _done: bool| {
            core.platform.broadcast(
                "speech-model-progress",
                json!({"status": status, "completed": base + completed, "total": total, "done": false}),
            );
        };
        let dest = d.join(f.name);
        if !std::fs::metadata(&dest).map(|m| m.len() == f.size_bytes).unwrap_or(false) {
            let pinned = PinnedFile {
                url: format!("{}/{REPO}/resolve/{REVISION}/{}", host.trim_end_matches('/'), f.name),
                part: d.join(format!("{}.part", f.name)),
                dest,
                size: f.size_bytes,
                sha256: f.sha256,
            };
            download_pinned(&pinned, cancel, &emit).await?;
        }
        before += f.size_bytes;
    }
    Ok(())
}

pub fn cancel_download() {
    if let Some(t) = DOWNLOADING.lock().as_ref() {
        t.cancel();
    }
}

pub async fn delete(core: &Core) -> Result<()> {
    unload();
    let d = dir(core);
    match tokio::fs::remove_dir_all(&d).await {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(LumoError::Unavailable(format!("Couldn't remove the speech model ({e}). Try again."))),
    }
    crate::audit::record(&core.db, "user", "speech_model_delete", Some(REPO), None, "ok");
    Ok(())
}

/// The loaded model, kept for a while after use so back-to-back requests are quick.
struct Loaded {
    model: Arc<Mutex<whisper::Whisper>>,
    last_used: Instant,
}
static LOADED: Mutex<Option<Loaded>> = Mutex::new(None);

fn unload() {
    *LOADED.lock() = None;
}

fn loaded(core: &Core) -> Result<Arc<Mutex<whisper::Whisper>>> {
    let mut slot = LOADED.lock();
    if let Some(l) = slot.as_mut() {
        l.last_used = Instant::now();
        return Ok(l.model.clone());
    }
    let model = Arc::new(Mutex::new(whisper::Whisper::load(&dir(core))?));
    *slot = Some(Loaded { model: model.clone(), last_used: Instant::now() });
    Ok(model)
}

fn unload_if_idle() {
    let mut slot = LOADED.lock();
    if slot.as_ref().is_some_and(|l| l.last_used.elapsed() >= IDLE_UNLOAD) {
        *slot = None;
    }
}

/// Transcribe a recording the webview decoded to mono 16 kHz, 16-bit little-endian PCM.
/// `lang` is the app's language (like "en"), used when the spoken language is unclear.
pub async fn transcribe(core: &Arc<Core>, pcm_b64: &str, lang: Option<String>) -> Result<String> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(pcm_b64).map_err(|_| invalid("the recording could not be read"))?;
    if bytes.len() < 2 {
        return Err(invalid("the recording is empty"));
    }
    if bytes.len() > whisper::MAX_SECONDS * 16_000 * 2 + 2 {
        return Err(invalid(format!("the recording is longer than {} seconds", whisper::MAX_SECONDS)));
    }
    if !is_installed(core) {
        return Err(LumoError::NotFound("Lumo's speech model".into()));
    }
    let pcm = whisper::pcm_from_i16_le(&bytes);
    let lang = lang.map(|l| l.chars().take_while(|c| c.is_ascii_alphabetic()).collect::<String>().to_lowercase());
    let core2 = core.clone();
    let text = tokio::task::spawn_blocking(move || -> Result<String> {
        let model = loaded(&core2)?;
        let mut m = model.lock();
        m.transcribe(&pcm, lang.as_deref())
    })
    .await
    .map_err(|e| LumoError::Unavailable(format!("On-device speech recognition stopped: {e}")))??;
    tokio::spawn(async {
        tokio::time::sleep(IDLE_UNLOAD + Duration::from_secs(1)).await;
        unload_if_idle();
    });
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::testing::{core_with, FakePlatform};

    #[test]
    fn files_are_pinned() {
        for f in FILES {
            assert_eq!(f.sha256.len(), 64);
            assert!(f.size_bytes > 0);
        }
        assert_eq!(REVISION.len(), 40);
    }

    #[tokio::test]
    async fn transcribing_without_the_model_says_so() {
        let (core, _d) = core_with(Arc::new(FakePlatform::default()));
        assert!(!status(&core).installed);
        let pcm = base64::engine::general_purpose::STANDARD.encode([0u8; 3200]);
        assert!(matches!(transcribe(&core, &pcm, None).await, Err(LumoError::NotFound(_))));
        assert!(matches!(transcribe(&core, "", None).await, Err(LumoError::Invalid(_))));
    }

    #[tokio::test]
    async fn downloads_each_file_against_its_pin() {
        use sha2::{Digest, Sha256};
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        let (core, _d) = core_with(Arc::new(FakePlatform::default()));
        core.endpoints.lock().model_downloads = server.uri();
        // The real pins can't be served here; a wrong file must be refused and leave nothing behind.
        Mock::given(method("GET"))
            .and(path(format!("/{REPO}/resolve/{REVISION}/config.json")))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(vec![b'x'; 1_983]))
            .mount(&server)
            .await;
        assert_ne!(hex::encode(Sha256::digest(vec![b'x'; 1_983])), FILES[0].sha256);
        assert!(pull(&core).await.is_err());
        assert!(!dir(&core).join("config.json").exists());
        assert!(!status(&core).downloading);
    }

    /// Real speech through the real model. CI downloads the pinned files and makes a WAV with the
    /// system's text-to-speech:
    ///   LUMO_SMOKE_WHISPER=/dir/with/files LUMO_SMOKE_WAV=speech.wav cargo test --lib smoke_whisper -- --ignored --nocapture
    #[test]
    #[ignore = "needs LUMO_SMOKE_WHISPER and LUMO_SMOKE_WAV"]
    fn smoke_whisper_transcribes_speech() {
        let (Some(dir), Some(wav)) = (std::env::var_os("LUMO_SMOKE_WHISPER"), std::env::var_os("LUMO_SMOKE_WAV")) else { return };
        let pcm = read_wav_16k(&std::fs::read(wav).unwrap());
        let t = Instant::now();
        let mut w = whisper::Whisper::load(std::path::Path::new(&dir)).unwrap();
        eprintln!("loaded in {:?}", t.elapsed());
        let t = Instant::now();
        let text = w.transcribe(&pcm, Some("en")).unwrap();
        eprintln!("transcribed {:.1}s of audio in {:?}: {text:?}", pcm.len() as f32 / 16_000.0, t.elapsed());
        let lower = text.to_lowercase();
        assert!(lower.contains("weather") && lower.contains("tomorrow"), "{text}");
        // Silence gives nothing, not made-up words.
        let silent = w.transcribe(&vec![0.0; 32_000], Some("en")).unwrap();
        assert_eq!(silent, "");
    }

    /// A 16-bit PCM WAV, mixed to mono and resampled (linearly) to 16 kHz.
    fn read_wav_16k(b: &[u8]) -> Vec<f32> {
        let mut i = 12;
        let (mut channels, mut rate, mut bits) = (1usize, 16_000usize, 16u16);
        while i + 8 <= b.len() {
            let id = &b[i..i + 4];
            let len = u32::from_le_bytes(b[i + 4..i + 8].try_into().unwrap()) as usize;
            let body = &b[i + 8..(i + 8 + len).min(b.len())];
            if id == b"fmt " {
                channels = u16::from_le_bytes([body[2], body[3]]) as usize;
                rate = u32::from_le_bytes(body[4..8].try_into().unwrap()) as usize;
                bits = u16::from_le_bytes([body[14], body[15]]);
            } else if id == b"data" {
                assert_eq!(bits, 16, "only 16-bit WAV");
                let mono: Vec<f32> =
                    whisper::pcm_from_i16_le(body).chunks(channels).map(|c| c.iter().sum::<f32>() / channels as f32).collect();
                let ratio = rate as f64 / 16_000.0;
                return (0..(mono.len() as f64 / ratio) as usize)
                    .map(|k| {
                        let x = k as f64 * ratio;
                        let j = x as usize;
                        let f = (x - j as f64) as f32;
                        mono[j] * (1.0 - f) + mono.get(j + 1).copied().unwrap_or(mono[j]) * f
                    })
                    .collect();
            }
            i += 8 + len + (len & 1);
        }
        panic!("no data chunk");
    }
}
