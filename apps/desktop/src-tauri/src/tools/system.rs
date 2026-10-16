//! Notifications and screenshots.

use super::{object_schema, ToolCtx, ToolOutput, TypedTool};
use crate::agent::events::{ActionPreview, AgentEvent};
use crate::error::Result;
use crate::policy::{self, Risk};
use async_trait::async_trait;
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};

pub struct Notify;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NotifyInput {
    pub title: String,
    pub body: String,
}

#[async_trait]
impl TypedTool for Notify {
    type Input = NotifyInput;
    const NAME: &'static str = "notify";
    const DESCRIPTION: &'static str =
        "Show a system notification. Use it in automations to report results, or when the user asked to be told when something is done.";
    fn schema(&self) -> Value {
        object_schema(
            json!({"title": {"type": "string", "maxLength": 80}, "body": {"type": "string", "maxLength": 300}}),
            &["title", "body"],
        )
    }
    fn risk(&self, _ctx: &ToolCtx, _: &NotifyInput) -> Risk {
        Risk::Ui
    }
    fn label(&self, _: &NotifyInput) -> String {
        "Sending a notification".into()
    }
    async fn run(&self, ctx: &ToolCtx, i: NotifyInput) -> Result<ToolOutput> {
        ctx.core.platform.notify(&crate::util::preview(&i.title, 80), &crate::util::preview(&i.body, 300))?;
        Ok(ToolOutput::text("Notification shown.", format!("Notified: {}", crate::util::preview(&i.title, 60))))
    }
}

pub struct TakeScreenshot;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShotInput {
    pub reason: String,
}

#[async_trait]
impl TypedTool for TakeScreenshot {
    type Input = ShotInput;
    const NAME: &'static str = "take_screenshot";
    const DESCRIPTION: &'static str = "Capture the user's main screen to see what they are looking at, only when they ask about something on screen. Without the 'screen' permission each capture is confirmed in a system dialog. Say why in 'reason'.";
    fn schema(&self) -> Value {
        object_schema(json!({"reason": {"type": "string"}}), &["reason"])
    }
    fn risk(&self, ctx: &ToolCtx, _: &ShotInput) -> Risk {
        if policy::has_capability(&ctx.core.db, "screen") {
            Risk::Read
        } else {
            Risk::Sensitive
        }
    }
    fn label(&self, _: &ShotInput) -> String {
        "Looking at your screen".into()
    }
    fn preview(&self, _ctx: &ToolCtx, i: &ShotInput) -> Result<ActionPreview> {
        Ok(ActionPreview {
            title: "Let Lumo capture your screen once".into(),
            details: vec![("Why".into(), crate::util::preview(&i.reason, 160))],
            warning: Some("The capture is sent to your model provider. Close anything private first.".into()),
        })
    }
    async fn run(&self, ctx: &ToolCtx, _: ShotInput) -> Result<ToolOutput> {
        let shot = ctx.core.platform.capture_screen()?;
        ctx.sink.emit(AgentEvent::Privacy { kind: "screen".into(), detail: "Lumo captured your screen".into() });
        let (w, h) = (shot.width, shot.height);
        let png = base64::engine::general_purpose::STANDARD.encode(&shot.png);
        ctx.core.pending.screens.lock().insert(ctx.run_id.clone(), shot);
        Ok(ToolOutput {
            text: format!("Screenshot of the main display ({w}×{h} pixels). Coordinates for control_computer use this image's pixels."),
            images: vec![("image/png".into(), png)],
            summary: "Captured the screen".into(),
            ..Default::default()
        })
    }
}

pub struct ActiveWindow;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NoInput {}

#[async_trait]
impl TypedTool for ActiveWindow {
    type Input = NoInput;
    const NAME: &'static str = "get_active_window";
    const DESCRIPTION: &'static str =
        "Get the name and title of the app window the user was using just before Lumo, when they refer to 'this' document, page or app.";
    fn schema(&self) -> Value {
        object_schema(json!({}), &[])
    }
    fn risk(&self, ctx: &ToolCtx, _: &NoInput) -> Risk {
        if policy::has_capability(&ctx.core.db, "active_window") {
            Risk::Read
        } else {
            Risk::Write
        }
    }
    fn label(&self, _: &NoInput) -> String {
        "Checking which app you're using".into()
    }
    fn preview(&self, _ctx: &ToolCtx, _: &NoInput) -> Result<ActionPreview> {
        Ok(ActionPreview {
            title: "Let Lumo see which app and window are in front".into(),
            details: vec![],
            warning: Some("To stop being asked, allow it in Settings → Permissions.".into()),
        })
    }
    async fn run(&self, ctx: &ToolCtx, _: NoInput) -> Result<ToolOutput> {
        let (app, title) = ctx.core.platform.active_window()?;
        Ok(ToolOutput {
            text: "Active window:".into(),
            untrusted: Some(format!("App: {app}\nTitle: {title}")),
            summary: format!("You're in {app}"),
            ..Default::default()
        })
    }
}
