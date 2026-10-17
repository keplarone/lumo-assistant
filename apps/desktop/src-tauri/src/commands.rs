//! Commands the webview may call. The webview is treated as untrusted: every command validates its
//! input, nothing returns a secret, and anything with side effects outside Lumo goes through the same
//! policy as the agent (or is an explicit user action such as granting a folder via the OS picker).

use crate::agent::{
    self,
    events::{AgentEvent, EventSink},
    store, StartRequest,
};
use crate::automations::{self, AutomationInput};
use crate::core::Core;
use crate::desktop;
use crate::error::{invalid, ApiResult, LumoError};
use crate::policy;
use crate::secrets;
use crate::settings::{self, Settings};
use crate::tools::{self, journal, memory, projects, ApprovalAnswer, Registry};
use crate::util::{new_id, now};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

pub struct AppState {
    pub core: Arc<Core>,
    pub registry: Arc<Registry>,
}

/// Streams a run's events to every window.
pub struct AppSink {
    pub app: AppHandle,
    pub run_id: String,
    pub conversation_id: String,
}

impl EventSink for AppSink {
    fn emit(&self, ev: AgentEvent) {
        let _ = self.app.emit("agent-event", json!({"runId": self.run_id, "conversationId": self.conversation_id, "event": ev}));
    }
}

type S<'a> = State<'a, AppState>;

// ---- App and settings -----------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: String,
    os: String,
    keychain: Option<String>,
    data_dir: String,
    log_dir: String,
    updater_configured: bool,
    /// What this device can do (phones have no tray, shortcut, screen control or commands).
    device: crate::device::DeviceCaps,
}

#[tauri::command]
pub fn app_info(state: S) -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION").into(),
        os: std::env::consts::OS.into(),
        keychain: secrets::OsKeychain::available().err(),
        data_dir: state.core.paths.data_dir.display().to_string(),
        log_dir: state.core.paths.log_dir.display().to_string(),
        updater_configured: crate::updater_configured(),
        device: crate::device::current(),
    }
}

#[tauri::command]
pub fn get_settings(state: S) -> Settings {
    state.core.settings()
}

#[tauri::command]
pub async fn save_settings(app: AppHandle, state: S<'_>, mut settings: Settings) -> ApiResult<Settings> {
    let old = state.core.settings();
    // The plan comes only from a verified license, never from the webview.
    settings.plan = old.plan.clone();
    settings.plan_checked_at = old.plan_checked_at.clone();
    settings.validate()?;
    // A saved key is only sent to a new server after the user confirms it natively.
    settings::confirm_key_destinations(&state.core, &old, &settings).await?;
    settings::save(&state.core.db, &settings)?;
    #[cfg(desktop)]
    if old.global_shortcut != settings.global_shortcut {
        if let Err(e) = desktop::register_shortcut(&app, &settings.global_shortcut) {
            // Restore the old one so the user isn't left without a shortcut.
            let mut s = settings.clone();
            s.global_shortcut = old.global_shortcut.clone();
            settings::save(&state.core.db, &s)?;
            let _ = desktop::register_shortcut(&app, &old.global_shortcut);
            return Err(e.into());
        }
    }
    if old.memory_enabled != settings.memory_enabled {
        crate::audit::record(
            &state.core.db,
            "user",
            if settings.memory_enabled { "enable_memory" } else { "disable_memory" },
            None,
            None,
            "ok",
        );
    }
    let _ = app.emit("settings-changed", ());
    Ok(state.core.settings())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretStatus {
    name: String,
    label: String,
    set: bool,
}

#[tauri::command]
pub fn secrets_status(state: S) -> ApiResult<Vec<SecretStatus>> {
    let mut out = Vec::new();
    for (name, label) in secrets::KNOWN {
        let set = state.core.secrets.get(name).map(|v| v.is_some()).unwrap_or(false);
        out.push(SecretStatus { name: name.to_string(), label: label.to_string(), set });
    }
    Ok(out)
}

#[tauri::command]
pub fn set_secret(state: S, name: String, value: String) -> ApiResult<()> {
    secrets::check_known(&name)?;
    let v = value.trim();
    if v.is_empty() || v.len() > 8192 {
        return Err(invalid("the value is empty or too long").into());
    }
    state.core.secrets.set(&name, v)?;
    crate::audit::record(&state.core.db, "user", "set_secret", Some(&name), None, "ok");
    Ok(())
}

#[tauri::command]
pub fn delete_secret(state: S, name: String) -> ApiResult<()> {
    secrets::check_known(&name)?;
    state.core.secrets.delete(&name)?;
    crate::audit::record(&state.core.db, "user", "delete_secret", Some(&name), None, "ok");
    Ok(())
}

/// Check that Lumo's model service answers for this install and plan, without spending usage.
#[tauri::command]
pub async fn test_model_connection(state: S<'_>) -> ApiResult<String> {
    let u = crate::models::usage(&state.core).await?;
    Ok(format!("Connected. {}% of this month's usage is used.", u.percent_used))
}

/// Every plan's models, from Lumo's model gateway (cached when offline).
#[tauri::command]
pub async fn model_catalog(state: S<'_>) -> ApiResult<crate::models::Catalog> {
    Ok(crate::models::catalog(&state.core).await?)
}

// ---- Conversations and runs -----------------------------------------------------------------

#[tauri::command]
pub fn list_conversations(state: S, query: Option<String>, limit: Option<u32>) -> ApiResult<Vec<store::Conversation>> {
    Ok(store::list_conversations(&state.core, limit.unwrap_or(100).min(500), query.as_deref().filter(|q| !q.trim().is_empty()))?)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationDetail {
    conversation: store::Conversation,
    messages: Vec<store::StoredMessage>,
    runs: Vec<store::RunRecord>,
    tool_calls: Vec<Value>,
}

#[tauri::command]
pub fn get_conversation(state: S, id: String) -> ApiResult<ConversationDetail> {
    let conversation = store::get_conversation(&state.core, &id)?;
    let messages = store::messages(&state.core, &id)?;
    let runs: Vec<store::RunRecord> = store::list_runs(&state.core, 1000)?.into_iter().filter(|r| r.conversation_id == id).collect();
    let tool_calls = {
        let conn = state.core.db.conn();
        let mut st = conn.prepare(
            "SELECT t.id, t.run_id, t.name, t.risk, t.status, t.output_text, t.approval, t.started_at FROM tool_calls t JOIN runs r ON r.id = t.run_id WHERE r.conversation_id = ?1 ORDER BY t.started_at",
        ).map_err(LumoError::from)?;
        let rows = st
            .query_map([&id], |r| {
                Ok(json!({"id": r.get::<_, String>(0)?, "runId": r.get::<_, String>(1)?, "name": r.get::<_, String>(2)?, "risk": r.get::<_, String>(3)?,
                          "status": r.get::<_, String>(4)?, "summary": r.get::<_, Option<String>>(5)?, "approval": r.get::<_, Option<String>>(6)?, "startedAt": r.get::<_, String>(7)?}))
            })
            .map_err(LumoError::from)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(LumoError::from)?;
        rows
    };
    Ok(ConversationDetail { conversation, messages, runs, tool_calls })
}

#[tauri::command]
pub fn rename_conversation(state: S, id: String, title: String) -> ApiResult<()> {
    Ok(store::rename_conversation(&state.core, &id, &title)?)
}

#[tauri::command]
pub fn delete_conversation(state: S, id: String) -> ApiResult<()> {
    if state.core.pending.runs.lock().values().any(|r| r.conversation_id == id) {
        return Err(invalid("Stop the task in this conversation first.").into());
    }
    store::delete_conversation(&state.core, &id)?;
    crate::audit::record(&state.core.db, "user", "delete_conversation", Some(&id), None, "ok");
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    run_id: String,
    conversation_id: String,
}

#[tauri::command]
pub fn start_run(app: AppHandle, state: S, request: StartRequest) -> ApiResult<Started> {
    let spec = agent::prepare(&state.core, &state.registry, &request, tools::Origin::User, vec![])?;
    let started = Started { run_id: spec.run_id.clone(), conversation_id: spec.conversation_id.clone() };
    let sink = Arc::new(AppSink { app: app.clone(), run_id: spec.run_id.clone(), conversation_id: spec.conversation_id.clone() });
    let (core, registry) = (state.core.clone(), state.registry.clone());
    tauri::async_runtime::spawn(async move {
        let out = agent::drive(core, registry, spec, sink).await;
        let _ = app.emit("runs-changed", json!({"status": out.status}));
    });
    Ok(started)
}

#[tauri::command]
pub fn cancel_run(state: S, run_id: String) -> bool {
    agent::cancel(&state.core, &run_id)
}

#[tauri::command]
pub fn stop_all_runs(state: S) -> usize {
    let runs = state.core.pending.runs.lock();
    for r in runs.values() {
        r.cancel.cancel();
    }
    runs.len()
}

#[tauri::command]
pub fn resolve_approval(state: S, approval_id: String, answer: String) -> ApiResult<bool> {
    let a = match answer.as_str() {
        "deny" => ApprovalAnswer::Deny,
        "once" => ApprovalAnswer::Once,
        "conversation" => ApprovalAnswer::Conversation,
        _ => return Err(invalid("answer must be deny, once or conversation").into()),
    };
    Ok(tools::resolve_approval(&state.core, &approval_id, a))
}

#[tauri::command]
pub fn answer_question(state: S, question_id: String, answer: String) -> bool {
    tools::ui::answer_question(&state.core, &question_id, &answer)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveRunInfo {
    run_id: String,
    conversation_id: String,
    origin: String,
    title: String,
    started_at: String,
}

#[tauri::command]
pub fn list_active_runs(state: S) -> Vec<ActiveRunInfo> {
    state
        .core
        .pending
        .runs
        .lock()
        .values()
        .map(|r| ActiveRunInfo {
            run_id: r.run_id.clone(),
            conversation_id: r.conversation_id.clone(),
            origin: r.origin.clone(),
            title: r.title.clone(),
            started_at: r.started_at.clone(),
        })
        .collect()
}

#[tauri::command]
pub fn list_runs(state: S, limit: Option<u32>) -> ApiResult<Vec<store::RunRecord>> {
    Ok(store::list_runs(&state.core, limit.unwrap_or(50).min(500))?)
}

// ---- Attachments ----------------------------------------------------------------------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentInfo {
    token: String,
    name: String,
    bytes: u64,
    kind: String,
}

pub fn register_attachment(core: &Core, path: &Path) -> Option<AttachmentInfo> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let token = new_id();
    core.pending.attachments.lock().insert(token.clone(), path.to_path_buf());
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    let kind = if mime.type_() == "image" {
        "image"
    } else if mime.essence_str() == "application/pdf" {
        "pdf"
    } else {
        "file"
    };
    Some(AttachmentInfo { token, name: path.file_name()?.to_string_lossy().to_string(), bytes: meta.len(), kind: kind.into() })
}

/// Pick files with the native dialog. The webview only ever sees tokens and names.
#[tauri::command]
pub async fn attach_files(app: AppHandle, state: S<'_>) -> ApiResult<Vec<AttachmentInfo>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().set_title("Attach files").pick_files(move |files| {
        let _ = tx.send(files.unwrap_or_default());
    });
    let files = rx.await.unwrap_or_default();
    Ok(files.into_iter().filter_map(|f| f.into_path().ok()).filter_map(|p| register_attachment(&state.core, &p)).collect())
}

// ---- Permissions ----------------------------------------------------------------------------

#[tauri::command]
pub fn list_grants(state: S) -> ApiResult<Vec<policy::Grant>> {
    Ok(policy::list_grants(&state.core.db)?)
}

#[tauri::command]
pub fn list_capabilities() -> Vec<(String, String)> {
    policy::CAPABILITIES.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()
}

/// Grant a folder chosen in the native picker.
#[tauri::command]
pub async fn grant_folder(state: S<'_>) -> ApiResult<Option<policy::Grant>> {
    let Some(p) = state.core.platform.pick_folder().await else { return Ok(None) };
    let g = policy::add_folder_grant(&state.core.db, &p)?;
    crate::audit::record(&state.core.db, "user", "grant_folder", Some(&g.target), None, "ok");
    Ok(Some(g))
}

#[tauri::command]
pub async fn grant_capability(state: S<'_>, capability: String) -> ApiResult<policy::Grant> {
    // Standing permissions lower what later runs must ask for, so they need the native dialog.
    let preview = crate::agent::events::ActionPreview {
        title: format!("Give Lumo standing permission: {capability}"),
        details: vec![("Permission".into(), capability.clone())],
        warning: Some("Lumo will use this without asking each time. You can revoke it in Settings.".into()),
    };
    if !state.core.platform.native_confirm(&preview).await {
        return Err(LumoError::Denied("Permission not granted.".into()).into());
    }
    let g = policy::add_capability_grant(&state.core.db, &capability)?;
    crate::audit::record(&state.core.db, "user", "grant_capability", Some(&capability), None, "ok");
    Ok(g)
}

#[tauri::command]
pub fn revoke_grant(state: S, id: String) -> ApiResult<()> {
    policy::revoke(&state.core.db, &id)?;
    crate::audit::record(&state.core.db, "user", "revoke_grant", Some(&id), None, "ok");
    Ok(())
}

// ---- File changes ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_changes(state: S, run_id: Option<String>, limit: Option<u32>) -> ApiResult<Vec<journal::JournalEntry>> {
    Ok(journal::list(&state.core, run_id.as_deref(), limit.unwrap_or(200).min(2000))?)
}

#[tauri::command]
pub fn undo_run(state: S, run_id: String) -> ApiResult<journal::UndoReport> {
    Ok(journal::undo_run(&state.core, &run_id)?)
}

// ---- Memory ---------------------------------------------------------------------------------

#[tauri::command]
pub fn list_memories(state: S) -> ApiResult<Vec<memory::MemoryItem>> {
    Ok(memory::list(&state.core)?)
}

#[tauri::command]
pub fn add_memory(state: S, content: String, category: Option<String>) -> ApiResult<memory::MemoryItem> {
    Ok(memory::add(&state.core, &content, category.as_deref().unwrap_or("general"), None)?)
}

#[tauri::command]
pub fn update_memory(state: S, id: String, content: String) -> ApiResult<()> {
    Ok(memory::update(&state.core, &id, &content)?)
}

#[tauri::command]
pub fn delete_memory(state: S, id: String) -> ApiResult<()> {
    Ok(memory::delete(&state.core, &id)?)
}

#[tauri::command]
pub fn delete_all_memories(state: S) -> ApiResult<usize> {
    let n = memory::delete_all(&state.core)?;
    crate::audit::record(&state.core.db, "user", "delete_all_memories", None, Some(&json!({"count": n})), "ok");
    Ok(n)
}

/// Export memories as JSON to a file the user chooses.
#[tauri::command]
pub async fn export_memories(app: AppHandle, state: S<'_>) -> ApiResult<Option<String>> {
    let items = memory::list(&state.core)?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().set_file_name("lumo-memories.json").add_filter("JSON", &["json"]).save_file(move |p| {
        let _ = tx.send(p);
    });
    let Some(path) = rx.await.ok().flatten().and_then(|p| p.into_path().ok()) else { return Ok(None) };
    std::fs::write(&path, serde_json::to_string_pretty(&json!({"exportedAt": now(), "memories": items})).map_err(LumoError::from)?)
        .map_err(LumoError::from)?;
    Ok(Some(path.display().to_string()))
}

/// Export a conversation as Markdown to a file the user chooses.
#[tauri::command]
pub async fn export_conversation(app: AppHandle, state: S<'_>, id: String) -> ApiResult<Option<String>> {
    let c = store::get_conversation(&state.core, &id)?;
    let mut md = format!("# {}\n\n", c.title);
    for m in store::messages(&state.core, &id)? {
        for b in &m.content {
            if b["type"] == "text" {
                let t = b["text"].as_str().unwrap_or("");
                if t.starts_with("<context>") {
                    continue;
                }
                md.push_str(&format!("**{}:** {}\n\n", if m.role == "user" { "You" } else { "Lumo" }, t));
            }
        }
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    let name: String = c.title.chars().filter(|ch| ch.is_alphanumeric() || *ch == ' ').collect();
    app.dialog().file().set_file_name(format!("{}.md", name.trim())).add_filter("Markdown", &["md"]).save_file(move |p| {
        let _ = tx.send(p);
    });
    let Some(path) = rx.await.ok().flatten().and_then(|p| p.into_path().ok()) else { return Ok(None) };
    std::fs::write(&path, md).map_err(LumoError::from)?;
    Ok(Some(path.display().to_string()))
}

// ---- Automations and agents -----------------------------------------------------------------

#[tauri::command]
pub fn list_automations(state: S) -> ApiResult<Vec<automations::Automation>> {
    Ok(automations::list(&state.core)?)
}

#[tauri::command]
pub fn save_automation(state: S, id: Option<String>, input: AutomationInput) -> ApiResult<automations::Automation> {
    Ok(automations::save(&state.core, id.as_deref(), &input)?)
}

#[tauri::command]
pub fn delete_automation(state: S, id: String) -> ApiResult<()> {
    Ok(automations::delete(&state.core, &id)?)
}

#[tauri::command]
pub fn run_automation(state: S, id: String) -> ApiResult<()> {
    automations::get(&state.core, &id)?;
    let (core, registry) = (state.core.clone(), state.registry.clone());
    tauri::async_runtime::spawn(async move {
        if let Err(e) = automations::run_now(core, registry, &id).await {
            log::warn!("automation failed: {e}");
        }
    });
    Ok(())
}

#[tauri::command]
pub fn list_automation_runs(state: S, id: String) -> ApiResult<Vec<automations::AutomationRun>> {
    Ok(automations::runs(&state.core, &id, 50)?)
}

#[tauri::command]
pub fn allowable_automation_tools() -> Vec<&'static str> {
    automations::ALLOWABLE_WRITE_TOOLS.to_vec()
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDef {
    #[serde(default)]
    id: Option<String>,
    name: String,
    #[serde(default)]
    description: String,
    instructions: String,
    #[serde(default)]
    tools: Vec<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
}

#[tauri::command]
pub fn list_agents(state: S) -> ApiResult<Vec<AgentDef>> {
    let conn = state.core.db.conn();
    let mut st = conn
        .prepare("SELECT id, name, description, instructions, tools_json, model, updated_at FROM agents ORDER BY name")
        .map_err(LumoError::from)?;
    let rows = st
        .query_map([], |r| {
            Ok(AgentDef {
                id: r.get(0)?,
                name: r.get(1)?,
                description: r.get(2)?,
                instructions: r.get(3)?,
                tools: serde_json::from_str(&r.get::<_, String>(4)?).unwrap_or_default(),
                model: r.get(5)?,
                updated_at: r.get(6)?,
            })
        })
        .map_err(LumoError::from)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(LumoError::from)?;
    Ok(rows)
}

#[tauri::command]
pub fn save_agent(state: S, agent: AgentDef) -> ApiResult<String> {
    if agent.name.trim().is_empty() || agent.name.len() > 60 {
        return Err(invalid("a name must be 1 to 60 characters").into());
    }
    if agent.instructions.len() > 20_000 {
        return Err(invalid("instructions are too long").into());
    }
    let known = state.registry.names();
    if let Some(t) = agent.tools.iter().find(|t| !known.contains(&t.as_str())) {
        return Err(invalid(format!("unknown tool {t}")).into());
    }
    if let Some(m) = &agent.model {
        // An OpenRouter model id; the gateway refuses models the plan doesn't include.
        if m.len() > 100 || !m.contains('/') || !m.chars().all(|c| c.is_ascii_alphanumeric() || "/._:-".contains(c)) {
            return Err(invalid("unknown model").into());
        }
    }
    let id = agent.id.clone().unwrap_or_else(new_id);
    let t = now();
    state.core.db.conn().execute(
        "INSERT INTO agents(id, name, description, instructions, tools_json, model, builtin, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?7)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, instructions = excluded.instructions, tools_json = excluded.tools_json, model = excluded.model, updated_at = excluded.updated_at",
        rusqlite::params![id, agent.name.trim(), agent.description.trim(), agent.instructions.trim(), serde_json::to_string(&agent.tools).map_err(LumoError::from)?, agent.model, t],
    ).map_err(LumoError::from)?;
    Ok(id)
}

#[tauri::command]
pub fn delete_agent(state: S, id: String) -> ApiResult<()> {
    state.core.db.conn().execute("DELETE FROM agents WHERE id = ?1", [&id]).map_err(LumoError::from)?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInfo {
    name: String,
    description: String,
}

#[tauri::command]
pub fn list_tools(state: S) -> Vec<ToolInfo> {
    state.registry.defs(None).into_iter().map(|d| ToolInfo { name: d.name, description: d.description }).collect()
}

// ---- Projects -------------------------------------------------------------------------------

#[tauri::command]
pub fn list_projects(state: S) -> ApiResult<Vec<projects::Project>> {
    Ok(projects::list(&state.core)?)
}

#[tauri::command]
pub fn create_project(state: S, name: String, kind: String) -> ApiResult<projects::Project> {
    let p = projects::create(&state.core, &name, &kind, None)?;
    projects::commit_all(Path::new(&p.path), "Created project").ok();
    Ok(p)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileNode {
    path: String,
    kind: String,
    bytes: Option<u64>,
}

#[tauri::command]
pub fn project_files(state: S, id: String) -> ApiResult<Vec<FileNode>> {
    let p = projects::get(&state.core, &id)?;
    let root = Path::new(&p.path);
    let mut out = Vec::new();
    for e in walkdir::WalkDir::new(root).min_depth(1).max_depth(8).sort_by_file_name().into_iter().filter_entry(|e| {
        let n = e.file_name().to_string_lossy();
        n != ".git" && n != "node_modules"
    }) {
        let Ok(e) = e else { continue };
        if out.len() > 2000 {
            break;
        }
        let rel = e.path().strip_prefix(root).unwrap_or(e.path()).to_string_lossy().replace('\\', "/");
        let is_dir = e.file_type().is_dir();
        out.push(FileNode {
            path: rel,
            kind: if is_dir { "folder".into() } else { "file".into() },
            bytes: if is_dir { None } else { e.metadata().ok().map(|m| m.len()) },
        });
    }
    Ok(out)
}

fn project_path(core: &Core, id: &str, rel: &str) -> ApiResult<std::path::PathBuf> {
    let p = projects::get(core, id)?;
    if rel.split(['/', '\\']).any(|s| s == ".." || s == ".git") || Path::new(rel).is_absolute() {
        return Err(invalid("that path is outside the project").into());
    }
    // Resolves symlinks, so a link inside the project cannot point the editor elsewhere.
    Ok(policy::resolve_in_grants(&[std::path::PathBuf::from(&p.path)], rel)?)
}

#[tauri::command]
pub fn read_project_file(state: S, id: String, path: String) -> ApiResult<String> {
    let full = project_path(&state.core, &id, &path)?;
    if std::fs::metadata(&full).map_err(LumoError::from)?.len() > 5 * 1024 * 1024 {
        return Err(invalid("this file is too large to edit here").into());
    }
    Ok(String::from_utf8(std::fs::read(&full).map_err(LumoError::from)?).map_err(|_| invalid("this isn't a text file"))?)
}

/// The user's own edit from the code editor.
#[tauri::command]
pub fn write_project_file(state: S, id: String, path: String, content: String) -> ApiResult<()> {
    let full = project_path(&state.core, &id, &path)?;
    if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent).map_err(LumoError::from)?;
    }
    std::fs::write(&full, content).map_err(LumoError::from)?;
    Ok(())
}

#[tauri::command]
pub fn project_history(state: S, id: String) -> ApiResult<Vec<projects::Version>> {
    Ok(projects::history(&state.core, &id)?)
}

#[tauri::command]
pub fn save_project_version(state: S, id: String, message: String) -> ApiResult<Option<String>> {
    let p = projects::get(&state.core, &id)?;
    Ok(projects::commit_all(Path::new(&p.path), message.trim().chars().take(200).collect::<String>().as_str())?)
}

#[tauri::command]
pub fn restore_project_version(state: S, id: String, version: String) -> ApiResult<String> {
    Ok(projects::restore(&state.core, &id, &version)?)
}

#[tauri::command]
pub fn reveal_project(app: AppHandle, state: S, id: String) -> ApiResult<()> {
    let p = projects::get(&state.core, &id)?;
    app.opener().reveal_item_in_dir(&p.path).map_err(|e| LumoError::Unavailable(e.to_string()))?;
    Ok(())
}

// ---- Audit, logs, windows -------------------------------------------------------------------

#[tauri::command]
pub fn list_audit(state: S, limit: Option<u32>, before_id: Option<i64>) -> ApiResult<Vec<crate::audit::AuditEntry>> {
    Ok(crate::audit::list(&state.core.db, limit.unwrap_or(100).min(1000), before_id)?)
}

#[tauri::command]
pub fn open_logs(app: AppHandle, state: S) -> ApiResult<()> {
    app.opener()
        .open_path(state.core.paths.log_dir.display().to_string(), None::<&str>)
        .map_err(|e| LumoError::Unavailable(e.to_string()))?;
    Ok(())
}

#[tauri::command]
pub fn show_main_window(app: AppHandle) {
    desktop::show_main(&app);
}

#[tauri::command]
pub fn toggle_compact_window(app: AppHandle) {
    // Phones have no floating window; the app itself is always one tap away.
    #[cfg(desktop)]
    desktop::toggle_compact(&app);
    #[cfg(mobile)]
    let _ = app;
}

#[cfg(mobile)]
#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> ApiResult<Option<String>> {
    let _ = app;
    Err(LumoError::Unavailable("On a phone, Lumo is updated by your app store.".into()).into())
}

#[cfg(desktop)]
#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> ApiResult<Option<String>> {
    if !crate::updater_configured() {
        return Err(LumoError::Unavailable(
            "Automatic updates aren't set up for this build. Download new versions from the Lumo website.".into(),
        )
        .into());
    }
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| LumoError::Unavailable(e.to_string()))?;
    match updater.check().await {
        Ok(Some(u)) => Ok(Some(u.version.clone())),
        Ok(None) => Ok(None),
        Err(e) => Err(LumoError::Unavailable(format!("Could not check for updates: {e}")).into()),
    }
}

#[cfg(mobile)]
#[tauri::command]
pub async fn install_update(app: AppHandle) -> ApiResult<()> {
    let _ = app;
    Err(LumoError::Unavailable("On a phone, Lumo is updated by your app store.".into()).into())
}

#[cfg(desktop)]
#[tauri::command]
pub async fn install_update(app: AppHandle) -> ApiResult<()> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| LumoError::Unavailable(e.to_string()))?;
    let Some(u) = updater.check().await.map_err(|e| LumoError::Unavailable(e.to_string()))? else { return Ok(()) };
    u.download_and_install(|_, _| {}, || {}).await.map_err(|e| LumoError::Unavailable(format!("The update failed to install: {e}")))?;
    app.restart();
}

// ---- Integrations ---------------------------------------------------------------------------

#[tauri::command]
pub fn integrations_status(state: S) -> Vec<crate::integrations::IntegrationStatus> {
    crate::integrations::status(&state.core)
}

#[tauri::command]
pub async fn verify_integration(state: S<'_>, id: String) -> ApiResult<String> {
    Ok(crate::integrations::verify(&state.core, &id).await?)
}

#[tauri::command]
pub fn disconnect_integration(state: S, id: String) -> ApiResult<()> {
    Ok(crate::integrations::disconnect(&state.core, &id)?)
}

// ---- Voice ----------------------------------------------------------------------------------

#[tauri::command]
pub async fn transcribe_audio(app: AppHandle, state: S<'_>, audio_base64: String, mime_type: String) -> ApiResult<String> {
    let _ = app.emit("privacy", json!({"kind": "microphone", "detail": "Sending your recording for transcription"}));
    Ok(crate::voice::transcribe(&state.core, &audio_base64, &mime_type).await?)
}

// ---- Plans and licenses (Whop) --------------------------------------------------------------

#[tauri::command]
pub fn license_status(state: S) -> crate::license::LicenseStatus {
    crate::license::status(&state.core)
}

#[tauri::command]
pub async fn activate_license(state: S<'_>, license_key: String) -> ApiResult<crate::license::LicenseStatus> {
    Ok(crate::license::activate(&state.core, crate::license::server(), &license_key).await?)
}

#[tauri::command]
pub fn remove_license(state: S) -> ApiResult<crate::license::LicenseStatus> {
    Ok(crate::license::deactivate(&state.core)?)
}

/// This month's model usage and what every plan includes. Display only: model use is enforced by
/// Lumo's model gateway, everything else in the core (see plans.rs).
#[tauri::command]
pub async fn plan_usage(state: S<'_>) -> ApiResult<crate::plans::PlanUsage> {
    Ok(crate::plans::usage(&state.core).await)
}

// ---- Location -------------------------------------------------------------------------------

/// "Use my current location" in Settings: confirm natively, ask the operating system for one fix,
/// round it, name it with OpenStreetMap and save it as the default location.
#[tauri::command]
pub async fn detect_location(app: AppHandle, state: S<'_>) -> ApiResult<settings::Location> {
    // The webview is untrusted, so the request is confirmed outside it, as the agent tool is.
    if !state.core.platform.native_confirm(&crate::location::confirm_preview()).await {
        return Err(LumoError::Denied("Location not shared.".into()).into());
    }
    let _ = app.emit("privacy", json!({"kind": "location", "detail": "Lumo checked your location"}));
    let loc = match crate::location::detect(&state.core).await {
        Ok(l) => l,
        Err(e) => {
            crate::audit::record(&state.core.db, "user", "detect_location", None, None, "error");
            return Err(e.into());
        }
    };
    let mut s = state.core.settings();
    s.location = Some(loc.clone());
    settings::save(&state.core.db, &s)?;
    crate::audit::record(&state.core.db, "user", "detect_location", Some(&loc.label), None, "ok");
    let _ = app.emit("settings-changed", ());
    Ok(loc)
}

/// Open a link in the default browser. Only https links are allowed, so the webview cannot launch
/// local files or other URL schemes.
#[tauri::command]
pub fn open_external_url(state: S, url: String) -> ApiResult<()> {
    let parsed = url::Url::parse(&url).map_err(|_| invalid("not a valid link"))?;
    if parsed.scheme() != "https" || parsed.host_str().is_none() {
        return Err(invalid("only https links can be opened").into());
    }
    Ok(state.core.platform.open_url(parsed.as_str())?)
}
