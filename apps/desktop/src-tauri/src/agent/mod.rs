//! The agent runtime: Understand → Plan → Execute → Verify → Report, as a loop around the model.
//!
//! The model proposes; this loop disposes. Every tool call goes through `tools::execute`, which
//! validates input and enforces permissions. Every tool_use gets exactly one tool_result, including
//! when the user cancels, so the stored history is always a valid conversation to continue.

pub mod events;
pub mod prompt;
pub mod store;

use crate::core::{ActiveRun, Core};
use crate::error::{invalid, LumoError, Result};
use crate::model::{anthropic::clean_for_replay, ModelRequest, ServerTools, StreamEvent, Usage};
use crate::policy::Risk;
use crate::tools::{self, Origin, Registry, ToolCtx};
use crate::util::{new_id, now, preview};
use base64::Engine;
use events::{AgentEvent, EventSink, Phase};
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use store::FrozenTools;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StartRequest {
    pub conversation_id: Option<String>,
    pub text: String,
    /// Tokens from `attach_files`; never raw paths.
    #[serde(default)]
    pub attachments: Vec<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub project_id: Option<String>,
}

/// A run that has been recorded and is ready to drive.
#[derive(Clone)]
pub struct RunSpec {
    pub run_id: String,
    pub conversation_id: String,
    pub origin: Origin,
    pub cancel: CancellationToken,
    pub automation_allowed: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RunOutcome {
    pub status: String,
    pub summary: Option<String>,
    pub error: Option<String>,
    pub needs_attention: bool,
}

const MAX_MODEL_TURNS: usize = 60;

pub fn agent_definition(core: &Core, id: &str) -> Result<(String, Vec<String>, Option<String>)> {
    core.db
        .conn()
        .query_row("SELECT instructions, tools_json, model FROM agents WHERE id = ?1", [id], |r| {
            let tools: String = r.get(1)?;
            Ok((r.get::<_, String>(0)?, serde_json::from_str::<Vec<String>>(&tools).unwrap_or_default(), r.get::<_, Option<String>>(2)?))
        })
        .map_err(|_| LumoError::NotFound("agent".into()))
}

/// Record the user's message and a new run. Fast and synchronous; driving the run is separate.
pub fn prepare(
    core: &Arc<Core>,
    registry: &Registry,
    req: &StartRequest,
    origin: Origin,
    automation_allowed: Vec<String>,
) -> Result<RunSpec> {
    let text = req.text.trim();
    if text.is_empty() && req.attachments.is_empty() {
        return Err(invalid("say what you'd like Lumo to do"));
    }
    if text.len() > 100_000 {
        return Err(invalid("the message is too long"));
    }
    let settings = core.settings();
    let existing = match &req.conversation_id {
        Some(id) => {
            let c = store::get_conversation(core, id)?;
            if core.pending.runs.lock().values().any(|r| r.conversation_id == c.id) {
                return Err(invalid("Lumo is still working in this conversation. Wait for it to finish or stop it first."));
            }
            Some(c)
        }
        None => None,
    };
    // Plan limits, before anything is recorded: the model must be one the plan includes (both the
    // current setting and the one this conversation started with), and the monthly allowance must
    // not be used up.
    let limits = crate::plans::limits(&settings.plan);
    crate::plans::check_model(limits, &settings.provider, &settings.chat_model())?;
    if let Some(c) = &existing {
        crate::plans::check_model(limits, &c.provider, &c.model)?;
    }
    crate::plans::check_allowance(core)?;
    let conversation = match existing {
        Some(c) => c,
        None => {
            let (instructions, agent_tools, agent_model) = match &req.agent_id {
                Some(a) => {
                    let (i, t, m) = agent_definition(core, a)?;
                    (Some(i), t, m)
                }
                None => (None, vec![], None),
            };
            let all: Vec<String> = registry.names().into_iter().map(String::from).collect();
            let mut client: Vec<String> =
                if agent_tools.is_empty() { all } else { agent_tools.into_iter().filter(|t| all.contains(t)).collect() };
            // Conversation tools are always available; they have no side effects.
            for t in ["update_plan", "ask_user", "present_options", "set_mood"] {
                if !client.iter().any(|c| c == t) {
                    client.push(t.into());
                }
            }
            let anthropic = settings.provider == "anthropic";
            // Anthropic models search with the built-in server tool; local models use Brave if connected.
            let brave = core.secrets.get("brave_search_api_key").ok().flatten().is_some();
            if anthropic || !brave {
                client.retain(|t| t != "search_web");
            }
            let tools = FrozenTools {
                client,
                web_search: anthropic && settings.web_search_enabled,
                web_fetch: anthropic && settings.web_search_enabled,
            };
            let model =
                if settings.provider == "anthropic" { agent_model.unwrap_or(settings.model.clone()) } else { settings.chat_model() };
            store::create_conversation(
                core,
                if text.is_empty() { "Attachment" } else { text },
                req.agent_id.as_deref(),
                &settings.provider,
                &model,
                &prompt::system_prompt(&settings, instructions.as_deref()),
                &tools,
                req.project_id.as_deref(),
                origin.as_str(),
            )?
        }
    };
    let project_path = conversation.project_id.as_deref().and_then(|p| tools::projects::get(core, p).ok()).map(|p| p.path);
    let mut content = vec![json!({"type": "text", "text": prompt::turn_context(core, project_path.as_deref())})];
    if !text.is_empty() {
        content.push(json!({"type": "text", "text": text}));
    }
    for token in &req.attachments {
        content.push(attachment_block(core, token, &conversation.provider)?);
    }
    let run_id = new_id();
    store::create_run(core, &run_id, &conversation.id, origin.as_str())?;
    store::append(core, &conversation.id, "user", &content, Some(&run_id))?;
    let cancel = CancellationToken::new();
    core.pending.runs.lock().insert(
        run_id.clone(),
        ActiveRun {
            run_id: run_id.clone(),
            conversation_id: conversation.id.clone(),
            origin: origin.as_str().into(),
            title: conversation.title.clone(),
            started_at: now(),
            cancel: cancel.clone(),
        },
    );
    Ok(RunSpec { run_id, conversation_id: conversation.id, origin, cancel, automation_allowed })
}

fn attachment_block(core: &Core, token: &str, provider: &str) -> Result<Value> {
    let path = core
        .pending
        .attachments
        .lock()
        .get(token)
        .cloned()
        .ok_or_else(|| invalid("that attachment is no longer available; attach it again"))?;
    let meta = std::fs::metadata(&path)?;
    let name = path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let mime = mime_guess::from_path(&path).first_or_octet_stream();
    let b64 = |bytes: Vec<u8>| base64::engine::general_purpose::STANDARD.encode(bytes);
    match mime.essence_str() {
        "image/png" | "image/jpeg" | "image/gif" | "image/webp" => {
            if meta.len() > 5 * 1024 * 1024 {
                return Err(invalid(format!("{name} is larger than 5 MB")));
            }
            Ok(json!({"type": "image", "source": {"type": "base64", "media_type": mime.essence_str(), "data": b64(std::fs::read(&path)?)}}))
        }
        "application/pdf" if provider == "anthropic" => {
            if meta.len() > 20 * 1024 * 1024 {
                return Err(invalid(format!("{name} is larger than 20 MB")));
            }
            Ok(
                json!({"type": "document", "title": name, "source": {"type": "base64", "media_type": "application/pdf", "data": b64(std::fs::read(&path)?)}}),
            )
        }
        _ => {
            if meta.len() > 2 * 1024 * 1024 {
                return Err(invalid(format!("{name} is larger than 2 MB; ask Lumo to read it from its folder instead")));
            }
            let text = String::from_utf8(std::fs::read(&path)?).map_err(|_| invalid(format!("{name} is not a text, image or PDF file")))?;
            Ok(json!({"type": "text", "text": format!("The user attached {name} ({}):\n{}", path.display(), tools::wrap_untrusted(&text))}))
        }
    }
}

pub fn cancel(core: &Core, run_id: &str) -> bool {
    match core.pending.runs.lock().get(run_id) {
        Some(r) => {
            r.cancel.cancel();
            true
        }
        None => false,
    }
}

/// Drive a prepared run to completion.
pub async fn drive(core: Arc<Core>, registry: Arc<Registry>, spec: RunSpec, sink: Arc<dyn EventSink>) -> RunOutcome {
    sink.emit(AgentEvent::RunStarted { run_id: spec.run_id.clone(), conversation_id: spec.conversation_id.clone() });
    sink.emit(AgentEvent::Phase { phase: Phase::Understanding });
    let mut usage = Usage::default();
    let outcome = match drive_inner(&core, &registry, &spec, &sink, &mut usage).await {
        Ok(o) => o,
        Err(LumoError::Cancelled) => {
            RunOutcome { status: "cancelled".into(), summary: Some("Stopped.".into()), error: None, needs_attention: false }
        }
        // The plan's allowance ran out between model calls; the message says when it resets.
        Err(e @ LumoError::PlanLimit(_)) => {
            RunOutcome { status: "limit_reached".into(), summary: None, error: Some(e.to_string()), needs_attention: false }
        }
        Err(e) => RunOutcome { status: "failed".into(), summary: None, error: Some(e.to_string()), needs_attention: false },
    };
    tools::computer::end_session(&core, &spec.run_id);
    core.pending.screens.lock().remove(&spec.run_id);
    let _ = store::finish_run(&core, &spec.run_id, &outcome.status, outcome.summary.as_deref(), outcome.error.as_deref(), &usage);
    core.pending.runs.lock().remove(&spec.run_id);
    sink.emit(AgentEvent::RunFinished {
        run_id: spec.run_id.clone(),
        status: outcome.status.clone(),
        summary: outcome.summary.clone(),
        error: outcome.error.clone(),
    });
    outcome
}

struct Progress {
    tools_used: AtomicBool,
    wrote: AtomicBool,
    reporting: AtomicBool,
    planned: AtomicBool,
    server_calls: AtomicUsize,
    server_open: Mutex<Vec<(String, String)>>,
}

fn server_label(name: &str) -> &'static str {
    match name {
        "web_search" => "Searching the web",
        "web_fetch" => "Reading a web page",
        _ => "Working",
    }
}

async fn drive_inner(
    core: &Arc<Core>,
    registry: &Arc<Registry>,
    spec: &RunSpec,
    sink: &Arc<dyn EventSink>,
    usage: &mut Usage,
) -> Result<RunOutcome> {
    let conv = store::get_conversation(core, &spec.conversation_id)?;
    let provider = core.provider()?;
    let settings = core.settings();
    let max_calls = settings.max_tool_calls_per_run as usize;
    let tool_defs = registry.defs(Some(&conv.tools.client));
    let progress = Arc::new(Progress {
        tools_used: AtomicBool::new(false),
        wrote: AtomicBool::new(false),
        reporting: AtomicBool::new(false),
        planned: AtomicBool::new(false),
        server_calls: AtomicUsize::new(0),
        server_open: Mutex::new(Vec::new()),
    });
    let mut calls_made = 0usize;
    let mut pauses = 0usize;
    let mut needs_attention = false;
    let mut last_text = String::new();

    for _turn in 0..MAX_MODEL_TURNS {
        if spec.cancel.is_cancelled() {
            return Err(LumoError::Cancelled);
        }
        let messages = store::history(core, &spec.conversation_id)?;
        let req = ModelRequest {
            model: conv.model.clone(),
            system: conv.system_prompt.clone(),
            tools: tool_defs.clone(),
            server_tools: ServerTools { web_search: conv.tools.web_search, web_fetch: conv.tools.web_fetch, computer: false },
            messages,
            max_tokens: 32_000,
            effort: settings.effort.clone(),
        };
        // Checked before every model call. A call that is already streaming is never cut off.
        crate::plans::check_allowance(core)?;
        let s2 = sink.clone();
        let p2 = progress.clone();
        let on_stream = move |ev: StreamEvent| match ev {
            StreamEvent::TextDelta(t) => {
                if p2.tools_used.load(Ordering::Relaxed) && !p2.reporting.swap(true, Ordering::Relaxed) {
                    s2.emit(AgentEvent::Phase { phase: Phase::Reporting });
                }
                s2.emit(AgentEvent::TextDelta { text: t });
            }
            StreamEvent::ProgressNote(t) => s2.emit(AgentEvent::ProgressNote { text: t }),
            StreamEvent::ToolUseStarted { .. } => {}
            StreamEvent::ServerToolStarted { name } => {
                let id = format!("server_{}", p2.server_calls.fetch_add(1, Ordering::Relaxed));
                p2.server_open.lock().push((name.clone(), id.clone()));
                p2.tools_used.store(true, Ordering::Relaxed);
                s2.emit(AgentEvent::Phase { phase: Phase::Executing });
                s2.emit(AgentEvent::ToolStarted {
                    call_id: id,
                    name: name.clone(),
                    label: server_label(&name).into(),
                    risk: "read".into(),
                    input: Value::Null,
                });
            }
            StreamEvent::ServerToolFinished { name, summary } => {
                let id = {
                    let mut open = p2.server_open.lock();
                    let pos = open.iter().position(|(n, _)| *n == name);
                    pos.map(|i| open.remove(i).1)
                };
                if let Some(id) = id {
                    s2.emit(AgentEvent::ToolFinished { call_id: id, name, ok: true, summary, data: None });
                }
            }
        };
        let call_started = chrono::Local::now();
        let resp = provider.complete(&req, &on_stream, &spec.cancel).await?;
        crate::plans::record_call(core, &req, &resp, call_started);
        usage.add(&resp.usage);
        // Server tool calls that never reported a result are closed so the timeline doesn't spin.
        for (name, id) in progress.server_open.lock().drain(..) {
            sink.emit(AgentEvent::ToolFinished { call_id: id, name, ok: true, summary: "Done".into(), data: None });
        }
        let stored = clean_for_replay(&resp.content);
        let message_id = store::append(core, &spec.conversation_id, "assistant", &stored, Some(&spec.run_id))?;
        let text: String =
            resp.content.iter().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("");
        if !text.trim().is_empty() {
            last_text = text;
        }
        let tool_uses: Vec<Value> = resp.content.iter().filter(|b| b["type"] == "tool_use").cloned().collect();

        match resp.stop_reason.as_str() {
            "refusal" => {
                sink.emit(AgentEvent::AssistantMessage { message_id });
                let why = resp.stop_details.as_ref().and_then(|d| d["explanation"].as_str()).map(String::from);
                return Ok(RunOutcome {
                    status: "refused".into(),
                    summary: None,
                    error: Some(why.unwrap_or_else(|| "The model declined this request.".into())),
                    needs_attention,
                });
            }
            "pause_turn" => {
                pauses += 1;
                if pauses > 5 {
                    return Ok(RunOutcome {
                        status: "failed".into(),
                        summary: None,
                        error: Some("The model kept pausing without finishing.".into()),
                        needs_attention,
                    });
                }
                continue;
            }
            _ => {}
        }

        if tool_uses.is_empty() {
            sink.emit(AgentEvent::AssistantMessage { message_id });
            let mut summary = preview(&last_text, 240);
            if resp.stop_reason == "max_tokens" {
                summary.push_str(" (The response reached its length limit and may be incomplete.)");
            }
            return Ok(RunOutcome { status: "done".into(), summary: Some(summary), error: None, needs_attention });
        }

        // Execute the calls in order. Every tool_use gets a result, whatever happens.
        let mut results = Vec::new();
        let mut limit_hit = false;
        for (i, tu) in tool_uses.iter().enumerate() {
            let call_id = tu["id"].as_str().unwrap_or_default().to_string();
            if spec.cancel.is_cancelled() {
                for rest in &tool_uses[i..] {
                    results.push(cancelled_result(rest));
                }
                break;
            }
            if calls_made >= max_calls {
                limit_hit = true;
                results.push(json!({"type": "tool_result", "tool_use_id": call_id, "is_error": true, "content": [{"type": "text", "text": format!("Not run: this task reached its limit of {max_calls} actions. Stop and report progress to the user.")}]}));
                continue;
            }
            calls_made += 1;
            let name = tu["name"].as_str().unwrap_or_default();
            if name == "update_plan" && !progress.planned.swap(true, Ordering::Relaxed) {
                sink.emit(AgentEvent::Phase { phase: Phase::Planning });
            } else if !matches!(name, "update_plan" | "ask_user" | "present_options") {
                let is_read = registry
                    .get(name)
                    .map(|t| matches!(t.prepare(&ctx_for(core, spec, sink, &call_id, &conv), &tu["input"]).map(|p| p.risk), Ok(Risk::Read)))
                    .unwrap_or(false);
                let phase = if is_read && progress.wrote.load(Ordering::Relaxed) { Phase::Verifying } else { Phase::Executing };
                sink.emit(AgentEvent::Phase { phase });
                progress.reporting.store(false, Ordering::Relaxed);
            }
            progress.tools_used.store(true, Ordering::Relaxed);
            let ctx = ctx_for(core, spec, sink, &call_id, &conv);
            let r = tools::execute(registry, &ctx, tu, &conv.tools.client).await;
            if r.ok && matches!(r.risk, Risk::Write | Risk::Sensitive) {
                progress.wrote.store(true, Ordering::Relaxed);
            }
            needs_attention |= r.needs_attention;
            results.push(r.block);
        }
        store::append(core, &spec.conversation_id, "user", &results, Some(&spec.run_id))?;
        if spec.cancel.is_cancelled() {
            return Err(LumoError::Cancelled);
        }
        if limit_hit {
            return Ok(RunOutcome {
                status: "stopped".into(),
                summary: Some(format!("Stopped after {max_calls} actions, the limit set in Settings → Model.")),
                error: None,
                needs_attention,
            });
        }
    }
    Ok(RunOutcome {
        status: "stopped".into(),
        summary: Some("Stopped: the task took too many steps.".into()),
        error: None,
        needs_attention,
    })
}

fn ctx_for(core: &Arc<Core>, spec: &RunSpec, sink: &Arc<dyn EventSink>, call_id: &str, conv: &store::Conversation) -> ToolCtx {
    ToolCtx {
        core: core.clone(),
        run_id: spec.run_id.clone(),
        conversation_id: spec.conversation_id.clone(),
        call_id: call_id.into(),
        origin: spec.origin,
        sink: sink.clone(),
        cancel: spec.cancel.clone(),
        automation_allowed: spec.automation_allowed.clone(),
        project_id: conv.project_id.clone(),
    }
}

fn cancelled_result(tu: &Value) -> Value {
    json!({"type": "tool_result", "tool_use_id": tu["id"], "is_error": true, "content": [{"type": "text", "text": "Not run: the user stopped the task."}]})
}

#[cfg(test)]
pub(crate) mod tests;
