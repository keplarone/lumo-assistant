//! Lumo plans, sold through Whop. The desktop app never holds a Whop secret: it opens Whop checkout pages
//! and asks Lumo's license server (services/license) whether a license key grants Lite or Pro.
//!
//! Build-time configuration (empty means "not set up in this build", and the UI says so):
//!   LUMO_LICENSE_SERVER    e.g. https://license.lumo.keplar.one/api/validate
//!   LUMO_WHOP_CHECKOUT_LITE, LUMO_WHOP_CHECKOUT_PRO
//!                          override the Whop checkout page URLs
//! The same key is what paid plans send to Lumo's model gateway (see models.rs), which re-checks it.

use crate::core::Core;
use crate::error::{invalid, LumoError, Result};
use serde::Serialize;
use std::time::Duration;

pub const SECRET: &str = "whop_license_key";
/// Whop plan ids. These are public identifiers, not secrets.
pub const WHOP_PLAN_LITE: &str = "plan_0KzI2YIP7k6Pp";
pub const WHOP_PLAN_PRO: &str = "plan_1ucbcMEoxhW3g";

fn checkout(over: Option<&'static str>, plan: &str) -> String {
    cfg(over).unwrap_or_else(|| format!("https://whop.com/checkout/{plan}"))
}

fn cfg(v: Option<&'static str>) -> Option<String> {
    v.map(str::trim).filter(|s| s.starts_with("https://")).map(str::to_string)
}

pub fn server() -> Option<String> {
    cfg(option_env!("LUMO_LICENSE_SERVER"))
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LicenseStatus {
    /// "free", "lite" or "pro".
    pub plan: String,
    pub has_key: bool,
    pub licensing_configured: bool,
    pub checkout_lite: String,
    pub checkout_pro: String,
    pub checked_at: Option<String>,
}

pub fn status(core: &Core) -> LicenseStatus {
    let s = core.settings();
    LicenseStatus {
        plan: s.plan.clone(),
        has_key: core.secrets.get(SECRET).ok().flatten().is_some(),
        licensing_configured: server().is_some(),
        checkout_lite: checkout(option_env!("LUMO_WHOP_CHECKOUT_LITE"), WHOP_PLAN_LITE),
        checkout_pro: checkout(option_env!("LUMO_WHOP_CHECKOUT_PRO"), WHOP_PLAN_PRO),
        checked_at: s.plan_checked_at.clone(),
    }
}

/// Validate a license key with the license server and remember the plan it grants.
pub async fn activate(core: &Core, server_url: Option<String>, key: &str) -> Result<LicenseStatus> {
    let key = key.trim();
    if key.len() < 6 || key.len() > 128 || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(invalid("That does not look like a license key."));
    }
    let url = server_url.ok_or_else(|| LumoError::Unavailable("Plans are not available in this build yet.".into()))?;
    let resp = core
        .http
        .post(&url)
        .json(&serde_json::json!({ "licenseKey": key }))
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| LumoError::Unavailable(format!("Could not reach the license server: {e}")))?;
    let code = resp.status().as_u16();
    let body: serde_json::Value = resp.json().await.unwrap_or_default();
    let err = body["error"].as_str().unwrap_or("The license could not be checked.").to_string();
    if body["valid"] != true {
        return Err(if code >= 500 { LumoError::Unavailable(err) } else { LumoError::Denied(err) });
    }
    let tier = match body["tier"].as_str() {
        Some(t @ ("lite" | "pro")) => t.to_string(),
        _ => return Err(LumoError::Unavailable("The license server sent an unknown plan.".into())),
    };
    core.secrets.set(SECRET, key)?;
    let mut s = core.settings();
    s.plan = tier.clone();
    s.plan_checked_at = Some(crate::util::now());
    crate::settings::save(&core.db, &s)?;
    crate::audit::record(&core.db, "user", "license_activated", Some(&tier), None, "ok");
    crate::plans::pause_excess_automations(core)?;
    Ok(status(core))
}

pub fn deactivate(core: &Core) -> Result<LicenseStatus> {
    core.secrets.delete(SECRET)?;
    let mut s = core.settings();
    s.plan = "free".into();
    s.plan_checked_at = None;
    crate::settings::save(&core.db, &s)?;
    crate::audit::record(&core.db, "user", "license_removed", None, None, "ok");
    crate::plans::pause_excess_automations(core)?;
    Ok(status(core))
}

/// Follow the plan Lumo's model gateway reports for the saved license (it lapsed, or changed on Whop).
pub fn set_plan(core: &Core, plan: &str) -> Result<()> {
    let mut s = core.settings();
    if s.plan == plan {
        return Ok(());
    }
    s.plan = plan.into();
    s.plan_checked_at = Some(crate::util::now());
    crate::settings::save(&core.db, &s)?;
    crate::audit::record(&core.db, "system", "plan_changed", Some(plan), None, "ok");
    crate::plans::pause_excess_automations(core)?;
    core.platform.broadcast("settings-changed", serde_json::json!({}));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::testing::{core_with, FakePlatform};
    use std::sync::Arc;
    use wiremock::matchers::{body_json, method};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn activates_and_removes_a_license() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(body_json(serde_json::json!({"licenseKey": "A1B2C3-D4E5F6"})))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"valid": true, "tier": "pro"})))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"valid": false, "error": "License key not found."})))
            .mount(&server)
            .await;
        let (core, _dir) = core_with(Arc::new(FakePlatform::default()));
        assert_eq!(status(&core).plan, "free");
        assert_eq!(status(&core).checkout_pro, "https://whop.com/checkout/plan_1ucbcMEoxhW3g");

        let err = activate(&core, Some(server.uri()), "ZZZZZZ-000000").await.unwrap_err().to_string();
        assert!(err.contains("not found"), "{err}");
        assert_eq!(core.settings().plan, "free");
        assert!(activate(&core, Some(server.uri()), "../../etc").await.is_err());
        assert!(activate(&core, None, "A1B2C3-D4E5F6").await.is_err());

        let st = activate(&core, Some(server.uri()), " A1B2C3-D4E5F6 ").await.unwrap();
        assert_eq!((st.plan.as_str(), st.has_key), ("pro", true));
        let st = deactivate(&core).unwrap();
        assert_eq!((st.plan.as_str(), st.has_key), ("free", false));
    }

    #[tokio::test]
    async fn rejects_unknown_tiers_including_the_retired_unlimited() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"valid": true, "tier": "unlimited"})))
            .mount(&server)
            .await;
        let (core, _dir) = core_with(Arc::new(FakePlatform::default()));
        assert!(activate(&core, Some(server.uri()), "UNLIM-000001").await.is_err());
        assert_eq!(core.settings().plan, "free");
    }
}
