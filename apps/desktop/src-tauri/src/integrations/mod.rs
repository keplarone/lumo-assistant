//! Third-party services. Each is real and tested against its documented API with mocks; none is
//! shown as connected unless the user supplied credentials and Lumo verified them.

pub mod brave;
pub mod github;
pub mod netlify;

use crate::core::Core;
use crate::error::{LumoError, Result};
use crate::util::now;
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationStatus {
    pub id: String,
    pub name: String,
    /// "connected", "not_connected", "built_in", "handoff" or "upcoming".
    pub status: String,
    pub account: Option<String>,
    pub detail: String,
    /// The secret that connects it, if any (set with set_secret, then verify_integration).
    pub secret: Option<String>,
}

#[derive(Clone)]
pub struct ApiBases {
    pub github: String,
    pub netlify: String,
    pub brave: String,
}

impl Default for ApiBases {
    fn default() -> Self {
        ApiBases {
            github: "https://api.github.com".into(),
            netlify: "https://api.netlify.com/api/v1".into(),
            brave: "https://api.search.brave.com/res/v1".into(),
        }
    }
}

fn account(core: &Core, id: &str) -> Option<String> {
    core.db
        .conn()
        .query_row("SELECT account_label FROM integrations WHERE id = ?1 AND status = 'connected'", [id], |r| r.get(0))
        .ok()
        .flatten()
}

pub fn record(core: &Core, id: &str, status: &str, account: Option<&str>, meta: &Value) -> Result<()> {
    core.db.conn().execute(
        "INSERT INTO integrations(id, status, account_label, connected_at, meta_json) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, account_label = excluded.account_label, connected_at = excluded.connected_at, meta_json = excluded.meta_json",
        rusqlite::params![id, status, account, now(), meta.to_string()],
    )?;
    Ok(())
}

pub fn status(core: &Core) -> Vec<IntegrationStatus> {
    let has = |k: &str| core.secrets.get(k).ok().flatten().is_some();
    let out = vec![
        IntegrationStatus {
            id: "brave".into(),
            name: "Brave Search".into(),
            status: if has("brave_search_api_key") { "connected" } else { "not_connected" }.into(),
            account: None,
            detail: "Lets Lumo search the web. Add a Brave Search API key to turn it on.".into(),
            secret: Some("brave_search_api_key".into()),
        },
        IntegrationStatus {
            id: "openstreetmap".into(),
            name: "OpenStreetMap".into(),
            status: "built_in".into(),
            account: None,
            detail: "Finds real nearby places. No menus, prices or ratings.".into(),
            secret: None,
        },
        IntegrationStatus {
            id: "github".into(),
            name: "GitHub".into(),
            status: if has("github_token") && account(core, "github").is_some() { "connected" } else { "not_connected" }.into(),
            account: account(core, "github"),
            detail: "Publish projects to a repository. Connect with a fine-grained personal access token that can create repositories.".into(),
            secret: Some("github_token".into()),
        },
        IntegrationStatus {
            id: "netlify".into(),
            name: "Netlify".into(),
            status: if has("netlify_token") && account(core, "netlify").is_some() { "connected" } else { "not_connected" }.into(),
            account: account(core, "netlify"),
            detail: "Deploy website projects to a public URL. Connect with a Netlify personal access token.".into(),
            secret: Some("netlify_token".into()),
        },
        IntegrationStatus {
            id: "food_shopping".into(),
            name: "Food ordering and shopping".into(),
            status: "handoff".into(),
            account: None,
            detail: "Lumo finds options and prepares the order, then opens the merchant's site where you order and pay. Direct ordering needs partner API access (DoorDash, Uber Eats) that Lumo doesn't have yet.".into(),
            secret: None,
        },
        IntegrationStatus {
            id: "google".into(),
            name: "Google (Gmail, Calendar, Drive)".into(),
            status: "upcoming".into(),
            account: None,
            detail: "Coming later. Needs a verified Google OAuth app.".into(),
            secret: None,
        },
    ];
    out
}

/// Check a connected service's credentials and record the account it belongs to.
pub async fn verify(core: &Core, id: &str) -> Result<String> {
    let bases = core.api_bases.lock().clone();
    match id {
        "github" => {
            let token = core.secrets.get("github_token")?.ok_or_else(|| LumoError::Unavailable("Add a GitHub token first.".into()))?;
            let login = github::whoami(&core.http, &bases.github, &token).await?;
            record(core, "github", "connected", Some(&login), &Value::Null)?;
            crate::audit::record(&core.db, "user", "connect_github", Some(&login), None, "ok");
            Ok(login)
        }
        "netlify" => {
            let token = core.secrets.get("netlify_token")?.ok_or_else(|| LumoError::Unavailable("Add a Netlify token first.".into()))?;
            let who = netlify::whoami(&core.http, &bases.netlify, &token).await?;
            record(core, "netlify", "connected", Some(&who), &Value::Null)?;
            crate::audit::record(&core.db, "user", "connect_netlify", Some(&who), None, "ok");
            Ok(who)
        }
        "brave" => {
            let key = core
                .secrets
                .get("brave_search_api_key")?
                .ok_or_else(|| LumoError::Unavailable("Add a Brave Search API key first.".into()))?;
            brave::search(&core.http, &bases.brave, &key, "Lumo assistant", 1).await?;
            Ok("Brave Search".into())
        }
        _ => Err(crate::error::invalid("unknown integration")),
    }
}

pub fn disconnect(core: &Core, id: &str) -> Result<()> {
    let secret = match id {
        "github" => "github_token",
        "netlify" => "netlify_token",
        "brave" => "brave_search_api_key",
        _ => return Err(crate::error::invalid("unknown integration")),
    };
    core.secrets.delete(secret)?;
    core.db.conn().execute("DELETE FROM integrations WHERE id = ?1", [id])?;
    crate::audit::record(&core.db, "user", "disconnect", Some(id), None, "ok");
    Ok(())
}

/// Map an HTTP error from a service into a clear message.
pub fn http_error(service: &str, status: u16, body: &str) -> LumoError {
    let msg = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v["message"].as_str().map(String::from))
        .unwrap_or_else(|| crate::util::preview(body, 160));
    match status {
        401 => LumoError::Denied(format!("{service} rejected the token. Reconnect it in Settings → Integrations.")),
        403 => LumoError::Denied(format!("{service} refused: {msg}. The token may be missing a permission.")),
        404 => LumoError::NotFound(format!("{service}: {msg}")),
        422 => LumoError::Invalid(format!("{service}: {msg}")),
        429 => LumoError::Unavailable(format!("{service} is rate limiting requests; try again later.")),
        _ => LumoError::Unavailable(format!("{service} answered with HTTP {status}: {msg}")),
    }
}
