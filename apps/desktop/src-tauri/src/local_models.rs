//! On-device models: Lumo's own model configurations (Orbit 3.8, Nebula 4.2, Solar 5.4, Nova 5.5, the
//! same product names Keplar uses in Space Studio), each running an open-weight model that run on the user's computer through a local
//! Ollama runtime, so requests cost nothing and never leave the machine.
//!
//! Lumo does not ship the runtime or the weights. It checks for a running runtime, shows which models fit
//! this computer's memory, and downloads only models from its own catalog (all Apache-2.0 licensed, with the
//! original model name and license shown to the user). Chat goes through the OpenAI-compatible adapter.

use crate::core::Core;
use crate::error::{invalid, LumoError, Result};
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::json;
use std::time::Duration;

/// Label for the on-device engine as a whole.
pub const BRAND: &str = "Lumo on-device models";
pub const RUNTIME_DOWNLOAD_URL: &str = "https://ollama.com/download";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    /// Runtime model tag, e.g. "qwen3:8b".
    pub id: &'static str,
    /// Product name shown to the user, e.g. "Nebula 4.2".
    pub tier: &'static str,
    /// The underlying open model, always shown for attribution.
    pub base_model: &'static str,
    pub license: &'static str,
    pub license_url: &'static str,
    pub download_gb: f32,
    pub min_memory_gb: u32,
    pub summary: &'static str,
}

pub const CATALOG: &[CatalogEntry] = &[
    CatalogEntry {
        id: "qwen3:4b",
        tier: "Orbit 3.8",
        base_model: "Qwen3 4B",
        license: "Apache-2.0",
        license_url: "https://www.apache.org/licenses/LICENSE-2.0",
        download_gb: 2.6,
        min_memory_gb: 8,
        summary: "Quick answers and simple tasks on most laptops.",
    },
    CatalogEntry {
        id: "qwen3:8b",
        tier: "Nebula 4.2",
        base_model: "Qwen3 8B",
        license: "Apache-2.0",
        license_url: "https://www.apache.org/licenses/LICENSE-2.0",
        download_gb: 5.2,
        min_memory_gb: 16,
        summary: "Good everyday choice for planning and using tools.",
    },
    CatalogEntry {
        id: "gpt-oss:20b",
        tier: "Solar 5.4",
        base_model: "gpt-oss 20B",
        license: "Apache-2.0",
        license_url: "https://www.apache.org/licenses/LICENSE-2.0",
        download_gb: 14.0,
        min_memory_gb: 16,
        summary: "Stronger reasoning; needs a recent computer with 16 GB of memory or more.",
    },
    CatalogEntry {
        id: "qwen3:30b",
        tier: "Nova 5.5",
        base_model: "Qwen3 30B-A3B",
        license: "Apache-2.0",
        license_url: "https://www.apache.org/licenses/LICENSE-2.0",
        download_gb: 19.0,
        min_memory_gb: 32,
        summary: "The most capable on-device option, for machines with 32 GB of memory or more.",
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
    pub fits: bool,
    pub selected: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalStatus {
    pub brand: &'static str,
    pub runtime_running: bool,
    pub runtime_version: Option<String>,
    pub runtime_download_url: &'static str,
    pub memory_gb: u32,
    pub models: Vec<LocalModel>,
    /// Other models found in the runtime that are not in Lumo's catalog (usable, but not branded).
    pub other_installed: Vec<String>,
}

fn base(core: &Core) -> String {
    core.settings().local_base_url.trim_end_matches('/').to_string()
}

pub fn memory_gb() -> u32 {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    (sys.total_memory() as f64 / 1_073_741_824.0).round() as u32
}

pub fn catalog_entry(id: &str) -> Result<&'static CatalogEntry> {
    CATALOG.iter().find(|e| e.id == id).ok_or_else(|| invalid(format!("'{id}' is not one of Lumo's on-device models")))
}

async fn installed(core: &Core) -> Result<Vec<String>> {
    let v: serde_json::Value = core
        .http
        .get(format!("{}/api/tags", base(core)))
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .map_err(|_| unavailable())?
        .error_for_status()
        .map_err(|_| unavailable())?
        .json()
        .await?;
    Ok(v["models"].as_array().into_iter().flatten().filter_map(|m| m["name"].as_str().map(str::to_string)).collect())
}

fn unavailable() -> LumoError {
    LumoError::Unavailable(format!("The on-device model runtime is not running. Install Ollama from {RUNTIME_DOWNLOAD_URL} and open it."))
}

/// Tag equality that treats "name" and "name:latest" as the same model.
fn same_tag(a: &str, b: &str) -> bool {
    let norm = |s: &str| if s.contains(':') { s.to_string() } else { format!("{s}:latest") };
    norm(a) == norm(b)
}

pub async fn status(core: &Core) -> LocalStatus {
    status_with_memory(core, memory_gb()).await
}

pub async fn status_with_memory(core: &Core, memory_gb: u32) -> LocalStatus {
    let s = core.settings();
    let version: Option<String> = async {
        let v: serde_json::Value =
            core.http.get(format!("{}/api/version", base(core))).timeout(Duration::from_secs(3)).send().await.ok()?.json().await.ok()?;
        v["version"].as_str().map(str::to_string)
    }
    .await;
    let names = if version.is_some() { installed(core).await.unwrap_or_default() } else { vec![] };
    let models = CATALOG
        .iter()
        .map(|e| LocalModel {
            entry: e.clone(),
            display_name: e.tier.to_string(),
            installed: names.iter().any(|n| same_tag(n, e.id)),
            fits: memory_gb == 0 || memory_gb >= e.min_memory_gb,
            selected: s.provider == "local" && same_tag(&s.local_model, e.id),
        })
        .collect();
    let other_installed = names.iter().filter(|n| !CATALOG.iter().any(|e| same_tag(n, e.id))).cloned().collect();
    LocalStatus {
        brand: BRAND,
        runtime_running: version.is_some(),
        runtime_version: version,
        runtime_download_url: RUNTIME_DOWNLOAD_URL,
        memory_gb,
        models,
        other_installed,
    }
}

/// Download a catalog model, broadcasting `local-model-progress` events ({model, status, completed, total, done}).
pub async fn pull(core: &Core, id: &str, cancel: tokio_util::sync::CancellationToken) -> Result<()> {
    let entry = catalog_entry(id)?;
    let resp = core
        .http
        .post(format!("{}/api/pull", base(core)))
        .json(&json!({"model": entry.id, "stream": true}))
        .send()
        .await
        .map_err(|_| unavailable())?;
    if !resp.status().is_success() {
        return Err(LumoError::Unavailable(format!("The runtime refused the download (HTTP {}).", resp.status().as_u16())));
    }
    let mut stream = resp.bytes_stream();
    let mut buf = Vec::<u8>::new();
    let emit = |status: &str, completed: u64, total: u64, done: bool| {
        core.platform.broadcast(
            "local-model-progress",
            json!({"model": entry.id, "status": status, "completed": completed, "total": total, "done": done}),
        );
    };
    loop {
        let chunk = tokio::select! {
            _ = cancel.cancelled() => {
                emit("cancelled", 0, 0, true);
                return Err(LumoError::Cancelled);
            }
            c = stream.next() => c,
        };
        let Some(chunk) = chunk else { break };
        buf.extend_from_slice(&chunk?);
        while let Some(nl) = buf.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = buf.drain(..=nl).collect();
            let Ok(v) = serde_json::from_slice::<serde_json::Value>(&line) else { continue };
            if let Some(err) = v["error"].as_str() {
                emit("failed", 0, 0, true);
                return Err(LumoError::Unavailable(format!("Download failed: {err}")));
            }
            let status = v["status"].as_str().unwrap_or("");
            if status == "success" {
                emit("success", 0, 0, true);
                crate::audit::record(&core.db, "user", "local_model_download", Some(entry.id), None, "ok");
                return Ok(());
            }
            emit(status, v["completed"].as_u64().unwrap_or(0), v["total"].as_u64().unwrap_or(0), false);
        }
    }
    emit("failed", 0, 0, true);
    Err(LumoError::Unavailable("The download stopped before it finished.".into()))
}

pub async fn delete(core: &Core, id: &str) -> Result<()> {
    let entry = catalog_entry(id)?;
    let resp =
        core.http.delete(format!("{}/api/delete", base(core))).json(&json!({"model": entry.id})).send().await.map_err(|_| unavailable())?;
    if !resp.status().is_success() {
        return Err(LumoError::Unavailable(format!("The runtime could not remove the model (HTTP {}).", resp.status().as_u16())));
    }
    crate::audit::record(&core.db, "user", "local_model_delete", Some(entry.id), None, "ok");
    Ok(())
}

/// Switch Lumo to an installed on-device model.
pub async fn select(core: &Core, id: &str) -> Result<()> {
    let names = installed(core).await?;
    if !names.iter().any(|n| same_tag(n, id)) {
        return Err(invalid("Download this model before choosing it."));
    }
    let mut s = core.settings();
    s.provider = "local".into();
    s.local_model = id.to_string();
    crate::settings::save(&core.db, &s)?;
    core.platform.broadcast("settings-changed", json!({}));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::testing::{core_with, FakePlatform};
    use std::sync::Arc;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn status_download_and_select() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/version"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"version": "0.12.0"})))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/tags"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"models": [{"name": "qwen3:8b"}, {"name": "phi4:latest"}]})))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/api/pull"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                "{\"status\":\"pulling manifest\"}\n{\"status\":\"downloading\",\"completed\":5,\"total\":10}\n{\"status\":\"success\"}\n",
            ))
            .mount(&server)
            .await;
        let platform = Arc::new(FakePlatform::default());
        let (core, _dir) = core_with(platform.clone());
        let mut s = core.settings();
        s.local_base_url = server.uri();
        crate::settings::save(&core.db, &s).unwrap();

        let st = status_with_memory(&core, 16).await;
        assert!(st.runtime_running);
        assert_eq!(st.runtime_version.as_deref(), Some("0.12.0"));
        let balanced = st.models.iter().find(|m| m.entry.id == "qwen3:8b").unwrap();
        assert!(balanced.installed && balanced.fits && !balanced.selected);
        assert_eq!(balanced.display_name, "Nebula 4.2");
        assert!(!st.models.iter().find(|m| m.entry.id == "qwen3:30b").unwrap().fits);
        assert_eq!(st.other_installed, vec!["phi4:latest".to_string()]);

        pull(&core, "qwen3:4b", Default::default()).await.unwrap();
        let events = platform.broadcasts.lock().clone();
        assert!(events.iter().any(|(e, p)| e == "local-model-progress" && p["completed"] == 5 && p["total"] == 10));
        assert!(events.iter().any(|(_, p)| p["status"] == "success" && p["done"] == true));

        // Only catalog models can be downloaded, and only installed ones chosen.
        assert!(pull(&core, "some/other-model", Default::default()).await.is_err());
        assert!(select(&core, "qwen3:4b").await.is_err());
        select(&core, "qwen3:8b").await.unwrap();
        let s = core.settings();
        assert_eq!((s.provider.as_str(), s.local_model.as_str()), ("local", "qwen3:8b"));
        assert_eq!(core.provider().unwrap().name(), "openai_compatible");
    }

    #[tokio::test]
    async fn reports_a_missing_runtime() {
        let (core, _dir) = core_with(Arc::new(FakePlatform::default()));
        let mut s = core.settings();
        s.local_base_url = "http://127.0.0.1:9".into();
        crate::settings::save(&core.db, &s).unwrap();
        let st = status_with_memory(&core, 8).await;
        assert!(!st.runtime_running);
        assert!(st.models.iter().all(|m| !m.installed));
        let err = pull(&core, "qwen3:4b", Default::default()).await.unwrap_err().to_string();
        assert!(err.contains("ollama.com"), "{err}");
    }
}
