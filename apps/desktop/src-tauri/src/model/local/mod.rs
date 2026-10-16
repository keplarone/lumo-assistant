//! The on-device model provider: runs a downloaded GGUF model with the built-in llama.cpp engine.
//! It implements the same `ModelProvider` trait as the cloud adapters, so the agent loop does not
//! know the difference: history in, streamed text and tool calls out.

pub mod engine;
pub mod format;

use super::{EventSink, ModelProvider, ModelRequest, ModelResponse, StreamEvent, Usage};
use crate::error::{LumoError, Result};
use async_trait::async_trait;
use engine::{Engine, Gen, Job, Sampling};
use format::{Family, Parsed};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub struct LocalProvider {
    engine: Arc<Engine>,
    /// Product name, for messages ("Nebula 4.2").
    display_name: String,
    model_id: String,
    path: PathBuf,
    family: Family,
    n_ctx: u32,
}

impl LocalProvider {
    pub fn new(engine: Arc<Engine>, entry: &crate::local_models::CatalogEntry, path: PathBuf) -> Self {
        LocalProvider {
            engine,
            display_name: entry.tier.to_string(),
            model_id: entry.id.to_string(),
            path,
            family: entry.family,
            n_ctx: entry.context_tokens,
        }
    }

    fn sampling(&self) -> Sampling {
        match self.family {
            // Qwen3's recommended settings for non-thinking mode.
            Family::Qwen3 => Sampling { temperature: 0.7, top_k: 20, top_p: 0.8, min_p: 0.0 },
            // OpenAI's recommended settings for gpt-oss.
            Family::Harmony => Sampling { temperature: 1.0, top_k: 0, top_p: 1.0, min_p: 0.0 },
        }
    }
}

/// Tools left out for models with a 16k context window: they would crowd out the conversation, and a
/// small on-device model can't use them well anyway (screen control and screenshots need vision; the
/// project, publishing and deploy tools are long multi-step developer flows). Other tools can grow
/// without touching this list; `the_standard_prompt_fits_every_catalog_model` guards the budget.
const SMALL_CONTEXT_SKIP: &[&str] = &[
    "control_computer",
    "take_screenshot",
    "cart_ready_for_user",
    "create_project",
    "preview_project",
    "save_version",
    "publish_to_github",
    "deploy_to_netlify",
];

/// The tools a model with `n_ctx` tokens of context is offered.
fn tools_for(n_ctx: u32, tools: &[crate::model::ToolDef]) -> Vec<crate::model::ToolDef> {
    if n_ctx > 16_384 {
        return tools.to_vec();
    }
    tools.iter().filter(|t| !SMALL_CONTEXT_SKIP.contains(&t.name.as_str())).cloned().collect()
}

/// The next history start after `from` that begins a fresh user turn (not tool results), so
/// dropping the messages before it keeps tool calls and their results together.
fn next_turn_start(messages: &[super::Message], from: usize) -> Option<usize> {
    (from + 1..messages.len()).find(|&i| {
        let m = &messages[i];
        m.role == "user" && !m.content.iter().any(|b| b["type"] == "tool_result")
    })
}

#[async_trait]
impl ModelProvider for LocalProvider {
    fn name(&self) -> &'static str {
        "local"
    }

    async fn complete(&self, req: &ModelRequest, sink: EventSink<'_>, cancel: &CancellationToken) -> Result<ModelResponse> {
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        let tools = tools_for(self.n_ctx, &req.tools);
        // The oldest messages are left out when the conversation outgrows the context window.
        let mut from = 0;
        loop {
            let prompt = format::render(self.family, &req.system, &tools, &req.messages[from..], &req.effort, &today);
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
            let job_cancel = cancel.child_token();
            self.engine.submit(Job {
                path: self.path.clone(),
                n_ctx: self.n_ctx,
                prompt,
                max_tokens: req.max_tokens.clamp(256, 8192),
                sampling: self.sampling(),
                cancel: job_cancel.clone(),
                events: tx,
            });
            // Stop the engine if this future is dropped (the run was abandoned).
            let _guard = job_cancel.clone().drop_guard();

            let mut raw = String::new();
            let mut shown = String::new();
            let mut ids: Vec<String> = Vec::new();
            let finished = loop {
                let ev = tokio::select! {
                    ev = rx.recv() => ev,
                    _ = cancel.cancelled() => return Err(LumoError::Cancelled),
                };
                let Some(ev) = ev else {
                    return Err(LumoError::Provider("The on-device engine stopped unexpectedly.".into()));
                };
                match ev {
                    Gen::Piece(p) => {
                        raw.push_str(&p);
                        let now = format::parse(self.family, &raw, false);
                        emit(&now, &mut shown, &mut ids, sink);
                    }
                    Gen::Done { prompt_tokens, output_tokens, hit_limit } => break (prompt_tokens, output_tokens, hit_limit),
                    Gen::TooLong { prompt_tokens, n_ctx } => match next_turn_start(&req.messages, from) {
                        Some(i) => {
                            log::info!("on-device prompt of {prompt_tokens} tokens exceeds {n_ctx}; leaving out older messages");
                            from = i;
                            break (u64::MAX, 0, false);
                        }
                        None => {
                            return Err(LumoError::Provider(format!(
                                "This request is too long for {} ({prompt_tokens} tokens; it can read about {n_ctx}). Start a new conversation or attach less.",
                                self.display_name
                            )))
                        }
                    },
                    Gen::Cancelled => return Err(LumoError::Cancelled),
                    Gen::Error(e) => return Err(LumoError::Provider(e)),
                }
            };
            let (prompt_tokens, output_tokens, hit_limit) = finished;
            if prompt_tokens == u64::MAX {
                continue;
            }

            let parsed = format::parse(self.family, &raw, true);
            emit(&parsed, &mut shown, &mut ids, sink);
            let mut content = Vec::new();
            let text = parsed.text.trim();
            if !text.is_empty() {
                content.push(json!({"type": "text", "text": text}));
            }
            for (i, call) in parsed.calls.iter().enumerate() {
                let mut block = json!({"type": "tool_use", "id": ids[i], "name": call.name, "input": {}});
                match &call.input {
                    Some(v) => block["input"] = v.clone(),
                    None => block["__lumo_invalid_input"] = Value::Bool(true),
                }
                content.push(block);
            }
            let stop_reason = if !parsed.calls.is_empty() {
                "tool_use"
            } else if hit_limit {
                "max_tokens"
            } else {
                "end_turn"
            };
            return Ok(ModelResponse {
                content,
                stop_reason: stop_reason.into(),
                stop_details: None,
                usage: Usage { input_tokens: prompt_tokens, output_tokens, ..Default::default() },
                model: self.model_id.clone(),
            });
        }
    }
}

/// Stream what is new since the last call: text the user can see, and tool calls as they finish.
fn emit(now: &Parsed, shown: &mut String, ids: &mut Vec<String>, sink: EventSink<'_>) {
    if now.text.len() > shown.len() && now.text.starts_with(shown.as_str()) {
        sink(StreamEvent::TextDelta(now.text[shown.len()..].to_string()));
        *shown = now.text.clone();
    }
    while ids.len() < now.calls.len() {
        let id = format!("toolu_local_{}", uuid::Uuid::new_v4().simple());
        sink(StreamEvent::ToolUseStarted { id: id.clone(), name: now.calls[ids.len()].name.clone() });
        ids.push(id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Message;
    use crate::model::ModelRequest;

    /// Lumo's system prompt and full tool list must leave most of each model's context window for
    /// the conversation (about 3 characters per token for this JSON-heavy text).
    #[test]
    fn the_standard_prompt_fits_every_catalog_model() {
        let defs = crate::tools::Registry::standard().defs(None);
        let sys = crate::agent::prompt::system_prompt(&crate::settings::Settings::default(), None);
        for e in crate::local_models::CATALOG {
            let chars = match format::render(e.family, &sys, &tools_for(e.context_tokens, &defs), &[], "low", "2026-10-16") {
                format::Prompt::Raw(s) => s.len(),
                format::Prompt::Chat { turns, .. } => turns.iter().map(|t| t.1.len()).sum(),
            };
            assert!(chars / 3 < e.context_tokens as usize / 2, "{}: {chars} chars", e.id);
        }
    }

    #[test]
    fn small_models_skip_only_the_listed_tools() {
        let defs = crate::tools::Registry::standard().defs(None);
        for name in SMALL_CONTEXT_SKIP {
            assert!(defs.iter().any(|d| d.name == *name), "{name} is not a tool any more");
        }
        let small = tools_for(16_384, &defs);
        assert_eq!(small.len(), defs.len() - SMALL_CONTEXT_SKIP.len());
        assert!(small.iter().any(|d| d.name == "find_places"));
        assert_eq!(tools_for(32_768, &defs).len(), defs.len());
    }

    #[test]
    fn drops_whole_turns_from_the_front() {
        let msgs = vec![
            Message::user(vec![json!({"type": "text", "text": "a"})]),
            Message::assistant(vec![json!({"type": "tool_use", "id": "t", "name": "x", "input": {}})]),
            Message::user(vec![json!({"type": "tool_result", "tool_use_id": "t", "content": "r"})]),
            Message::assistant(vec![json!({"type": "text", "text": "done"})]),
            Message::user(vec![json!({"type": "text", "text": "b"})]),
        ];
        assert_eq!(next_turn_start(&msgs, 0), Some(4));
        assert_eq!(next_turn_start(&msgs, 4), None);
    }

    // ---- Smoke tests against a real GGUF file (not run by default) ----------------------------
    //
    //   LUMO_SMOKE_GGUF=/path/to/model.gguf cargo test --lib smoke -- --ignored --nocapture --test-threads=1
    //
    // `engine_runs_any_gguf` works with any model (even a tiny random one); the Qwen3 test needs a
    // real Qwen3 file such as Qwen3-0.6B-Q8_0.gguf or Qwen3-4B-Q4_K_M.gguf.

    fn smoke_provider(engine: Arc<Engine>) -> Option<LocalProvider> {
        let path = PathBuf::from(std::env::var_os("LUMO_SMOKE_GGUF")?);
        let mut entry = crate::local_models::catalog_entry("qwen3:4b").unwrap().clone();
        entry.context_tokens = 4096;
        Some(LocalProvider::new(engine, &entry, path))
    }

    fn request(messages: Vec<Message>, tools: Vec<crate::model::ToolDef>) -> ModelRequest {
        ModelRequest {
            model: "qwen3:4b".into(),
            system: "You are a helpful assistant.".into(),
            tools,
            server_tools: Default::default(),
            messages,
            max_tokens: 64,
            effort: "low".into(),
        }
    }

    #[tokio::test]
    #[ignore = "needs LUMO_SMOKE_GGUF"]
    async fn smoke_engine_runs_any_gguf() {
        let engine = Arc::new(Engine::default());
        let Some(p) = smoke_provider(engine.clone()) else { return };
        let events = parking_lot::Mutex::new(Vec::new());
        let sink = |e: StreamEvent| events.lock().push(e);
        let msgs = vec![Message::user(vec![json!({"type": "text", "text": "Say hello."})])];
        let t = std::time::Instant::now();
        let r = p.complete(&request(msgs.clone(), vec![]), &sink, &CancellationToken::new()).await.unwrap();
        eprintln!("first: {:?} in {:?}, usage {:?}", r.content, t.elapsed(), r.usage);
        assert!(r.usage.input_tokens > 0 && r.usage.output_tokens > 0);
        // The same prompt again reuses the cache and still works.
        let t = std::time::Instant::now();
        let r2 = p.complete(&request(msgs.clone(), vec![]), &sink, &CancellationToken::new()).await.unwrap();
        eprintln!("second: {:?} in {:?}", r2.usage, t.elapsed());
        assert_eq!(r.usage.input_tokens, r2.usage.input_tokens);
        // Cancelling stops the run.
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert!(matches!(p.complete(&request(msgs, vec![]), &sink, &cancel).await, Err(LumoError::Cancelled)));
        // Unloading and running again loads the model again.
        engine.unload();
        let r3 = p
            .complete(&request(vec![Message::user(vec![json!({"type": "text", "text": "Hi"})])], vec![]), &sink, &CancellationToken::new())
            .await;
        assert!(r3.is_ok(), "{:?}", r3.err());
        eprintln!("accelerator: {}", engine::accelerator());
    }

    #[tokio::test]
    #[ignore = "needs LUMO_SMOKE_GGUF pointing at a Qwen3 GGUF"]
    async fn smoke_qwen3_chats_and_calls_a_tool() {
        let Some(p) = smoke_provider(Arc::new(Engine::default())) else { return };
        let streamed = parking_lot::Mutex::new(String::new());
        let sink = |e: StreamEvent| {
            if let StreamEvent::TextDelta(t) = e {
                streamed.lock().push_str(&t)
            }
        };
        let r = p
            .complete(
                &request(
                    vec![Message::user(vec![json!({"type": "text", "text": "What is the capital of France? Answer in one word."})])],
                    vec![],
                ),
                &sink,
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        eprintln!("chat: {:?} streamed {:?}", r.content, streamed.lock());
        let text = r.content[0]["text"].as_str().unwrap();
        assert!(text.contains("Paris"), "{text}");
        assert!(!text.contains("<think>") && !text.contains("<|im_end|>"), "{text}");

        let weather = crate::model::ToolDef {
            name: "get_weather".into(),
            description: "Get the current weather for a city.".into(),
            input_schema: json!({"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}),
        };
        let ask = Message::user(vec![json!({"type": "text", "text": "What's the weather in Paris right now?"})]);
        let r = p.complete(&request(vec![ask.clone()], vec![weather.clone()]), &|_| {}, &CancellationToken::new()).await.unwrap();
        eprintln!("tool call: {:?} ({})", r.content, r.stop_reason);
        assert_eq!(r.stop_reason, "tool_use");
        let call = r.content.iter().find(|b| b["type"] == "tool_use").unwrap().clone();
        assert_eq!(call["name"], "get_weather");
        assert!(call["input"]["city"].as_str().unwrap().contains("Paris"));

        // The result goes back, and the model answers from it.
        let msgs = vec![
            ask,
            Message::assistant(r.content.clone()),
            Message::user(vec![json!({"type": "tool_result", "tool_use_id": call["id"], "content": "Sunny, 21 °C"})]),
        ];
        let r = p.complete(&request(msgs, vec![weather]), &|_| {}, &CancellationToken::new()).await.unwrap();
        eprintln!("answer: {:?}", r.content);
        assert_eq!(r.stop_reason, "end_turn");
        assert!(r.content[0]["text"].as_str().unwrap().contains("21"));
    }
}
