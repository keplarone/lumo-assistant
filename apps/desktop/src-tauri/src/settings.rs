//! User settings (non-secret). Stored as one JSON document so new fields get defaults automatically.

use crate::agent::events::ActionPreview;
use crate::core::Core;
use crate::db::Db;
use crate::error::{denied, invalid, Result};
use crate::secrets::SecretStore;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub onboarded: bool,
    pub user_name: Option<String>,
    /// "system", "dark" or "light".
    pub theme: String,
    /// The OpenRouter model new conversations use, from the plan's list (models.rs), or "auto" for the
    /// plan's default. Lumo's model gateway refuses models the plan doesn't include.
    pub model: String,
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
    /// The mascot on the desktop: a small always-on-top window he flies around in.
    pub buddy_enabled: bool,
    /// The mascot's little noises.
    pub sounds_enabled: bool,
    /// Animate the tray, taskbar and Dock icons while Lumo runs.
    pub animated_icon: bool,
    /// "lumo" (personal assistant) or "linx" (Linx Code, for businesses).
    pub mode: String,
    /// "free", "lite" or "pro". Only the license check changes it; saving settings from the UI keeps it.
    pub plan: String,
    pub plan_checked_at: Option<String>,
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
            theme: "light".into(),
            model: "auto".into(),
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
            buddy_enabled: true,
            sounds_enabled: true,
            animated_icon: true,
            mode: "lumo".into(),
            plan: "free".into(),
            plan_checked_at: None,
        }
    }
}

impl Settings {
    pub fn validate(&self) -> Result<()> {
        if !["system", "dark", "light"].contains(&self.theme.as_str()) {
            return Err(invalid("theme must be system, dark or light"));
        }
        if !["lumo", "linx"].contains(&self.mode.as_str()) {
            return Err(invalid("mode must be lumo or linx"));
        }
        check_endpoint(&self.stt_base_url, true)?;
        if self.model.is_empty() || self.model.len() > 100 || !self.model.chars().all(|c| c.is_ascii_alphanumeric() || "/._:-".contains(c))
        {
            return Err(invalid("choose a model from the list"));
        }
        if !["free", "lite", "pro"].contains(&self.plan.as_str()) {
            return Err(invalid("unknown plan"));
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

/// Endpoints must be HTTPS, except plain HTTP on the local machine (a speech-to-text server the user runs).
fn check_endpoint(raw: &str, allow_local_http: bool) -> Result<()> {
    let u = url::Url::parse(raw).map_err(|_| invalid(format!("'{raw}' is not a valid URL")))?;
    let local = matches!(u.host_str(), Some("localhost") | Some("127.0.0.1") | Some("[::1]"));
    match u.scheme() {
        "https" => Ok(()),
        "http" if local && (allow_local_http || cfg!(debug_assertions) || cfg!(test)) => Ok(()),
        _ => Err(invalid(format!("'{raw}' must use https (http is only allowed for localhost)"))),
    }
}

/// Settings that say where a saved key is sent: (secret name, what the address is for, the address).
fn key_destinations(s: &Settings) -> [(&'static str, &'static str, &str); 1] {
    [("stt_api_key", "Speech-to-text address", s.stt_base_url.as_str())]
}

fn origin_of(raw: &str) -> String {
    url::Url::parse(raw).map(|u| u.origin().ascii_serialization()).unwrap_or_else(|_| raw.to_string())
}

/// Addresses that would start receiving a saved key under `new`: the endpoint's origin changed and
/// the key it carries is stored. Returns (label, new address).
pub fn new_key_destinations(old: &Settings, new: &Settings, secrets: &dyn SecretStore) -> Vec<(String, String)> {
    key_destinations(old)
        .iter()
        .zip(key_destinations(new).iter())
        .filter(|((_, _, before), (_, _, after))| origin_of(before) != origin_of(after))
        .filter(|((secret, _, _), _)| secrets.get(secret).ok().flatten().is_some())
        .map(|(_, (_, label, after))| (label.to_string(), after.to_string()))
        .collect()
}

/// The webview is untrusted, so it must not be able to point a saved API key at another server on
/// its own. When saving settings would send a stored key to a new address, the user confirms in a
/// native dialog, which the webview cannot create or answer.
pub async fn confirm_key_destinations(core: &Core, old: &Settings, new: &Settings) -> Result<()> {
    let changes = new_key_destinations(old, new, core.secrets.as_ref());
    if changes.is_empty() {
        return Ok(());
    }
    let preview = ActionPreview {
        title: "Send your saved API key to a new address".into(),
        details: changes,
        warning: Some(
            "Allow this only if you changed this address yourself. The server at this address receives your key with every request.".into(),
        ),
    };
    if core.platform.native_confirm(&preview).await {
        crate::audit::record(&core.db, "user", "change_key_endpoint", None, Some(&serde_json::json!({"to": preview.details})), "ok");
        Ok(())
    } else {
        Err(denied("The address change was not saved because it was not confirmed."))
    }
}

pub fn load(db: &Db) -> Result<Settings> {
    let raw: Option<String> = db.conn().query_row("SELECT value FROM settings WHERE key = 'app'", [], |r| r.get(0)).ok();
    let mut s: Settings = match raw {
        Some(s) => serde_json::from_str(&s).unwrap_or_default(),
        None => Settings::default(),
    };
    // Settings saved before Lumo moved to OpenRouter: on-device and Claude model names, and the
    // retired Unlimited plan (its license no longer validates, so it is Free until a new one is added).
    if !["free", "lite", "pro"].contains(&s.plan.as_str()) {
        s.plan = "free".into();
    }
    if !s.model.contains('/') && s.model != "auto" {
        s.model = "auto".into();
    }
    Ok(s)
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

    #[tokio::test]
    async fn sending_a_saved_key_to_a_new_address_needs_native_confirmation() {
        use crate::core::testing::{core_with, FakePlatform};
        let platform = std::sync::Arc::new(FakePlatform::default());
        let (core, _d) = core_with(platform.clone());
        let old = Settings::default();
        let evil = Settings { stt_base_url: "https://collector.example.com/v1".into(), ..old.clone() };

        // No key saved yet: nothing to leak, no dialog.
        confirm_key_destinations(&core, &old, &evil).await.unwrap();
        assert!(platform.confirms.lock().is_empty());

        core.secrets.set("stt_api_key", "sk-stt").unwrap();
        // Same origin (only the path changed, or nothing changed): no dialog.
        let same = Settings { stt_base_url: "https://api.openai.com/v1/".into(), ..old.clone() };
        confirm_key_destinations(&core, &old, &same).await.unwrap();
        assert!(platform.confirms.lock().is_empty());

        // New origin with a saved key: declined in the dialog means refused.
        *platform.confirm.lock() = false;
        assert!(confirm_key_destinations(&core, &old, &evil).await.is_err());
        let shown = platform.confirms.lock().last().cloned().unwrap();
        assert!(shown.details.iter().any(|(_, v)| v == "https://collector.example.com/v1"), "{shown:?}");

        // Confirmed: allowed.
        *platform.confirm.lock() = true;
        confirm_key_destinations(&core, &old, &evil).await.unwrap();
    }

    #[test]
    fn rejects_insecure_remote_endpoints() {
        let mut s = Settings { stt_base_url: "http://evil.example.com".into(), ..Default::default() };
        assert!(s.validate().is_err());
        s.stt_base_url = "http://localhost:1234/v1".into();
        assert!(s.validate().is_ok());
    }

    #[test]
    fn accepts_every_plan_and_nothing_else() {
        for plan in ["free", "lite", "pro"] {
            assert!(Settings { plan: plan.into(), ..Default::default() }.validate().is_ok(), "{plan}");
        }
        for plan in ["unlimited", "platinum"] {
            assert!(Settings { plan: plan.into(), ..Default::default() }.validate().is_err(), "{plan}");
        }
        for model in ["auto", "anthropic/claude-haiku-5.5", "nvidia/nemotron-3.5-super-vl:free"] {
            assert!(Settings { model: model.into(), ..Default::default() }.validate().is_ok(), "{model}");
        }
        assert!(Settings { model: "a b".into(), ..Default::default() }.validate().is_err());
    }

    #[test]
    fn settings_from_before_openrouter_load_cleanly() {
        let db = Db::memory().unwrap();
        db.conn()
            .execute(
                "INSERT INTO settings(key, value) VALUES ('app', ?1)",
                [r#"{"provider":"local","localModel":"qwen3:8b","model":"claude-opus-5-5","effort":"high","plan":"unlimited","memoryEnabled":true}"#],
            )
            .unwrap();
        let s = load(&db).unwrap();
        assert_eq!((s.model.as_str(), s.plan.as_str(), s.memory_enabled), ("auto", "free", true));
        save(&db, &s).unwrap();
    }

    #[test]
    fn mode_is_lumo_or_linx() {
        assert_eq!(Settings::default().mode, "lumo");
        for mode in ["lumo", "linx"] {
            assert!(Settings { mode: mode.into(), ..Default::default() }.validate().is_ok(), "{mode}");
        }
        for mode in ["", "Lumo", "business", "linx "] {
            assert!(Settings { mode: mode.into(), ..Default::default() }.validate().is_err(), "{mode}");
        }
        // Settings saved before these fields existed get the defaults.
        let old: Settings = serde_json::from_str(r#"{"onboarded":true}"#).unwrap();
        assert!(old.buddy_enabled && old.sounds_enabled && old.animated_icon);
        assert_eq!(old.mode, "lumo");
    }
}
