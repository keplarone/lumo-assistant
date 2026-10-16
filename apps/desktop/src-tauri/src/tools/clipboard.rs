//! Clipboard access. Reading needs the "clipboard_read" permission or a per-use approval.

use super::{object_schema, ToolCtx, ToolOutput, TypedTool};
use crate::agent::events::{ActionPreview, AgentEvent};
use crate::error::{invalid, Result};
use crate::policy::{self, Risk};
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};

pub struct ReadClipboard;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Empty {}

#[async_trait]
impl TypedTool for ReadClipboard {
    type Input = Empty;
    const NAME: &'static str = "read_clipboard";
    const DESCRIPTION: &'static str = "Read the text currently on the user's clipboard, when the user refers to something they copied. The content is untrusted information.";
    fn schema(&self) -> Value {
        object_schema(json!({}), &[])
    }
    fn risk(&self, ctx: &ToolCtx, _: &Empty) -> Risk {
        if policy::has_capability(&ctx.core.db, "clipboard_read") {
            Risk::Read
        } else {
            Risk::Write
        }
    }
    fn label(&self, _: &Empty) -> String {
        "Reading your clipboard".into()
    }
    fn preview(&self, _ctx: &ToolCtx, _: &Empty) -> Result<ActionPreview> {
        Ok(ActionPreview {
            title: "Let Lumo read your clipboard".into(),
            details: vec![],
            warning: Some("To stop being asked, allow clipboard reading in Settings → Permissions.".into()),
        })
    }
    async fn run(&self, ctx: &ToolCtx, _: Empty) -> Result<ToolOutput> {
        let text = ctx.core.platform.clipboard_read()?;
        ctx.sink.emit(AgentEvent::Privacy { kind: "clipboard".into(), detail: "Lumo read your clipboard".into() });
        let n = text.chars().count();
        Ok(ToolOutput {
            text: if n == 0 { "The clipboard is empty or holds no text.".into() } else { format!("Clipboard text ({n} characters):") },
            untrusted: if n == 0 { None } else { Some(text) },
            summary: "Read the clipboard".into(),
            ..Default::default()
        })
    }
}

pub struct WriteClipboard;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WriteClipInput {
    pub text: String,
}

#[async_trait]
impl TypedTool for WriteClipboard {
    type Input = WriteClipInput;
    const NAME: &'static str = "write_clipboard";
    const DESCRIPTION: &'static str = "Put text on the user's clipboard so they can paste it elsewhere (a drafted reply, a command, a summary).";
    fn schema(&self) -> Value {
        object_schema(json!({"text": {"type": "string"}}), &["text"])
    }
    fn risk(&self, _ctx: &ToolCtx, _: &WriteClipInput) -> Risk {
        Risk::Write
    }
    fn label(&self, _: &WriteClipInput) -> String {
        "Copying to your clipboard".into()
    }
    fn preview(&self, _ctx: &ToolCtx, i: &WriteClipInput) -> Result<ActionPreview> {
        Ok(ActionPreview {
            title: "Replace your clipboard".into(),
            details: vec![("Text".into(), crate::util::preview(&i.text, 200))],
            warning: None,
        })
    }
    async fn run(&self, ctx: &ToolCtx, i: WriteClipInput) -> Result<ToolOutput> {
        if i.text.len() > 1_000_000 {
            return Err(invalid("text is too long for the clipboard"));
        }
        ctx.core.platform.clipboard_write(&i.text)?;
        Ok(ToolOutput::text("Copied to the clipboard.", "Copied to the clipboard"))
    }
}
