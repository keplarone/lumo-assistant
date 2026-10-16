//! Projects: a folder Lumo creates for something it builds (a site, a document, code), with version
//! history (a local git repository) and a live preview served from the folder.

use super::{object_schema, ToolCtx, ToolOutput, TypedTool};
use crate::agent::events::{ActionPreview, AgentEvent};
use crate::core::Core;
use crate::error::{invalid, LumoError, Result};
use crate::policy::{self, Risk};
use crate::util::{new_id, now};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub kind: String,
    pub conversation_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    pub id: String,
    pub message: String,
    pub time: String,
}

fn row(r: &rusqlite::Row) -> rusqlite::Result<Project> {
    Ok(Project { id: r.get(0)?, name: r.get(1)?, path: r.get(2)?, kind: r.get(3)?, conversation_id: r.get(4)?, created_at: r.get(5)?, updated_at: r.get(6)? })
}

const COLS: &str = "id, name, path, kind, conversation_id, created_at, updated_at";

pub fn list(core: &Core) -> Result<Vec<Project>> {
    let conn = core.db.conn();
    let mut st = conn.prepare(&format!("SELECT {COLS} FROM projects ORDER BY updated_at DESC"))?;
    let rows = st.query_map([], row)?.collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn get(core: &Core, id: &str) -> Result<Project> {
    core.db
        .conn()
        .query_row(&format!("SELECT {COLS} FROM projects WHERE id = ?1"), [id], row)
        .map_err(|_| LumoError::NotFound("project".into()))
}

/// The project attached to this run's conversation, if any.
pub fn for_ctx(ctx: &ToolCtx) -> Result<Project> {
    if let Some(id) = &ctx.project_id {
        return get(&ctx.core, id);
    }
    let id: Option<String> = ctx
        .core
        .db
        .conn()
        .query_row("SELECT project_id FROM conversations WHERE id = ?1", [&ctx.conversation_id], |r| r.get(0))
        .ok()
        .flatten();
    match id {
        Some(id) => get(&ctx.core, &id),
        None => Err(invalid("This conversation has no project yet. Create one with create_project first.")),
    }
}

fn slug(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if s.is_empty() {
        "project".into()
    } else {
        s.chars().take(48).collect()
    }
}

fn signature() -> std::result::Result<git2::Signature<'static>, git2::Error> {
    git2::Signature::now("Lumo", "lumo@localhost")
}

/// Commit everything in the project folder. Returns None if nothing changed.
pub fn commit_all(path: &Path, message: &str) -> Result<Option<String>> {
    let repo = git2::Repository::open(path).map_err(|e| LumoError::Other(e.into()))?;
    let mut index = repo.index().map_err(|e| LumoError::Other(e.into()))?;
    index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None).map_err(|e| LumoError::Other(e.into()))?;
    index.update_all(["*"].iter(), None).map_err(|e| LumoError::Other(e.into()))?;
    index.write().map_err(|e| LumoError::Other(e.into()))?;
    let tree_id = index.write_tree().map_err(|e| LumoError::Other(e.into()))?;
    let tree = repo.find_tree(tree_id).map_err(|e| LumoError::Other(e.into()))?;
    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    if let Some(p) = &parent {
        if p.tree_id() == tree_id {
            return Ok(None);
        }
    }
    let sig = signature().map_err(|e| LumoError::Other(e.into()))?;
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    let oid = repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents).map_err(|e| LumoError::Other(e.into()))?;
    Ok(Some(oid.to_string()))
}

pub fn history(core: &Core, id: &str) -> Result<Vec<Version>> {
    let p = get(core, id)?;
    let repo = git2::Repository::open(&p.path).map_err(|e| LumoError::Other(e.into()))?;
    let mut walk = repo.revwalk().map_err(|e| LumoError::Other(e.into()))?;
    if walk.push_head().is_err() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    for oid in walk.take(200).flatten() {
        if let Ok(c) = repo.find_commit(oid) {
            let t = chrono::DateTime::from_timestamp(c.time().seconds(), 0).map(|d| d.to_rfc3339()).unwrap_or_default();
            out.push(Version { id: oid.to_string(), message: c.summary().ok().flatten().unwrap_or("").to_string(), time: t });
        }
    }
    Ok(out)
}

/// Restore the project's files to a saved version, recorded as a new version (nothing is lost).
pub fn restore(core: &Core, id: &str, version: &str) -> Result<String> {
    let p = get(core, id)?;
    // Save whatever is there first, so restoring is itself undoable.
    commit_all(Path::new(&p.path), "Before restoring an earlier version")?;
    let repo = git2::Repository::open(&p.path).map_err(|e| LumoError::Other(e.into()))?;
    let oid = git2::Oid::from_str(version).map_err(|_| invalid("unknown version"))?;
    let commit = repo.find_commit(oid).map_err(|_| invalid("unknown version"))?;
    let mut opts = git2::build::CheckoutBuilder::new();
    opts.force().remove_untracked(true);
    repo.checkout_tree(commit.as_object(), Some(&mut opts)).map_err(|e| LumoError::Other(e.into()))?;
    let msg = format!("Restored version from {}", chrono::DateTime::from_timestamp(commit.time().seconds(), 0).map(|d| d.format("%Y-%m-%d %H:%M").to_string()).unwrap_or_default());
    let new = commit_all(Path::new(&p.path), &msg)?.unwrap_or_else(|| version.to_string());
    crate::audit::record(&core.db, "user", "restore_version", Some(&p.name), Some(&json!({"version": version})), "ok");
    Ok(new)
}

pub fn create(core: &Core, name: &str, kind: &str, conversation_id: Option<&str>) -> Result<Project> {
    let name = name.trim();
    if name.is_empty() || name.len() > 80 {
        return Err(invalid("a project name must be 1 to 80 characters"));
    }
    if !["website", "document", "code", "other"].contains(&kind) {
        return Err(invalid("kind must be website, document, code or other"));
    }
    std::fs::create_dir_all(&core.paths.projects_dir)?;
    let base = slug(name);
    let mut dir = core.paths.projects_dir.join(&base);
    let mut n = 2;
    while dir.exists() {
        dir = core.paths.projects_dir.join(format!("{base}-{n}"));
        n += 1;
    }
    std::fs::create_dir_all(&dir)?;
    git2::Repository::init(&dir).map_err(|e| LumoError::Other(e.into()))?;
    let dir = std::fs::canonicalize(&dir)?;
    policy::add_folder_grant(&core.db, &dir)?;
    let t = now();
    let p = Project { id: new_id(), name: name.into(), path: dir.display().to_string(), kind: kind.into(), conversation_id: conversation_id.map(String::from), created_at: t.clone(), updated_at: t };
    {
        let conn = core.db.conn();
        conn.execute(
            &format!("INSERT INTO projects({COLS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"),
            rusqlite::params![p.id, p.name, p.path, p.kind, p.conversation_id, p.created_at, p.updated_at],
        )?;
        if let Some(c) = conversation_id {
            conn.execute("UPDATE conversations SET project_id = ?2 WHERE id = ?1", rusqlite::params![c, p.id])?;
        }
    }
    Ok(p)
}

/// Resolve a file inside a project for the preview server. Refuses anything outside the folder.
pub fn preview_file(core: &Core, id: &str, rel: &str) -> Result<(Vec<u8>, String)> {
    let p = get(core, id)?;
    let root = PathBuf::from(&p.path);
    let rel = rel.trim_start_matches('/');
    let rel = if rel.is_empty() { "index.html" } else { rel };
    let decoded = percent_decode(rel);
    if decoded.split(['/', '\\']).any(|s| s == ".." || s.starts_with(".git")) {
        return Err(LumoError::Denied("outside the project".into()));
    }
    let mut path = root.join(&decoded);
    if path.is_dir() {
        path = path.join("index.html");
    }
    let canon = std::fs::canonicalize(&path).map_err(|_| LumoError::NotFound(decoded.clone()))?;
    if !canon.starts_with(&root) {
        return Err(LumoError::Denied("outside the project".into()));
    }
    let mime = mime_guess::from_path(&canon).first_or_octet_stream().to_string();
    Ok((std::fs::read(&canon)?, mime))
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Some(v) = std::str::from_utf8(&bytes[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

// ---------------------------------------------------------------------------------------------

pub struct CreateProject;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateInput {
    pub name: String,
    pub kind: String,
}

#[async_trait]
impl TypedTool for CreateProject {
    type Input = CreateInput;
    const NAME: &'static str = "create_project";
    const DESCRIPTION: &'static str = "Create a project folder for something you are building for the user (a website, document or code), with version history and a live preview. Then write its files with write_file using paths relative to the project, save versions with save_version, and show it with preview_project.";
    fn schema(&self) -> Value {
        object_schema(json!({"name": {"type": "string"}, "kind": {"type": "string", "enum": ["website", "document", "code", "other"]}}), &["name", "kind"])
    }
    fn risk(&self, _ctx: &ToolCtx, _: &CreateInput) -> Risk {
        Risk::Write
    }
    fn label(&self, i: &CreateInput) -> String {
        format!("Creating the project {}", i.name)
    }
    fn preview(&self, ctx: &ToolCtx, i: &CreateInput) -> Result<ActionPreview> {
        Ok(ActionPreview {
            title: format!("Create the project \"{}\"", i.name),
            details: vec![("Location".into(), super::files::display(&ctx.core.paths.projects_dir.join(slug(&i.name))))],
            warning: None,
        })
    }
    async fn run(&self, ctx: &ToolCtx, i: CreateInput) -> Result<ToolOutput> {
        let p = create(&ctx.core, &i.name, &i.kind, Some(&ctx.conversation_id))?;
        ctx.core.platform.broadcast("projects-changed", json!({"id": p.id}));
        Ok(ToolOutput {
            text: format!("Created project \"{}\" at {} (id {}). Write files there with absolute paths under that folder.", p.name, p.path, p.id),
            summary: format!("Created {}", p.name),
            data: Some(json!({"projectId": p.id, "path": p.path})),
            ..Default::default()
        })
    }
}

pub struct SaveVersion;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SaveInput {
    pub message: String,
}

#[async_trait]
impl TypedTool for SaveVersion {
    type Input = SaveInput;
    const NAME: &'static str = "save_version";
    const DESCRIPTION: &'static str = "Save the current state of this conversation's project as a version the user can return to. Call it after each meaningful change, with a short description.";
    fn schema(&self) -> Value {
        object_schema(json!({"message": {"type": "string", "maxLength": 200}}), &["message"])
    }
    fn risk(&self, _ctx: &ToolCtx, _: &SaveInput) -> Risk {
        // Only records history inside a Lumo project; nothing outside it changes.
        Risk::Ui
    }
    fn label(&self, _: &SaveInput) -> String {
        "Saving a version".into()
    }
    async fn run(&self, ctx: &ToolCtx, i: SaveInput) -> Result<ToolOutput> {
        let p = for_ctx(ctx)?;
        let msg = crate::util::preview(&i.message, 200);
        let id = commit_all(Path::new(&p.path), &msg)?;
        ctx.core.db.conn().execute("UPDATE projects SET updated_at = ?2 WHERE id = ?1", rusqlite::params![p.id, now()])?;
        match id {
            Some(id) => Ok(ToolOutput::text(format!("Saved version {}.", &id[..8]), format!("Saved version: {msg}"))),
            None => Ok(ToolOutput::text("Nothing changed since the last version.", "No changes to save")),
        }
    }
}

pub struct PreviewProject;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PreviewInput {
    #[serde(default)]
    pub entry: Option<String>,
}

#[async_trait]
impl TypedTool for PreviewProject {
    type Input = PreviewInput;
    const NAME: &'static str = "preview_project";
    const DESCRIPTION: &'static str = "Open the live preview of this conversation's project next to the conversation (for websites and HTML documents). 'entry' is the page to open, default index.html.";
    fn schema(&self) -> Value {
        object_schema(json!({"entry": {"type": "string"}}), &[])
    }
    fn risk(&self, _ctx: &ToolCtx, _: &PreviewInput) -> Risk {
        Risk::Ui
    }
    fn label(&self, _: &PreviewInput) -> String {
        "Opening the preview".into()
    }
    async fn run(&self, ctx: &ToolCtx, i: PreviewInput) -> Result<ToolOutput> {
        let p = for_ctx(ctx)?;
        let entry = i.entry.unwrap_or_else(|| "index.html".into());
        // Fails now if the entry is missing, so the model can fix it.
        preview_file(&ctx.core, &p.id, &entry)?;
        ctx.sink.emit(AgentEvent::OpenPreview { project_id: p.id.clone(), url: entry.clone() });
        Ok(ToolOutput::text(format!("The preview of {entry} is open for the user."), format!("Previewing {}", p.name)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::testing::{core_with, FakePlatform};
    use std::sync::Arc;

    #[test]
    fn versions_restore_and_preview_stays_inside_the_project() {
        let (core, _d) = core_with(Arc::new(FakePlatform::default()));
        let p = create(&core, "My Site!", "website", None).unwrap();
        assert!(p.path.ends_with("my-site"));
        std::fs::write(Path::new(&p.path).join("index.html"), "<h1>v1</h1>").unwrap();
        let v1 = commit_all(Path::new(&p.path), "First").unwrap().unwrap();
        std::fs::write(Path::new(&p.path).join("index.html"), "<h1>v2</h1>").unwrap();
        commit_all(Path::new(&p.path), "Second").unwrap();
        assert_eq!(history(&core, &p.id).unwrap().len(), 2);
        restore(&core, &p.id, &v1).unwrap();
        assert_eq!(std::fs::read_to_string(Path::new(&p.path).join("index.html")).unwrap(), "<h1>v1</h1>");
        assert_eq!(history(&core, &p.id).unwrap().len(), 3, "restore adds a version instead of rewriting history");
        let (body, mime) = preview_file(&core, &p.id, "/").unwrap();
        assert_eq!(mime, "text/html");
        assert_eq!(body, b"<h1>v1</h1>");
        assert!(preview_file(&core, &p.id, "../../etc/passwd").is_err());
        assert!(preview_file(&core, &p.id, "%2e%2e/x").is_err());
        assert!(preview_file(&core, &p.id, ".git/config").is_err());
        // Its folder is granted, so file tools can write there.
        assert!(policy::folder_roots(&core.db).iter().any(|r| r.display().to_string() == p.path));
    }
}
