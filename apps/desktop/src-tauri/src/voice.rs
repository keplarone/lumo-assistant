//! Speech-to-text through an OpenAI-compatible transcription endpoint (OpenAI, or a local Whisper
//! server). Audio is recorded in the webview only while the user holds the mic button or has it on,
//! and is sent only to the endpoint the user configured. Text-to-speech uses the operating system's
//! voices in the webview, so it never leaves the computer.

use crate::core::Core;
use crate::error::{invalid, LumoError, Result};
use base64::Engine;

pub async fn transcribe(core: &Core, audio_b64: &str, mime: &str) -> Result<String> {
    let s = core.settings();
    let bytes = base64::engine::general_purpose::STANDARD.decode(audio_b64).map_err(|_| invalid("the recording could not be read"))?;
    if bytes.is_empty() {
        return Err(invalid("the recording is empty"));
    }
    if bytes.len() > 25 * 1024 * 1024 {
        return Err(invalid("the recording is longer than the 25 MB limit"));
    }
    let ext = match mime.split(';').next().unwrap_or("") {
        "audio/webm" => "webm",
        "audio/ogg" => "ogg",
        "audio/mp4" | "audio/m4a" | "audio/x-m4a" => "m4a",
        "audio/wav" | "audio/x-wav" => "wav",
        "audio/mpeg" => "mp3",
        other => return Err(invalid(format!("unsupported audio format {other}"))),
    };
    let key = core.secrets.get("stt_api_key")?;
    let local =
        url::Url::parse(&s.stt_base_url).ok().and_then(|u| u.host_str().map(|h| h == "localhost" || h == "127.0.0.1")).unwrap_or(false);
    if key.is_none() && !local {
        return Err(LumoError::Unavailable(
            "Voice input needs a speech-to-text key. Add one in Settings → Voice, or point it at a local Whisper server.".into(),
        ));
    }
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(format!("speech.{ext}"))
        .mime_str(mime.split(';').next().unwrap_or(mime))
        .map_err(|e| invalid(e.to_string()))?;
    let form = reqwest::multipart::Form::new().text("model", s.stt_model.clone()).part("file", part);
    let mut req = core
        .http
        .post(format!("{}/audio/transcriptions", s.stt_base_url.trim_end_matches('/')))
        .multipart(form)
        .timeout(std::time::Duration::from_secs(60));
    if let Some(k) = key {
        req = req.bearer_auth(k);
    }
    let resp = req.send().await.map_err(|e| LumoError::Unavailable(format!("Could not reach the speech-to-text service: {e}")))?;
    let status = resp.status().as_u16();
    let body = resp.text().await?;
    if status >= 300 {
        return Err(crate::integrations::http_error("Speech-to-text", status, &body));
    }
    let v: serde_json::Value = serde_json::from_str(&body)?;
    Ok(v["text"].as_str().unwrap_or("").trim().to_string())
}

/// "Hey Lumo" samples: up to 5 recordings, each up to 200 frames of 13 MFCC values. Stored as
/// numbers, not audio.
pub fn wake_templates(core: &Core) -> Result<Vec<Vec<Vec<f32>>>> {
    let raw: Option<String> = core.db.conn().query_row("SELECT value FROM settings WHERE key = 'wake_templates'", [], |r| r.get(0)).ok();
    Ok(raw.and_then(|r| serde_json::from_str(&r).ok()).unwrap_or_default())
}

pub fn save_wake_templates(core: &Core, t: &[Vec<Vec<f32>>]) -> Result<()> {
    if t.len() > 5 || t.iter().any(|s| s.is_empty() || s.len() > 200 || s.iter().any(|f| f.len() != 13 || f.iter().any(|x| !x.is_finite())))
    {
        return Err(invalid("the voice samples are not in the expected shape"));
    }
    if t.is_empty() {
        core.db.conn().execute("DELETE FROM settings WHERE key = 'wake_templates'", [])?;
        return Ok(());
    }
    core.db.conn().execute(
        "INSERT INTO settings(key, value) VALUES ('wake_templates', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [serde_json::to_string(t)?],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::testing::{core_with, FakePlatform};
    use std::sync::Arc;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn sends_audio_and_returns_text() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/audio/transcriptions"))
            .and(header("authorization", "Bearer sk-test"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"text": " Organize my downloads. "})))
            .mount(&server)
            .await;
        let (core, _d) = core_with(Arc::new(FakePlatform::default()));
        let mut s = core.settings();
        s.stt_base_url = format!("{}/v1", server.uri());
        crate::settings::save(&core.db, &s).unwrap();
        // No key and not local: refused before anything is sent.
        let remote = crate::settings::Settings { stt_base_url: "https://api.example.com/v1".into(), ..s.clone() };
        crate::settings::save(&core.db, &remote).unwrap();
        assert!(transcribe(&core, "AAAA", "audio/webm").await.is_err());
        crate::settings::save(&core.db, &s).unwrap();
        core.secrets.set("stt_api_key", "sk-test").unwrap();
        let text =
            transcribe(&core, &base64::engine::general_purpose::STANDARD.encode(b"fake-audio"), "audio/webm;codecs=opus").await.unwrap();
        assert_eq!(text, "Organize my downloads.");
        assert!(transcribe(&core, "", "audio/webm").await.is_err());
        assert!(transcribe(&core, "AAAA", "video/mp4").await.is_err());
    }

    #[test]
    fn wake_samples_are_shape_checked() {
        let (core, _d) = core_with(Arc::new(FakePlatform::default()));
        assert!(wake_templates(&core).unwrap().is_empty());
        let one = vec![vec![0.5f32; 13]; 40];
        save_wake_templates(&core, &[one.clone(), one.clone(), one.clone()]).unwrap();
        assert_eq!(wake_templates(&core).unwrap().len(), 3);
        assert!(save_wake_templates(&core, &[vec![vec![0.5f32; 12]; 40]]).is_err());
        assert!(save_wake_templates(&core, &vec![one.clone(); 6]).is_err());
        save_wake_templates(&core, &[]).unwrap();
        assert!(wake_templates(&core).unwrap().is_empty());
    }
}
