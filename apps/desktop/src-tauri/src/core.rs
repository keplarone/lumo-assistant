//! Shared state for the Rust core. Platform services (dialogs, notifications, opening URLs,
//! clipboard, screen, input) are traits so the agent can be tested without a desktop session.

use crate::agent::events::ActionPreview;
use crate::db::Db;
use crate::error::Result;
use crate::model::ModelProvider;
use crate::policy::RateLimiter;
use crate::secrets::Secrets;
use crate::settings::{self, Settings};
use async_trait::async_trait;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

#[async_trait]
pub trait Platform: Send + Sync {
    /// Show a native OS confirmation dialog. The webview cannot create, change or answer it.
    async fn native_confirm(&self, preview: &ActionPreview) -> bool;
    fn notify(&self, title: &str, body: &str) -> Result<()>;
    fn open_url(&self, url: &str) -> Result<()>;
    fn clipboard_read(&self) -> Result<String>;
    fn clipboard_write(&self, text: &str) -> Result<()>;
    /// Ask the user to pick a folder with the native picker. None if cancelled.
    async fn pick_folder(&self) -> Option<PathBuf>;
    /// Capture the primary screen (downscaled for the model).
    fn capture_screen(&self) -> Result<Screenshot>;
    /// Perform mouse and keyboard input in real screen coordinates.
    fn perform_input(&self, actions: &[crate::tools::computer::InputAction]) -> Result<()>;
    /// Lumo started or stopped controlling input: show or hide the indicator and the stop shortcut.
    fn input_control_changed(&self, active: bool);
    /// The app name and title of the window in front.
    fn active_window(&self) -> Result<(String, String)>;
    /// Tell every window about something (privacy indicators, list changes).
    fn broadcast(&self, event: &str, payload: serde_json::Value);
    /// One position fix from the operating system's location service (may show the OS permission
    /// prompt). Callers confirm with the user first; see `crate::location`.
    async fn current_position(&self) -> Result<crate::location::Fix>;
}

/// A screen capture and where it sits on the desktop, so model coordinates map back to the screen.
#[derive(Debug, Clone)]
pub struct Screenshot {
    pub png: Vec<u8>,
    /// Size of the image the model sees.
    pub width: u32,
    pub height: u32,
    /// The captured display in desktop coordinates.
    pub origin_x: i32,
    pub origin_y: i32,
    pub screen_width: u32,
    pub screen_height: u32,
}

#[derive(Clone)]
pub struct Paths {
    pub data_dir: PathBuf,
    /// Copies of files before Lumo overwrote them, for undo.
    pub backups_dir: PathBuf,
    pub log_dir: PathBuf,
    /// Where new projects are created (each is also granted as a folder).
    pub projects_dir: PathBuf,
}

/// Public services Lumo calls directly. Overridable for tests.
#[derive(Clone)]
pub struct Endpoints {
    pub nominatim: String,
    pub overpass: String,
    /// Host that on-device model files are downloaded from (the catalog pins the rest of the address).
    pub model_downloads: String,
}

impl Default for Endpoints {
    fn default() -> Self {
        Endpoints {
            nominatim: "https://nominatim.openstreetmap.org".into(),
            overpass: "https://overpass-api.de/api/interpreter".into(),
            model_downloads: crate::local_models::DOWNLOAD_HOST.into(),
        }
    }
}

/// Pending in-app approvals and questions, keyed by id. Only reachable for runs that are alive.
#[derive(Default)]
pub struct Pending {
    pub approvals: Mutex<HashMap<String, oneshot::Sender<crate::tools::ApprovalAnswer>>>,
    pub questions: Mutex<HashMap<String, oneshot::Sender<String>>>,
    pub runs: Mutex<HashMap<String, ActiveRun>>,
    /// Tools the user allowed for the rest of a conversation ("don't ask again here"). Write tier only.
    pub conversation_allow: Mutex<HashMap<String, Vec<String>>>,
    /// Files the user chose (drag and drop or the file picker), by token. The webview refers to
    /// attachments only by these tokens, so it cannot make Lumo read arbitrary paths.
    pub attachments: Mutex<HashMap<String, PathBuf>>,
    /// Runs the user allowed to control mouse and keyboard (until the run ends or they press stop).
    pub input_sessions: Mutex<std::collections::HashSet<String>>,
    /// Geometry of the last screenshot, per run.
    pub screens: Mutex<HashMap<String, Screenshot>>,
    /// Where the user is, per conversation, after they let Lumo detect it. Memory only; `find_places`
    /// searches around it when no place is named.
    pub current_locations: Mutex<HashMap<String, crate::settings::Location>>,
}

#[derive(Clone)]
pub struct ActiveRun {
    pub run_id: String,
    pub conversation_id: String,
    pub origin: String,
    pub title: String,
    pub started_at: String,
    pub cancel: CancellationToken,
}

pub struct Core {
    pub db: Db,
    pub secrets: Secrets,
    pub http: reqwest::Client,
    pub paths: Paths,
    pub platform: Arc<dyn Platform>,
    pub pending: Pending,
    pub rate: RateLimiter,
    /// Replaces the configured provider (tests and the end-to-end harness).
    pub provider_override: Mutex<Option<Arc<dyn ModelProvider>>>,
    pub endpoints: Mutex<Endpoints>,
    pub api_bases: Mutex<crate::integrations::ApiBases>,
    /// The built-in on-device model engine (keeps the model in use loaded).
    pub local_engine: Arc<crate::model::local::engine::Engine>,
}

impl Core {
    pub fn new(db: Db, secrets: Secrets, paths: Paths, platform: Arc<dyn Platform>) -> Arc<Core> {
        let http = reqwest::Client::builder()
            .user_agent(concat!("Lumo/", env!("CARGO_PKG_VERSION"), " (+https://github.com/keplarone/lumo-assistant)"))
            .connect_timeout(std::time::Duration::from_secs(15))
            .build()
            .expect("http client");
        Arc::new(Core {
            db,
            secrets,
            http,
            paths,
            platform,
            pending: Pending::default(),
            rate: RateLimiter::default(),
            provider_override: Mutex::new(None),
            endpoints: Mutex::new(Endpoints::default()),
            api_bases: Mutex::new(Default::default()),
            local_engine: Arc::new(Default::default()),
        })
    }

    pub fn settings(&self) -> Settings {
        settings::load(&self.db).unwrap_or_default()
    }

    /// The model provider for the current settings.
    pub fn provider(&self) -> Result<Arc<dyn ModelProvider>> {
        if let Some(p) = self.provider_override.lock().clone() {
            return Ok(p);
        }
        let s = self.settings();
        // An old setting from a higher plan can't be used after a downgrade.
        crate::plans::check_model(crate::plans::limits(&s.plan), &s.provider, &s.chat_model())?;
        match s.provider.as_str() {
            "local" => {
                let choose = || {
                    crate::error::LumoError::Unavailable(
                        "Download an on-device model (Orbit, Nebula, Solar, Nova or Nebula Vision) in Settings → Model to start.".into(),
                    )
                };
                let entry = crate::local_models::catalog_entry(&s.local_model).map_err(|_| choose())?;
                if !crate::local_models::is_installed(self, entry) {
                    return Err(crate::error::LumoError::Unavailable(format!(
                        "{} isn't downloaded yet. Download it in Settings → Model to start.",
                        entry.tier
                    )));
                }
                Ok(Arc::new(crate::model::local::LocalProvider::new(
                    self.local_engine.clone(),
                    entry,
                    crate::local_models::model_path(self, entry),
                )))
            }
            "openai_compatible" => {
                let key = self.secrets.get("openai_compatible_api_key")?;
                Ok(Arc::new(crate::model::openai::OpenAiCompatible::new(
                    self.http.clone(),
                    &s.openai_base_url,
                    key,
                    s.openai_model.clone(),
                )))
            }
            _ => {
                let key = self.secrets.get("anthropic_api_key")?.ok_or_else(|| {
                    crate::error::LumoError::Unavailable("Add your Anthropic API key in Settings → Model to start.".into())
                })?;
                Ok(Arc::new(crate::model::anthropic::Anthropic::new(self.http.clone(), &s.anthropic_base_url, key)))
            }
        }
    }
}

#[cfg(test)]
pub mod testing {
    //! A fake platform and core for unit and integration tests.
    use super::*;
    use crate::secrets::MemoryStore;

    #[derive(Default)]
    pub struct FakePlatform {
        pub confirm: Mutex<bool>,
        pub confirms: Mutex<Vec<ActionPreview>>,
        pub notifications: Mutex<Vec<(String, String)>>,
        pub opened: Mutex<Vec<String>>,
        pub clipboard: Mutex<String>,
        pub picked: Mutex<Option<PathBuf>>,
        pub inputs: Mutex<Vec<crate::tools::computer::InputAction>>,
        pub control_active: Mutex<Vec<bool>>,
        pub screen: Mutex<Option<Screenshot>>,
        pub broadcasts: Mutex<Vec<(String, serde_json::Value)>>,
        /// What `current_position` returns; None means no location service.
        pub position: Mutex<Option<std::result::Result<crate::location::Fix, crate::location::FixError>>>,
        pub position_requests: Mutex<usize>,
    }

    #[async_trait]
    impl Platform for FakePlatform {
        async fn native_confirm(&self, preview: &ActionPreview) -> bool {
            self.confirms.lock().push(preview.clone());
            *self.confirm.lock()
        }
        fn notify(&self, title: &str, body: &str) -> Result<()> {
            self.notifications.lock().push((title.into(), body.into()));
            Ok(())
        }
        fn open_url(&self, url: &str) -> Result<()> {
            self.opened.lock().push(url.into());
            Ok(())
        }
        fn clipboard_read(&self) -> Result<String> {
            Ok(self.clipboard.lock().clone())
        }
        fn clipboard_write(&self, text: &str) -> Result<()> {
            *self.clipboard.lock() = text.into();
            Ok(())
        }
        async fn pick_folder(&self) -> Option<PathBuf> {
            self.picked.lock().clone()
        }
        fn capture_screen(&self) -> Result<Screenshot> {
            self.screen.lock().clone().ok_or_else(|| crate::error::LumoError::Unavailable("no screen in tests".into()))
        }
        fn perform_input(&self, actions: &[crate::tools::computer::InputAction]) -> Result<()> {
            self.inputs.lock().extend_from_slice(actions);
            Ok(())
        }
        fn input_control_changed(&self, active: bool) {
            self.control_active.lock().push(active);
        }
        fn active_window(&self) -> Result<(String, String)> {
            Ok(("Editor".into(), "notes.md".into()))
        }
        fn broadcast(&self, event: &str, payload: serde_json::Value) {
            self.broadcasts.lock().push((event.to_string(), payload));
        }
        async fn current_position(&self) -> Result<crate::location::Fix> {
            *self.position_requests.lock() += 1;
            let r = self.position.lock().clone().unwrap_or(Err(crate::location::FixError::NotSupported));
            r.map_err(|e| e.into_error(std::env::consts::OS))
        }
    }

    /// Set the plan directly, as a verified license would.
    pub fn set_plan(core: &Core, plan: &str) {
        let mut s = core.settings();
        s.plan = plan.into();
        crate::settings::save(&core.db, &s).unwrap();
    }

    pub fn core_with(platform: Arc<FakePlatform>) -> (Arc<Core>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths {
            data_dir: dir.path().join("data"),
            backups_dir: dir.path().join("data/backups"),
            log_dir: dir.path().join("logs"),
            projects_dir: dir.path().join("projects"),
        };
        std::fs::create_dir_all(&paths.backups_dir).unwrap();
        let core = Core::new(Db::memory().unwrap(), Arc::new(MemoryStore::default()), paths, platform);
        (core, dir)
    }
}
