//! Computer use: Lumo moves the mouse and types for the user, on screen, under their control.
//!
//! The first action in a task asks for a native confirmation. After that the task holds an input
//! session until it ends, the user presses Stop in Lumo, or the global stop shortcut
//! (Alt+Shift+Escape). While a session is active an indicator is shown. Background automations
//! can never control input. Coordinates are pixels in the latest screenshot and are mapped back to
//! the real display, and every batch of actions returns a fresh screenshot so the result is checked.

use super::{object_schema, ToolCtx, ToolOutput, TypedTool};
use crate::agent::events::{ActionPreview, AgentEvent};
use crate::core::Core;
use crate::error::{invalid, LumoError, Result};
use crate::policy::Risk;
use async_trait::async_trait;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const STOP_SHORTCUT: &str = "Alt+Shift+Escape";

/// One input step, in real desktop coordinates once mapped.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum InputAction {
    MoveTo {
        x: i32,
        y: i32,
    },
    Click {
        x: i32,
        y: i32,
        #[serde(default)]
        button: Option<String>,
        #[serde(default)]
        count: Option<u8>,
    },
    Drag {
        from_x: i32,
        from_y: i32,
        to_x: i32,
        to_y: i32,
    },
    Scroll {
        x: i32,
        y: i32,
        #[serde(default)]
        dx: i32,
        #[serde(default)]
        dy: i32,
    },
    Type {
        text: String,
    },
    /// A key or chord such as "enter", "ctrl+s", "cmd+shift+t".
    Key {
        keys: String,
    },
    Wait {
        ms: u32,
    },
}

pub struct ControlComputer;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ControlInput {
    pub actions: Vec<InputAction>,
    /// Shown to the user the first time, e.g. "to fill in the form in your browser".
    pub reason: String,
}

pub fn session_active(core: &Core, run_id: &str) -> bool {
    core.pending.input_sessions.lock().contains(run_id)
}

/// End a run's input session (run finished or stopped).
pub fn end_session(core: &Core, run_id: &str) {
    let removed = core.pending.input_sessions.lock().remove(run_id);
    if removed && core.pending.input_sessions.lock().is_empty() {
        core.platform.input_control_changed(false);
    }
}

/// Validate a key chord. Returns the normalized parts.
pub fn parse_keys(keys: &str) -> Result<Vec<String>> {
    const NAMED: &[&str] = &[
        "enter",
        "return",
        "tab",
        "escape",
        "esc",
        "backspace",
        "delete",
        "space",
        "up",
        "down",
        "left",
        "right",
        "home",
        "end",
        "pageup",
        "pagedown",
        "ctrl",
        "control",
        "alt",
        "option",
        "shift",
        "cmd",
        "command",
        "meta",
        "super",
        "win",
        "f1",
        "f2",
        "f3",
        "f4",
        "f5",
        "f6",
        "f7",
        "f8",
        "f9",
        "f10",
        "f11",
        "f12",
    ];
    let parts: Vec<String> = keys.split('+').map(|p| p.trim().to_lowercase()).filter(|p| !p.is_empty()).collect();
    if parts.is_empty() || parts.len() > 4 {
        return Err(invalid(format!("'{keys}' is not a key or key combination")));
    }
    for p in &parts {
        if !(NAMED.contains(&p.as_str()) || p.chars().count() == 1) {
            return Err(invalid(format!("unknown key '{p}'")));
        }
    }
    Ok(parts)
}

fn validate(actions: &[InputAction]) -> Result<()> {
    if actions.is_empty() || actions.len() > 20 {
        return Err(invalid("give 1 to 20 actions per call"));
    }
    for a in actions {
        match a {
            InputAction::Type { text } if text.chars().count() > 2000 => return Err(invalid("type at most 2000 characters at a time")),
            InputAction::Key { keys } => {
                parse_keys(keys)?;
            }
            InputAction::Click { button: Some(b), .. } if !["left", "right", "middle"].contains(&b.as_str()) => {
                return Err(invalid("button must be left, right or middle"))
            }
            InputAction::Click { count: Some(c), .. } if *c == 0 || *c > 3 => return Err(invalid("click count must be 1 to 3")),
            InputAction::Wait { ms } if *ms > 5000 => return Err(invalid("wait at most 5000 ms")),
            _ => {}
        }
    }
    Ok(())
}

/// Map screenshot pixels to desktop coordinates.
fn map(shot: &crate::core::Screenshot, x: i32, y: i32) -> Result<(i32, i32)> {
    if x < 0 || y < 0 || x as u32 >= shot.width || y as u32 >= shot.height {
        return Err(invalid(format!("({x}, {y}) is outside the {}×{} screenshot", shot.width, shot.height)));
    }
    let sx = shot.screen_width as f64 / shot.width as f64;
    let sy = shot.screen_height as f64 / shot.height as f64;
    Ok((shot.origin_x + (x as f64 * sx).round() as i32, shot.origin_y + (y as f64 * sy).round() as i32))
}

fn map_all(shot: &crate::core::Screenshot, actions: &[InputAction]) -> Result<Vec<InputAction>> {
    actions
        .iter()
        .map(|a| {
            Ok(match a.clone() {
                InputAction::MoveTo { x, y } => {
                    let (x, y) = map(shot, x, y)?;
                    InputAction::MoveTo { x, y }
                }
                InputAction::Click { x, y, button, count } => {
                    let (x, y) = map(shot, x, y)?;
                    InputAction::Click { x, y, button, count }
                }
                InputAction::Drag { from_x, from_y, to_x, to_y } => {
                    let (fx, fy) = map(shot, from_x, from_y)?;
                    let (tx, ty) = map(shot, to_x, to_y)?;
                    InputAction::Drag { from_x: fx, from_y: fy, to_x: tx, to_y: ty }
                }
                InputAction::Scroll { x, y, dx, dy } => {
                    let (x, y) = map(shot, x, y)?;
                    InputAction::Scroll { x, y, dx: dx.clamp(-50, 50), dy: dy.clamp(-50, 50) }
                }
                other => other,
            })
        })
        .collect()
}

fn describe(a: &InputAction) -> String {
    match a {
        InputAction::MoveTo { x, y } => format!("move to ({x}, {y})"),
        InputAction::Click { x, y, button, count } => {
            format!("{}{} click at ({x}, {y})", if count.unwrap_or(1) == 2 { "double " } else { "" }, button.as_deref().unwrap_or("left"))
        }
        InputAction::Drag { from_x, from_y, to_x, to_y } => format!("drag ({from_x}, {from_y}) → ({to_x}, {to_y})"),
        InputAction::Scroll { dx, dy, .. } => format!("scroll ({dx}, {dy})"),
        InputAction::Type { text } => format!("type \"{}\"", crate::util::preview(text, 40)),
        InputAction::Key { keys } => format!("press {keys}"),
        InputAction::Wait { ms } => format!("wait {ms} ms"),
    }
}

#[async_trait]
impl TypedTool for ControlComputer {
    type Input = ControlInput;
    const NAME: &'static str = "control_computer";
    const DESCRIPTION: &'static str = "Control the mouse and keyboard to do something in another app on the user's screen, when no other tool can do it. Take a screenshot first; x/y are pixels in the latest screenshot. Send up to 20 actions per call; each call returns a new screenshot so you can check the result before continuing. The first call asks the user for permission for this task; the user can take back control at any time. Never enter passwords or payment details, and stop and ask before submitting anything irreversible (sending, buying, deleting).";
    fn schema(&self) -> Value {
        let xy = json!({"type": "integer", "minimum": 0});
        object_schema(
            json!({
                "reason": {"type": "string"},
                "actions": {"type": "array", "minItems": 1, "maxItems": 20, "items": {"oneOf": [
                    object_schema(json!({"type": {"const": "move_to"}, "x": xy, "y": xy}), &["type", "x", "y"]),
                    object_schema(json!({"type": {"const": "click"}, "x": xy, "y": xy, "button": {"type": "string", "enum": ["left", "right", "middle"]}, "count": {"type": "integer", "minimum": 1, "maximum": 3}}), &["type", "x", "y"]),
                    object_schema(json!({"type": {"const": "drag"}, "from_x": xy, "from_y": xy, "to_x": xy, "to_y": xy}), &["type", "from_x", "from_y", "to_x", "to_y"]),
                    object_schema(json!({"type": {"const": "scroll"}, "x": xy, "y": xy, "dx": {"type": "integer"}, "dy": {"type": "integer", "description": "Positive scrolls down"}}), &["type", "x", "y"]),
                    object_schema(json!({"type": {"const": "type"}, "text": {"type": "string"}}), &["type", "text"]),
                    object_schema(json!({"type": {"const": "key"}, "keys": {"type": "string", "description": "e.g. enter, ctrl+s, cmd+shift+t"}}), &["type", "keys"]),
                    object_schema(json!({"type": {"const": "wait"}, "ms": {"type": "integer", "minimum": 0, "maximum": 5000}}), &["type", "ms"])
                ]}}
            }),
            &["actions", "reason"],
        )
    }
    fn risk(&self, ctx: &ToolCtx, _: &ControlInput) -> Risk {
        if session_active(&ctx.core, &ctx.run_id) {
            // The user already allowed control for this task in a native dialog.
            Risk::Ui
        } else {
            Risk::Sensitive
        }
    }
    fn label(&self, i: &ControlInput) -> String {
        match i.actions.iter().find(|a| !matches!(a, InputAction::Wait { .. })) {
            Some(a) if i.actions.len() == 1 => format!("Using your computer: {}", describe(a)),
            _ => format!("Using your computer ({} steps)", i.actions.len()),
        }
    }
    fn preview(&self, _ctx: &ToolCtx, i: &ControlInput) -> Result<ActionPreview> {
        validate(&i.actions)?;
        Ok(ActionPreview {
            title: "Let Lumo control your mouse and keyboard for this task".into(),
            details: vec![
                ("Why".into(), crate::util::preview(&i.reason, 160)),
                ("First steps".into(), i.actions.iter().take(3).map(describe).collect::<Vec<_>>().join(", ")),
            ],
            warning: Some(format!(
                "Don't use your mouse or keyboard meanwhile. Take back control any time with Stop in Lumo or {STOP_SHORTCUT}."
            )),
        })
    }
    async fn run(&self, ctx: &ToolCtx, i: ControlInput) -> Result<ToolOutput> {
        validate(&i.actions)?;
        let shot = ctx
            .core
            .pending
            .screens
            .lock()
            .get(&ctx.run_id)
            .cloned()
            .ok_or_else(|| invalid("take a screenshot first, so coordinates refer to what is on screen"))?;
        let mapped = map_all(&shot, &i.actions)?;
        let started = {
            let mut s = ctx.core.pending.input_sessions.lock();
            let first_overall = s.is_empty();
            s.insert(ctx.run_id.clone());
            first_overall
        };
        if started {
            ctx.core.platform.input_control_changed(true);
            ctx.sink.emit(AgentEvent::Privacy {
                kind: "input_control".into(),
                detail: format!("Lumo is using your mouse and keyboard. Press {STOP_SHORTCUT} to stop."),
            });
        }
        if ctx.cancel.is_cancelled() {
            return Err(LumoError::Cancelled);
        }
        let platform = ctx.core.platform.clone();
        let cancel = ctx.cancel.clone();
        // Input is blocking (and sleeps between steps); run it off the async runtime, step by step,
        // checking for a stop between steps.
        tokio::task::spawn_blocking(move || -> Result<()> {
            for a in &mapped {
                if cancel.is_cancelled() {
                    return Err(LumoError::Cancelled);
                }
                platform.perform_input(std::slice::from_ref(a))?;
            }
            Ok(())
        })
        .await
        .map_err(|e| LumoError::Other(e.into()))??;
        // Let the UI settle, then show the model the result.
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        let done = i.actions.iter().map(describe).collect::<Vec<_>>().join("; ");
        match ctx.core.platform.capture_screen() {
            Ok(after) => {
                let (w, h) = (after.width, after.height);
                let png = base64::engine::general_purpose::STANDARD.encode(&after.png);
                ctx.core.pending.screens.lock().insert(ctx.run_id.clone(), after);
                Ok(ToolOutput {
                    text: format!("Done: {done}. Screenshot after the actions ({w}×{h}):"),
                    images: vec![("image/png".into(), png)],
                    summary: format!("{} step{} on screen", i.actions.len(), if i.actions.len() == 1 { "" } else { "s" }),
                    ..Default::default()
                })
            }
            Err(e) => {
                Ok(ToolOutput::text(format!("Done: {done}. Could not take a screenshot to check the result: {e}"), "Used the computer"))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::ctx;
    use super::super::{execute, Origin, Registry};
    use super::*;
    use crate::core::testing::{core_with, FakePlatform};
    use crate::core::Screenshot;
    use std::sync::Arc;

    fn shot() -> Screenshot {
        Screenshot { png: vec![1, 2, 3], width: 1000, height: 500, origin_x: 100, origin_y: 0, screen_width: 2000, screen_height: 1000 }
    }

    #[tokio::test]
    async fn asks_once_per_task_maps_coordinates_and_ends_with_the_run() {
        let platform = Arc::new(FakePlatform::default());
        *platform.screen.lock() = Some(shot());
        *platform.confirm.lock() = true;
        let (core, _d) = core_with(platform.clone());
        let (ctx, _) = ctx(core.clone(), Origin::User);
        let r = Registry::standard();
        let names: Vec<String> = r.names().into_iter().map(String::from).collect();
        let call = |id: &str, actions: Value| json!({"type": "tool_use", "id": id, "name": "control_computer", "input": {"reason": "fill the form", "actions": actions}});

        // Without a screenshot there is nothing to aim at.
        let res = execute(&r, &ctx, &call("c0", json!([{"type": "click", "x": 10, "y": 10}])), &names).await;
        assert!(!res.ok);
        assert!(
            execute(&r, &ctx, &json!({"type": "tool_use", "id": "s", "name": "take_screenshot", "input": {"reason": "see"}}), &names)
                .await
                .ok
        );
        let confirms_before = platform.confirms.lock().len();

        let res = execute(
            &r,
            &ctx,
            &call(
                "c1",
                json!([{"type": "click", "x": 500, "y": 250}, {"type": "type", "text": "hello"}, {"type": "key", "keys": "ctrl+s"}]),
            ),
            &names,
        )
        .await;
        assert!(res.ok, "{}", res.block);
        assert_eq!(platform.confirms.lock().len(), confirms_before + 1, "asked once");
        assert_eq!(
            platform.inputs.lock()[0],
            InputAction::Click { x: 1100, y: 500, button: None, count: None },
            "mapped to the real display"
        );
        assert_eq!(platform.control_active.lock().as_slice(), &[true]);

        // Second call in the same task: no new dialog.
        assert!(execute(&r, &ctx, &call("c2", json!([{"type": "scroll", "x": 1, "y": 1, "dy": 3}])), &names).await.ok);
        assert_eq!(platform.confirms.lock().len(), confirms_before + 1);

        // Out of bounds and bad keys are rejected before anything moves.
        let n = platform.inputs.lock().len();
        assert!(!execute(&r, &ctx, &call("c3", json!([{"type": "click", "x": 5000, "y": 1}])), &names).await.ok);
        assert!(!execute(&r, &ctx, &call("c4", json!([{"type": "key", "keys": "ctrl+nonsense"}])), &names).await.ok);
        assert_eq!(platform.inputs.lock().len(), n);

        end_session(&core, &ctx.run_id);
        assert_eq!(platform.control_active.lock().as_slice(), &[true, false]);
        assert!(!session_active(&core, &ctx.run_id));

        // Automations can never take control.
        let (auto, _) = super::super::tests::ctx(core.clone(), Origin::Automation);
        core.pending.screens.lock().insert(auto.run_id.clone(), shot());
        let res = execute(&r, &auto, &call("c5", json!([{"type": "click", "x": 1, "y": 1}])), &names).await;
        assert!(!res.ok && res.needs_attention);
    }

    #[test]
    fn key_chords_are_validated() {
        assert_eq!(parse_keys("Ctrl+Shift+T").unwrap(), vec!["ctrl", "shift", "t"]);
        assert!(parse_keys("enter").is_ok());
        assert!(parse_keys("").is_err());
        assert!(parse_keys("ctrl+alt+shift+cmd+x").is_err());
    }
}
