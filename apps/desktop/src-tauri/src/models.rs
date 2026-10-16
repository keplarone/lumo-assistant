//! Lumo's models come from Lumo's model gateway (services/license), which runs OpenRouter models for
//! the user's plan. This module knows where the gateway is, which models each plan offers (fetched
//! from the gateway and cached, since the list changes without app releases) and how much of this
//! month's allowance is used. The gateway enforces the plan's models and allowance; the app only
//! shows them.
//!
//! Build-time configuration:
//!   LUMO_API_BASE        e.g. https://lumo-license.vercel.app (defaults to LUMO_LICENSE_SERVER's origin)

use crate::core::Core;
use crate::error::{LumoError, Result};
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// The gateway's base address for this build, if it has one.
pub fn api_base() -> Option<String> {
    let explicit = option_env!("LUMO_API_BASE").map(str::trim).filter(|s| s.starts_with("https://"));
    explicit
        .map(|s| s.trim_end_matches('/').to_string())
        .or_else(|| crate::license::server().and_then(|u| url::Url::parse(&u).ok()).map(|u| u.origin().ascii_serialization()))
}

fn base(core: &Core) -> Result<String> {
    core.endpoints.lock().lumo_api.clone().ok_or_else(|| LumoError::Unavailable("Lumo's models aren't available in this build.".into()))
}

/// A random id this install made on first run. Free users are counted by it until accounts arrive.
pub fn install_id(core: &Core) -> Result<String> {
    let conn = core.db.conn();
    if let Ok(id) = conn.query_row("SELECT value FROM settings WHERE key = 'install_id'", [], |r| r.get::<_, String>(0)) {
        if id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Ok(id);
        }
    }
    let id = hex::encode(rand::random::<[u8; 16]>());
    conn.execute(
        "INSERT INTO settings(key, value) VALUES ('install_id', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [&id],
    )?;
    Ok(id)
}

/// The license key paid plans send to the gateway.
pub fn license_key(core: &Core) -> Option<String> {
    if core.settings().plan == "free" {
        return None;
    }
    core.secrets.get(crate::license::SECRET).ok().flatten()
}

fn request(core: &Core, rb: reqwest::RequestBuilder) -> Result<reqwest::RequestBuilder> {
    let rb = rb.header("X-Lumo-Install", install_id(core)?).timeout(Duration::from_secs(15));
    Ok(match license_key(core) {
        Some(k) => rb.bearer_auth(k),
        None => rb,
    })
}

// ---- Which models each plan offers ----------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogModel {
    /// OpenRouter's id, e.g. "anthropic/claude-haiku-5.5".
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub blurb: String,
    /// Accepts images, so Lumo can show it screenshots and let it use the screen.
    #[serde(default)]
    pub vision: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogPlan {
    pub id: String,
    pub name: String,
    pub price_usd: f64,
    pub default_model: Option<String>,
    pub models: Vec<CatalogModel>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub plans: Vec<CatalogPlan>,
}

impl Catalog {
    pub fn plan(&self, id: &str) -> Option<&CatalogPlan> {
        self.plans.iter().find(|p| p.id == id)
    }
}

/// The last catalog the gateway sent, if any.
pub fn cached_catalog(core: &Core) -> Option<Catalog> {
    let raw: String = core.db.conn().query_row("SELECT value FROM settings WHERE key = 'model_catalog'", [], |r| r.get(0)).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Fetch the catalog from the gateway and cache it. Falls back to the cached one when offline.
pub async fn catalog(core: &Core) -> Result<Catalog> {
    let fetched = async {
        let resp = core.http.get(format!("{}/api/models", base(core)?)).timeout(Duration::from_secs(15)).send().await?;
        if !resp.status().is_success() {
            return Err(LumoError::Unavailable(format!("Lumo's model service answered with HTTP {}.", resp.status().as_u16())));
        }
        Ok::<Catalog, LumoError>(resp.json().await?)
    }
    .await;
    match fetched {
        Ok(c) => {
            core.db.conn().execute(
                "INSERT INTO settings(key, value) VALUES ('model_catalog', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [serde_json::to_string(&c)?],
            )?;
            Ok(c)
        }
        Err(e) => cached_catalog(core).ok_or(e),
    }
}

/// Whether the model a plan would use for `model` ("auto" means the plan's default) accepts images.
/// Before the first catalog arrives, paid plans are assumed to (every paid model does) and Free not.
pub fn model_sees_images(core: &Core, plan: &str, model: &str) -> bool {
    let Some(c) = cached_catalog(core) else { return plan != "free" };
    let Some(p) = c.plan(plan) else { return false };
    let id = if model.is_empty() || model == "auto" { p.default_model.as_deref().unwrap_or("") } else { model };
    p.models.iter().find(|m| m.id == id).map(|m| m.vision).unwrap_or(false)
}

// ---- This month's usage ---------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServerUsage {
    pub plan: String,
    pub percent_used: u8,
    pub resets_at: String,
}

/// How much of this month's allowance is used, from the gateway. When the gateway says the license
/// grants a different plan (it lapsed, or changed on Whop), the app follows it.
pub async fn usage(core: &Core) -> Result<ServerUsage> {
    let resp = request(core, core.http.get(format!("{}/api/usage", base(core)?)))?.send().await?;
    let status = resp.status().as_u16();
    let body: serde_json::Value = resp.json().await.unwrap_or_default();
    if status == 403 && body["code"] == "license_invalid" {
        crate::license::set_plan(core, "free")?;
    }
    if !(200..300).contains(&status) {
        let msg = body["error"].as_str().map(String::from).unwrap_or_else(|| format!("Lumo's model service answered with HTTP {status}."));
        return Err(LumoError::Unavailable(msg));
    }
    let u: ServerUsage = serde_json::from_value(body)?;
    if ["free", "lite", "pro"].contains(&u.plan.as_str()) && u.plan != core.settings().plan {
        crate::license::set_plan(core, &u.plan)?;
    }
    Ok(u)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::testing::{core_with, set_plan, FakePlatform};
    use std::sync::Arc;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn catalog_json() -> serde_json::Value {
        serde_json::json!({"plans": [
            {"id": "free", "name": "Free", "priceUsd": 0, "defaultModel": "nvidia/nemotron-3.5-super-vl:free", "models": [
                {"id": "nvidia/nemotron-3.5-super-vl:free", "name": "Nemotron 3.5 Super VL", "blurb": "", "vision": true},
                {"id": "xingchen-agi/xing4.0-29b-a4b:free", "name": "Xing4.0", "blurb": "", "vision": false}
            ]},
            {"id": "lite", "name": "Lumo Lite", "priceUsd": 19.99, "defaultModel": "anthropic/claude-haiku-5.5", "models": [
                {"id": "anthropic/claude-haiku-5.5", "name": "Claude Haiku 5.5", "blurb": "Fast", "vision": true}
            ]}
        ]})
    }

    #[tokio::test]
    async fn catalog_is_fetched_cached_and_used_offline() {
        let (core, _d) = core_with(Arc::new(FakePlatform::default()));
        // Nothing cached yet: paid plans are assumed to see images, Free not.
        assert!(model_sees_images(&core, "lite", "auto") && !model_sees_images(&core, "free", "auto"));
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/models"))
            .respond_with(ResponseTemplate::new(200).set_body_json(catalog_json()))
            .expect(1)
            .mount(&server)
            .await;
        core.endpoints.lock().lumo_api = Some(server.uri());
        let c = catalog(&core).await.unwrap();
        assert_eq!(c.plan("lite").unwrap().price_usd, 19.99);
        assert!(model_sees_images(&core, "free", "auto"));
        assert!(!model_sees_images(&core, "free", "xingchen-agi/xing4.0-29b-a4b:free"));
        assert!(!model_sees_images(&core, "lite", "unknown/model"));
        // Offline: the cached copy.
        core.endpoints.lock().lumo_api = Some("http://127.0.0.1:9".into());
        assert_eq!(catalog(&core).await.unwrap(), c);
    }

    #[tokio::test]
    async fn usage_follows_the_plan_the_gateway_reports() {
        let (core, _d) = core_with(Arc::new(FakePlatform::default()));
        set_plan(&core, "pro");
        core.secrets.set(crate::license::SECRET, "mem_ABC123").unwrap();
        let id = install_id(&core).unwrap();
        assert_eq!(id, install_id(&core).unwrap(), "made once");
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/usage"))
            .and(header("authorization", "Bearer mem_ABC123"))
            .and(header("x-lumo-install", id.as_str()))
            .respond_with(ResponseTemplate::new(200).set_body_json(
                serde_json::json!({"plan": "lite", "planName": "Lumo Lite", "percentUsed": 42, "resetsAt": "2026-11-01T00:00:00.000Z"}),
            ))
            .mount(&server)
            .await;
        core.endpoints.lock().lumo_api = Some(server.uri());
        let u = usage(&core).await.unwrap();
        assert_eq!((u.plan.as_str(), u.percent_used), ("lite", 42));
        assert_eq!(core.settings().plan, "lite", "downgraded on Whop");
    }

    #[tokio::test]
    async fn a_lapsed_license_falls_back_to_free() {
        let (core, _d) = core_with(Arc::new(FakePlatform::default()));
        set_plan(&core, "lite");
        core.secrets.set(crate::license::SECRET, "mem_OLD123").unwrap();
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(
                ResponseTemplate::new(403)
                    .set_body_json(serde_json::json!({"code": "license_invalid", "error": "Your Lumo license is no longer active."})),
            )
            .mount(&server)
            .await;
        core.endpoints.lock().lumo_api = Some(server.uri());
        assert!(usage(&core).await.unwrap_err().to_string().contains("no longer active"));
        assert_eq!(core.settings().plan, "free");
    }
}
