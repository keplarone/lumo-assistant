//! Persistence for conversations, messages and runs. History is append-only: a message row is never
//! edited after the model has seen it.

use crate::core::Core;
use crate::error::{LumoError, Result};
use crate::model::Message;
use crate::util::{new_id, now};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FrozenTools {
    pub client: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub agent_id: Option<String>,
    pub provider: String,
    pub model: String,
    #[serde(skip)]
    pub system_prompt: String,
    #[serde(skip)]
    pub tools: FrozenTools,
    pub project_id: Option<String>,
    pub origin: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredMessage {
    pub id: String,
    pub seq: i64,
    pub role: String,
    pub content: Vec<Value>,
    pub run_id: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    pub id: String,
    pub conversation_id: String,
    pub origin: String,
    pub status: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub error: Option<String>,
    pub summary: Option<String>,
    pub plan: Option<Value>,
    pub title: Option<String>,
}

const CONV_COLS: &str = "id, title, agent_id, provider, model, system_prompt, tools_json, project_id, origin, created_at, updated_at";

fn conv_row(r: &rusqlite::Row) -> rusqlite::Result<Conversation> {
    let tools_json: String = r.get(6)?;
    Ok(Conversation {
        id: r.get(0)?,
        title: r.get(1)?,
        agent_id: r.get(2)?,
        provider: r.get(3)?,
        model: r.get(4)?,
        system_prompt: r.get(5)?,
        tools: serde_json::from_str(&tools_json).unwrap_or(FrozenTools { client: vec![] }),
        project_id: r.get(7)?,
        origin: r.get(8)?,
        created_at: r.get(9)?,
        updated_at: r.get(10)?,
    })
}

#[allow(clippy::too_many_arguments)]
pub fn create_conversation(
    core: &Core,
    title: &str,
    agent_id: Option<&str>,
    provider: &str,
    model: &str,
    system_prompt: &str,
    tools: &FrozenTools,
    project_id: Option<&str>,
    origin: &str,
) -> Result<Conversation> {
    let t = now();
    let c = Conversation {
        id: new_id(),
        title: crate::util::preview(title, 70),
        agent_id: agent_id.map(String::from),
        provider: provider.into(),
        model: model.into(),
        system_prompt: system_prompt.into(),
        tools: tools.clone(),
        project_id: project_id.map(String::from),
        origin: origin.into(),
        created_at: t.clone(),
        updated_at: t,
    };
    core.db.conn().execute(
        &format!("INSERT INTO conversations({CONV_COLS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)"),
        rusqlite::params![
            c.id,
            c.title,
            c.agent_id,
            c.provider,
            c.model,
            c.system_prompt,
            serde_json::to_string(&c.tools)?,
            c.project_id,
            c.origin,
            c.created_at,
            c.updated_at
        ],
    )?;
    Ok(c)
}

pub fn get_conversation(core: &Core, id: &str) -> Result<Conversation> {
    core.db
        .conn()
        .query_row(&format!("SELECT {CONV_COLS} FROM conversations WHERE id = ?1"), [id], conv_row)
        .map_err(|_| LumoError::NotFound("conversation".into()))
}

pub fn list_conversations(core: &Core, limit: u32, query: Option<&str>) -> Result<Vec<Conversation>> {
    let conn = core.db.conn();
    let like = query.map(|q| format!("%{}%", q.replace('%', "")));
    let mut st = conn.prepare(&format!(
        "SELECT {CONV_COLS} FROM conversations c WHERE (?1 IS NULL OR c.title LIKE ?1 OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.content_json LIKE ?1)) ORDER BY updated_at DESC LIMIT ?2"
    ))?;
    let rows = st.query_map(rusqlite::params![like, limit], conv_row)?.collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn rename_conversation(core: &Core, id: &str, title: &str) -> Result<()> {
    let t = title.trim();
    if t.is_empty() || t.len() > 200 {
        return Err(crate::error::invalid("a title must be 1 to 200 characters"));
    }
    core.db.conn().execute("UPDATE conversations SET title = ?2 WHERE id = ?1", rusqlite::params![id, t])?;
    Ok(())
}

pub fn delete_conversation(core: &Core, id: &str) -> Result<()> {
    core.db.conn().execute("DELETE FROM conversations WHERE id = ?1", [id])?;
    core.pending.conversation_allow.lock().remove(id);
    Ok(())
}

pub fn messages(core: &Core, conversation_id: &str) -> Result<Vec<StoredMessage>> {
    let conn = core.db.conn();
    let mut st =
        conn.prepare("SELECT id, seq, role, content_json, run_id, created_at FROM messages WHERE conversation_id = ?1 ORDER BY seq")?;
    let rows = st
        .query_map([conversation_id], |r| {
            let raw: String = r.get(3)?;
            Ok(StoredMessage {
                id: r.get(0)?,
                seq: r.get(1)?,
                role: r.get(2)?,
                content: serde_json::from_str(&raw).unwrap_or_default(),
                run_id: r.get(4)?,
                created_at: r.get(5)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// History in the shape the model gateway expects.
pub fn history(core: &Core, conversation_id: &str) -> Result<Vec<Message>> {
    Ok(messages(core, conversation_id)?.into_iter().map(|m| Message { role: m.role, content: m.content }).collect())
}

/// Append a message. A user message that follows another user message (a run that failed before
/// the model answered) is merged into it, because the API expects alternating turns and that
/// earlier message never received a response.
pub fn append(core: &Core, conversation_id: &str, role: &str, content: &[Value], run_id: Option<&str>) -> Result<String> {
    let conn = core.db.conn();
    let last: Option<(String, String, String)> = conn
        .query_row(
            "SELECT id, role, content_json FROM messages WHERE conversation_id = ?1 ORDER BY seq DESC LIMIT 1",
            [conversation_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .ok();
    let t = now();
    if role == "user" {
        if let Some((id, last_role, raw)) = &last {
            if last_role == "user" {
                let mut merged: Vec<Value> = serde_json::from_str(raw).unwrap_or_default();
                merged.extend_from_slice(content);
                conn.execute(
                    "UPDATE messages SET content_json = ?2 WHERE id = ?1",
                    rusqlite::params![id, serde_json::to_string(&merged)?],
                )?;
                conn.execute("UPDATE conversations SET updated_at = ?2 WHERE id = ?1", rusqlite::params![conversation_id, t])?;
                return Ok(id.clone());
            }
        }
    }
    let id = new_id();
    conn.execute(
        "INSERT INTO messages(id, conversation_id, seq, role, content_json, run_id, created_at) VALUES (?1, ?2, (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE conversation_id = ?2), ?3, ?4, ?5, ?6)",
        rusqlite::params![id, conversation_id, role, serde_json::to_string(content)?, run_id, t],
    )?;
    conn.execute("UPDATE conversations SET updated_at = ?2 WHERE id = ?1", rusqlite::params![conversation_id, t])?;
    Ok(id)
}

pub fn create_run(core: &Core, run_id: &str, conversation_id: &str, origin: &str) -> Result<()> {
    core.db.conn().execute(
        "INSERT INTO runs(id, conversation_id, origin, status, started_at) VALUES (?1, ?2, ?3, 'running', ?4)",
        rusqlite::params![run_id, conversation_id, origin, now()],
    )?;
    Ok(())
}

pub fn finish_run(
    core: &Core,
    run_id: &str,
    status: &str,
    summary: Option<&str>,
    error: Option<&str>,
    usage: &crate::model::Usage,
) -> Result<()> {
    core.db.conn().execute(
        "UPDATE runs SET status = ?2, summary = ?3, error = ?4, finished_at = ?5, usage_json = ?6 WHERE id = ?1",
        rusqlite::params![run_id, status, summary, error, now(), serde_json::to_string(usage)?],
    )?;
    Ok(())
}

/// Runs that were still marked running when the app last exited.
pub fn mark_interrupted(core: &Core) -> Result<usize> {
    Ok(core.db.conn().execute(
        "UPDATE runs SET status = 'interrupted', finished_at = ?1, error = 'Lumo was closed while this task was running.' WHERE status = 'running'",
        [now()],
    )?)
}

pub fn list_runs(core: &Core, limit: u32) -> Result<Vec<RunRecord>> {
    let conn = core.db.conn();
    let mut st = conn.prepare(
        "SELECT r.id, r.conversation_id, r.origin, r.status, r.started_at, r.finished_at, r.error, r.summary, r.plan_json, c.title FROM runs r LEFT JOIN conversations c ON c.id = r.conversation_id ORDER BY r.started_at DESC LIMIT ?1",
    )?;
    let rows = st
        .query_map([limit], |r| {
            Ok(RunRecord {
                id: r.get(0)?,
                conversation_id: r.get(1)?,
                origin: r.get(2)?,
                status: r.get(3)?,
                started_at: r.get(4)?,
                finished_at: r.get(5)?,
                error: r.get(6)?,
                summary: r.get(7)?,
                plan: r.get::<_, Option<String>>(8)?.and_then(|s| serde_json::from_str(&s).ok()),
                title: r.get(9)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Delete conversations older than the retention setting.
pub fn apply_retention(core: &Core) -> Result<usize> {
    let Some(days) = core.settings().retention_days else { return Ok(0) };
    let cutoff = (chrono::Utc::now() - chrono::Duration::days(days as i64)).to_rfc3339();
    Ok(core.db.conn().execute("DELETE FROM conversations WHERE updated_at < ?1", [cutoff])?)
}
