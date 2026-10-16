//! Long-term memory the user controls. Off by default; every memory is visible and editable in
//! Settings → Memory, and can be exported or deleted.

use super::{object_schema, ToolCtx, ToolOutput, TypedTool};
use crate::core::Core;
use crate::error::{invalid, LumoError, Result};
use crate::policy::Risk;
use crate::util::{new_id, now};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryItem {
    pub id: String,
    pub content: String,
    pub category: String,
    pub source_conversation_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

pub fn list(core: &Core) -> Result<Vec<MemoryItem>> {
    let conn = core.db.conn();
    let mut st = conn
        .prepare("SELECT id, content, category, source_conversation_id, created_at, updated_at FROM memories ORDER BY updated_at DESC")?;
    let rows = st
        .query_map([], |r| {
            Ok(MemoryItem {
                id: r.get(0)?,
                content: r.get(1)?,
                category: r.get(2)?,
                source_conversation_id: r.get(3)?,
                created_at: r.get(4)?,
                updated_at: r.get(5)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn add(core: &Core, content: &str, category: &str, source: Option<&str>) -> Result<MemoryItem> {
    let content = content.trim();
    if content.is_empty() || content.len() > 1000 {
        return Err(invalid("a memory must be 1 to 1000 characters"));
    }
    let category = if ["preference", "fact", "person", "place", "general"].contains(&category) { category } else { "general" };
    let t = now();
    let m = MemoryItem {
        id: new_id(),
        content: content.into(),
        category: category.into(),
        source_conversation_id: source.map(String::from),
        created_at: t.clone(),
        updated_at: t,
    };
    core.db.conn().execute(
        "INSERT INTO memories(id, content, category, source_conversation_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![m.id, m.content, m.category, m.source_conversation_id, m.created_at, m.updated_at],
    )?;
    Ok(m)
}

pub fn update(core: &Core, id: &str, content: &str) -> Result<()> {
    let content = content.trim();
    if content.is_empty() || content.len() > 1000 {
        return Err(invalid("a memory must be 1 to 1000 characters"));
    }
    let n =
        core.db.conn().execute("UPDATE memories SET content = ?2, updated_at = ?3 WHERE id = ?1", rusqlite::params![id, content, now()])?;
    if n == 0 {
        return Err(LumoError::NotFound("memory".into()));
    }
    Ok(())
}

pub fn delete(core: &Core, id: &str) -> Result<()> {
    core.db.conn().execute("DELETE FROM memories WHERE id = ?1", [id])?;
    Ok(())
}

pub fn delete_all(core: &Core) -> Result<usize> {
    Ok(core.db.conn().execute("DELETE FROM memories", [])?)
}

/// The block added to a user turn so the model knows what the user asked it to remember.
pub fn context_block(core: &Core) -> Option<String> {
    if !core.settings().memory_enabled {
        return None;
    }
    let items = list(core).ok()?;
    if items.is_empty() {
        return None;
    }
    let lines: Vec<String> = items.iter().take(100).map(|m| format!("- [{}] {} (id {})", m.category, m.content, m.id)).collect();
    Some(format!("<memory>\nThings the user asked Lumo to remember. Use them when relevant; the user can view and delete them in Settings.\n{}\n</memory>", lines.join("\n")))
}

fn require_enabled(ctx: &ToolCtx) -> Result<()> {
    if ctx.core.settings().memory_enabled {
        Ok(())
    } else {
        Err(LumoError::Unavailable("Memory is turned off. The user can turn it on in Settings → Memory.".into()))
    }
}

pub struct Remember;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RememberInput {
    pub content: String,
    #[serde(default)]
    pub category: Option<String>,
}

#[async_trait]
impl TypedTool for Remember {
    type Input = RememberInput;
    const NAME: &'static str = "remember";
    const DESCRIPTION: &'static str = "Save a short fact or preference for future conversations, only when the user asks you to remember something or clearly states a lasting preference. Never store passwords, payment details, health or other sensitive data. Only works when the user has turned memory on.";
    fn schema(&self) -> Value {
        object_schema(
            json!({"content": {"type": "string", "maxLength": 1000}, "category": {"type": "string", "enum": ["preference", "fact", "person", "place", "general"]}}),
            &["content"],
        )
    }
    fn risk(&self, _ctx: &ToolCtx, _: &RememberInput) -> Risk {
        Risk::Ui
    }
    fn label(&self, i: &RememberInput) -> String {
        format!("Remembering \"{}\"", crate::util::preview(&i.content, 50))
    }
    async fn run(&self, ctx: &ToolCtx, i: RememberInput) -> Result<ToolOutput> {
        require_enabled(ctx)?;
        let lower = i.content.to_lowercase();
        if ["password", "passcode", "card number", "cvv", "social security", "pin code"].iter().any(|w| lower.contains(w)) {
            return Err(invalid("Lumo does not store passwords or payment details in memory."));
        }
        let m = add(&ctx.core, &i.content, i.category.as_deref().unwrap_or("general"), Some(&ctx.conversation_id))?;
        Ok(ToolOutput {
            text: format!("Saved to memory (id {}).", m.id),
            summary: format!("Remembered: {}", crate::util::preview(&m.content, 60)),
            data: Some(json!({"memoryId": m.id})),
            ..Default::default()
        })
    }
}

pub struct Forget;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ForgetInput {
    pub id: String,
}

#[async_trait]
impl TypedTool for Forget {
    type Input = ForgetInput;
    const NAME: &'static str = "forget";
    const DESCRIPTION: &'static str = "Delete a saved memory by its id when the user asks Lumo to forget something or a memory is wrong.";
    fn schema(&self) -> Value {
        object_schema(json!({"id": {"type": "string"}}), &["id"])
    }
    fn risk(&self, _ctx: &ToolCtx, _: &ForgetInput) -> Risk {
        Risk::Ui
    }
    fn label(&self, _: &ForgetInput) -> String {
        "Forgetting a memory".into()
    }
    async fn run(&self, ctx: &ToolCtx, i: ForgetInput) -> Result<ToolOutput> {
        let n = ctx.core.db.conn().execute("DELETE FROM memories WHERE id = ?1", [&i.id])?;
        if n == 0 {
            return Err(LumoError::NotFound(format!("memory {}", i.id)));
        }
        Ok(ToolOutput::text("Deleted from memory.", "Forgot a memory"))
    }
}
