//! User settings (non-secret). Stored as one JSON document so new fields get defaults automatically.

use crate::db::Db;
use crate::error::{invalid, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub onboarded: bool,
    pub user_name: Option<String>,
    /// "system", "dark" or "light".
    pub theme: String,
    /// "anthropic", "openai_compatible" or "local" (on-device models through a local runtime).
    pub provider: String,
    pub model: String,
    /// "low", "medium", "high" or "xhigh".
    pub effort: String,
    pub anthropic_base_url: String,
    pub openai_base_url: String,
    pub openai_model: String,
    /// The on-device model runtime (Ollama). Must be on this machine.
    pub local_base_url: String,
    /// Runtime tag of the chosen on-device model; empty until one is downloaded and chosen.
    pub local_model: String,
    /// Long-term memory is off until the user turns it on.
    pub memory_enabled: bool,
    pub web_search_enabled: bool,
    pub global_shortcut: String,
    pub close_to_tray: bool,
    /// Delete conversations (and their runs) older than this many days. None keeps everything.
    pub retention_days: Option<u32>,
    pub location: Option<Location>,
    pub automations_paused: bool,
    pub max_tool_calls_per_run: u32,
    pub stt_base_url: String,
    pub stt_model: String,
    pub tts_enabled: bool,
    pub mascot_enabled: bool,
    pub reduced_motion: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Location {
    /// What the user typed (e.g. a street address or neighborhood).
    pub label: String,
    pub lat: f64,
    pub lon: f64,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            onboarded: false,
            user_name: None,
            theme: "system".into(),
            provider: "anthropic".into(),
            model: "claude-opus-5-5".into(),
            effort: "medium".into(),
            anthropic_base_url: "https://api.anthropic.com".into(),
            openai_base_url: "http://localhost:11434/v1".into(),
            openai_model: "llama3.1".into(),
            local_base_url: "http://127.0.0.1:11434".into(),
            local_model: String::new(),
            memory_enabled: false,
            web_search_enabled: true,
            global_shortcut: "Alt+Space".into(),
            close_to_tray: true,
            retention_days: None,
            location: None,
            automations_paused: false,
            max_tool_calls_per_run: 40,
            stt_base_url: "https://api.openai.com/v1".into(),
            stt_model: "whisper-1".into(),
            tts_enabled: false,
            mascot_enabled: true,
            reduced_motion: false,
        }
    }
}

pub const MODELS: &[(&str, &str)] =
    &[("claude-opus-5-5", "Claude Opus 5.5"), ("claude-sonnet-5-5", "Claude Sonnet 5.5"), ("claude-haiku-5-5", "Claude Haiku 5.5")];

impl Settings {
    pub fn validate(&self) -> Result<()> {
        if !["system", "dark", "light"].contains(&self.theme.as_str()) {
            return Err(invalid("theme must be system, dark or light"));
        }
        if !["anthropic", "openai_compatible", "local"].contains(&self.provider.as_str()) {
            return Err(invalid("unknown provider"));
        }
        if !["low", "medium", "high", "xhigh"].contains(&self.effort.as_str()) {
            return Err(invalid("effort must be low, medium, high or xhigh"));
        }
        check_endpoint(&self.anthropic_base_url, false)?;
        check_endpoint(&self.openai_base_url, true)?;
        check_endpoint(&self.stt_base_url, true)?;
        check_endpoint(&self.local_base_url, true)?;
        if !is_local(&self.local_base_url) {
            return Err(invalid("the on-device model runtime must run on this computer"));
        }
        if self.model.trim().is_empty() || self.model.len() > 100 {
            return Err(invalid("model name is required"));
        }
        if !(1..=200).contains(&self.max_tool_calls_per_run) {
            return Err(invalid("max tool calls per run must be between 1 and 200"));
        }
        if let Some(l) = &self.location {
            if !(-90.0..=90.0).contains(&l.lat) || !(-180.0..=180.0).contains(&l.lon) {
                return Err(invalid("location is out of range"));
            }
        }
        Ok(())
    }
}

impl Settings {
    /// The model a new conversation uses, for the active provider.
    pub fn chat_model(&self) -> String {
        match self.provider.as_str() {
            "local" => self.local_model.clone(),
            "openai_compatible" => self.openai_model.clone(),
            _ => self.model.clone(),
        }
    }
}

fn is_local(raw: &str) -> bool {
    url::Url::parse(raw).map(|u| matches!(u.host_str(), Some("localhost") | Some("127.0.0.1") | Some("[::1]"))).unwrap_or(false)
}

/// Endpoints must be HTTPS, except plain HTTP on the local machine (for local models).
fn check_endpoint(raw: &str, allow_local_http: bool) -> Result<()> {
    let u = url::Url::parse(raw).map_err(|_| invalid(format!("'{raw}' is not a valid URL")))?;
    let local = matches!(u.host_str(), Some("localhost") | Some("127.0.0.1") | Some("[::1]"));
    match u.scheme() {
        "https" => Ok(()),
        "http" if local && (allow_local_http || cfg!(debug_assertions) || cfg!(test)) => Ok(()),
        _ => Err(invalid(format!("'{raw}' must use https (http is only allowed for localhost)"))),
    }
}

pub fn load(db: &Db) -> Result<Settings> {
    let raw: Option<String> = db.conn().query_row("SELECT value FROM settings WHERE key = 'app'", [], |r| r.get(0)).ok();
    Ok(match raw {
        Some(s) => serde_json::from_str(&s).unwrap_or_default(),
        None => Settings::default(),
    })
}

pub fn save(db: &Db, s: &Settings) -> Result<()> {
    s.validate()?;
    db.conn().execute(
        "INSERT INTO settings(key, value) VALUES ('app', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [serde_json::to_string(s)?],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_validate_and_round_trip() {
        let db = Db::memory().unwrap();
        let mut s = load(&db).unwrap();
        assert_eq!(s, Settings::default());
        s.memory_enabled = true;
        save(&db, &s).unwrap();
        assert!(load(&db).unwrap().memory_enabled);
    }

    #[test]
    fn rejects_insecure_remote_endpoints() {
        let mut s = Settings { anthropic_base_url: "http://evil.example.com".into(), ..Default::default() };
        assert!(s.validate().is_err());
        s.anthropic_base_url = "https://gateway.example.com".into();
        s.openai_base_url = "http://localhost:1234/v1".into();
        assert!(s.validate().is_ok());
    }
}
