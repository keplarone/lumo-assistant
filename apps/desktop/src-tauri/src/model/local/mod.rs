//! The on-device model provider: runs a downloaded GGUF model with the built-in llama.cpp engine.
//! It implements the same `ModelProvider` trait as the cloud adapters, so the agent loop does not
//! know the difference: history in, streamed text and tool calls out.
//!
//! A vision model (Nebula Vision) also gets the screenshots and images in the history, and screen
//! control. It points on Qwen3-VL's 0–1000 grid, so it is offered the grid wording of
//! `control_computer`, and its calls are marked `coordinate_space: "relative_1000"` for the tool to
//! convert to screenshot pixels. Nothing here changes what cloud models see.

pub mod engine;
pub mod format;

use super::{EventSink, ModelProvider, ModelRequest, ModelResponse, StreamEvent, Usage};
use crate::error::{LumoError, Result};
use crate::tools::computer;
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
    /// The image projector of a vision model, next to the model file.
    mmproj: Option<PathBuf>,
}

impl LocalProvider {
    pub fn new(engine: Arc<Engine>, entry: &crate::local_models::CatalogEntry, path: PathBuf) -> Self {
        let mmproj = entry.projector.map(|p| path.with_file_name(p.file_name));
        LocalProvider {
            engine,
            display_name: entry.tier.to_string(),
            model_id: entry.id.to_string(),
            path,
            family: entry.family,
            n_ctx: entry.context_tokens,
            mmproj,
        }
    }

    fn vision(&self) -> bool {
        self.family.sees_images() && self.mmproj.is_some()
    }

    fn sampling(&self) -> Sampling {
        match self.family {
            // Qwen3's recommended settings for non-thinking mode.
            // Qwen3-VL's recommended settings for the Instruct model are the same.
            Family::Qwen3 | Family::Qwen3Vl => Sampling { temperature: 0.7, top_k: 20, top_p: 0.8, min_p: 0.0 },
            // OpenAI's recommended settings for gpt-oss.
            Family::Harmony => Sampling { temperature: 1.0, top_k: 0, top_p: 1.0, min_p: 0.0 },
        }
    }
}

/// Tools that need eyes: screen control and screenshots. Offered only to vision models; a text-only
/// model would get "[cannot see images]" back and could only guess where to click.
const SCREEN_TOOLS: &[&str] = &["control_computer", "take_screenshot"];

/// Tools left out for models with a 16k context window: they would crowd out the conversation, and a
/// small on-device model can't use them well anyway (the project, publishing and deploy tools are
/// long multi-step developer flows). Other tools can grow without touching this list;
/// `the_standard_prompt_fits_every_catalog_model` guards the budget.
const SMALL_CONTEXT_SKIP: &[&str] = &["create_project", "preview_project", "save_version", "publish_to_github", "deploy_to_netlify"];

/// The tools a model with `n_ctx` tokens of context is offered; `vision` keeps the screen tools.
fn tools_for(n_ctx: u32, vision: bool, tools: &[crate::model::ToolDef]) -> Vec<crate::model::ToolDef> {
    tools
        .iter()
        .filter(|t| {
            let name = t.name.as_str();
            !(SCREEN_TOOLS.contains(&name) && !vision) && !(SMALL_CONTEXT_SKIP.contains(&name) && n_ctx <= 16_384)
        })
        .map(|t| if vision && t.name == "control_computer" { computer::relative_grid_def(t) } else { t.clone() })
        .collect()
}

/// The history as a vision model reads it: screenshot notes in grid wording, and its own earlier
/// screen-control calls without the `coordinate_space` field Lumo added (it never wrote that).
fn grid_history(messages: &[super::Message]) -> Vec<super::Message> {
    messages
        .iter()
        .map(|m| {
            let mut m = m.clone();
            for b in m.content.iter_mut() {
                if b["type"] == "tool_use" && b["name"] == "control_computer" {
                    if let Some(input) = b["input"].as_object_mut() {
                        input.remove("coordinate_space");
                    }
                }
                if b["type"] == "tool_result" {
                    if let Some(items) = b["content"].as_array_mut() {
                        for item in items.iter_mut().filter(|i| i["type"] == "text") {
                            if let Some(t) = item["text"].as_str().map(computer::relative_grid_text) {
                                item["text"] = Value::String(t);
                            }
                        }
                    }
                }
            }
            m
        })
        .collect()
}

/// A vision model's screen-control call: its x/y are on the 0–1000 grid; say so for the tool.
fn mark_grid_call(name: &str, input: &mut Value) {
    if name == "control_computer" {
        if let Some(o) = input.as_object_mut() {
            o.insert("coordinate_space".into(), json!("relative_1000"));
        }
    }
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
        let vision = self.vision();
        let tools = tools_for(self.n_ctx, vision, &req.tools);
        let grid_messages;
        let messages: &[super::Message] = if vision {
            grid_messages = grid_history(&req.messages);
            &grid_messages
        } else {
            &req.messages
        };
        // The oldest messages are left out when the conversation outgrows the context window.
        let mut from = 0;
        loop {
            let prompt = format::render(self.family, &req.system, &tools, &messages[from..], &req.effort, &today);
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
            let job_cancel = cancel.child_token();
            self.engine.submit(Job {
                path: self.path.clone(),
                mmproj: self.mmproj.clone(),
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
                    Some(v) => {
                        block["input"] = v.clone();
                        if vision {
                            mark_grid_call(&call.name, &mut block["input"]);
                        }
                    }
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
            let chars = match format::render(e.family, &sys, &tools_for(e.context_tokens, e.vision, &defs), &[], "low", "2026-10-16") {
                format::Prompt::Raw(s) => s.len(),
                format::Prompt::Chat { turns, .. } => turns.iter().map(|t| t.1.len()).sum(),
            };
            assert!(chars / 3 < e.context_tokens as usize / 2, "{}: {chars} chars", e.id);
        }
    }

    #[test]
    fn small_models_skip_only_the_listed_tools_and_only_vision_models_get_the_screen() {
        let defs = crate::tools::Registry::standard().defs(None);
        for name in SMALL_CONTEXT_SKIP.iter().chain(SCREEN_TOOLS) {
            assert!(defs.iter().any(|d| d.name == *name), "{name} is not a tool any more");
        }
        let names = |v: &[crate::model::ToolDef]| v.iter().map(|d| d.name.clone()).collect::<Vec<_>>();
        let has = |v: &[crate::model::ToolDef], n: &str| v.iter().any(|d| d.name == n);

        // Text-only, 16k: neither the developer tools nor the screen.
        let small = tools_for(16_384, false, &defs);
        assert_eq!(small.len(), defs.len() - SMALL_CONTEXT_SKIP.len() - SCREEN_TOOLS.len());
        assert!(has(&small, "find_places") && !has(&small, "control_computer") && !has(&small, "take_screenshot"));
        // Text-only, bigger context: the developer tools, still not the screen.
        let big = tools_for(32_768, false, &defs);
        assert_eq!(big.len(), defs.len() - SCREEN_TOOLS.len());
        assert!(has(&big, "create_project") && !has(&big, "control_computer"));
        // Vision keeps the screen tools at any size.
        let vision_small = tools_for(16_384, true, &defs);
        assert_eq!(vision_small.len(), defs.len() - SMALL_CONTEXT_SKIP.len());
        assert!(has(&vision_small, "control_computer") && has(&vision_small, "take_screenshot"));
        let vision = tools_for(24_576, true, &defs);
        assert_eq!(names(&vision), names(&defs));
        // ...with the grid wording of control_computer; nothing else changes.
        for (v, d) in vision.iter().zip(&defs) {
            if d.name == "control_computer" {
                assert_eq!(v, &computer::relative_grid_def(d));
                assert_ne!(v, d);
            } else {
                assert_eq!(v, d);
            }
        }
        // The catalog: only the vision entry is offered the screen.
        for e in crate::local_models::CATALOG {
            assert_eq!(has(&tools_for(e.context_tokens, e.vision, &defs), "control_computer"), e.vision, "{}", e.id);
        }
    }

    #[test]
    fn vision_models_read_the_grid_and_their_calls_are_marked() {
        let history = vec![
            Message::assistant(vec![
                json!({"type": "tool_use", "id": "c", "name": "control_computer", "input": {"reason": "r", "coordinate_space": "relative_1000", "actions": []}}),
                json!({"type": "tool_use", "id": "o", "name": "other", "input": {"coordinate_space": "kept"}}),
            ]),
            Message::user(vec![json!({"type": "tool_result", "tool_use_id": "s", "content": [
                {"type": "text", "text": "Screenshot of the main display (10×10 pixels). Coordinates for control_computer use this image's pixels."},
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "AAAA"}}
            ]})]),
        ];
        let g = grid_history(&history);
        assert_eq!(g[0].content[0]["input"], json!({"reason": "r", "actions": []}));
        assert_eq!(g[0].content[1]["input"]["coordinate_space"], "kept");
        assert_eq!(
            g[1].content[0]["content"][0]["text"],
            "Screenshot of the main display (10×10 pixels). Coordinates for control_computer are on a 0-1000 grid over this image."
        );
        assert_eq!(g[1].content[0]["content"][1], history[1].content[0]["content"][1]);

        let mut input = json!({"reason": "r", "actions": [{"type": "click", "x": 500, "y": 500}]});
        mark_grid_call("control_computer", &mut input);
        assert_eq!(input["coordinate_space"], "relative_1000");
        let mut other = json!({"x": 1});
        mark_grid_call("find_places", &mut other);
        assert_eq!(other, json!({"x": 1}));

        // The provider only treats an entry as vision when it has its projector.
        let vl = crate::local_models::catalog_entry("qwen3-vl:8b").unwrap();
        let p = LocalProvider::new(Arc::new(Engine::default()), vl, PathBuf::from("/models").join(vl.file_name));
        assert!(p.vision());
        assert_eq!(p.mmproj, Some(PathBuf::from("/models").join(vl.projector.unwrap().file_name)));
        let text = crate::local_models::catalog_entry("qwen3:8b").unwrap();
        let p = LocalProvider::new(Arc::new(Engine::default()), text, PathBuf::from("/models/x.gguf"));
        assert!(!p.vision() && p.mmproj.is_none());
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

    // ---- Vision smoke test against the real Nebula Vision files (not run by default) ----------
    //
    //   LUMO_SMOKE_VL_GGUF=/path/Qwen3VL-8B-Instruct-Q4_K_M.gguf \
    //   LUMO_SMOKE_VL_MMPROJ=/path/mmproj-Qwen3VL-8B-Instruct-Q8_0.gguf \
    //   cargo test --lib smoke_vision -- --ignored --nocapture --test-threads=1

    /// A white 1280×720 "screen" with one solid red button, and the button's rectangle.
    fn red_button_screen() -> (Vec<u8>, (i32, i32, i32, i32)) {
        let (left, top, right, bottom) = (880, 480, 1040, 544);
        let img = image::RgbImage::from_fn(1280, 720, |x, y| {
            let (x, y) = (x as i32, y as i32);
            if (left..right).contains(&x) && (top..bottom).contains(&y) {
                image::Rgb([220, 30, 30])
            } else {
                image::Rgb([255, 255, 255])
            }
        });
        let mut png = std::io::Cursor::new(Vec::new());
        img.write_to(&mut png, image::ImageFormat::Png).unwrap();
        (png.into_inner(), (left, top, right, bottom))
    }

    #[tokio::test]
    #[ignore = "needs LUMO_SMOKE_VL_GGUF and LUMO_SMOKE_VL_MMPROJ"]
    async fn smoke_vision_clicks_the_red_button() {
        use base64::Engine as _;
        let (Some(model), Some(mmproj)) = (std::env::var_os("LUMO_SMOKE_VL_GGUF"), std::env::var_os("LUMO_SMOKE_VL_MMPROJ")) else {
            return;
        };
        let mut entry = crate::local_models::catalog_entry("qwen3-vl:8b").unwrap().clone();
        // Enough for the two tools and one screenshot; keeps CI's memory use down.
        entry.context_tokens = 8192;
        let mut p = LocalProvider::new(Arc::new(Engine::default()), &entry, PathBuf::from(model));
        p.mmproj = Some(PathBuf::from(mmproj));
        assert!(p.vision());

        let (png, (left, top, right, bottom)) = red_button_screen();
        let tools: Vec<_> = crate::tools::Registry::standard()
            .defs(None)
            .into_iter()
            .filter(|d| d.name == "control_computer" || d.name == "take_screenshot")
            .collect();
        let msgs = vec![
            Message::user(vec![json!({"type": "text", "text": "Click the red button on my screen."})]),
            Message::assistant(vec![
                json!({"type": "tool_use", "id": "s1", "name": "take_screenshot", "input": {"reason": "to find the red button"}}),
            ]),
            Message::user(vec![json!({"type": "tool_result", "tool_use_id": "s1", "content": [
                {"type": "text", "text": "Screenshot of the main display (1280×720 pixels). Coordinates for control_computer use this image's pixels."},
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": base64::engine::general_purpose::STANDARD.encode(&png)}}
            ]})]),
        ];
        let mut req = request(msgs, tools);
        req.system = "You are Lumo, an assistant that can use the user's computer with tools.".into();
        req.max_tokens = 256;

        // Sampling is random (Qwen3-VL's recommended temperature), so ask three times.
        let mut hits = 0;
        for attempt in 1..=3 {
            let t = std::time::Instant::now();
            let r = p.complete(&req, &|_| {}, &CancellationToken::new()).await.unwrap();
            eprintln!("attempt {attempt} in {:?} ({:?}): {:?}", t.elapsed(), r.usage, r.content);
            let Some(call) = r.content.iter().find(|b| b["type"] == "tool_use" && b["name"] == "control_computer") else { continue };
            assert_eq!(call["input"]["coordinate_space"], "relative_1000");
            let Ok(input) = serde_json::from_value::<computer::ControlInput>(call["input"].clone()) else { continue };
            let Ok(px) = computer::to_screenshot_pixels(&input.actions, input.coordinate_space, 1280, 720) else { continue };
            let click = px.iter().find_map(|a| match a {
                computer::InputAction::Click { x, y, .. } => Some((*x, *y)),
                _ => None,
            });
            eprintln!("  click in screenshot pixels: {click:?}; button is ({left}, {top})-({right}, {bottom})");
            if let Some((x, y)) = click {
                if (left..right).contains(&x) && (top..bottom).contains(&y) {
                    hits += 1;
                }
            }
        }
        assert!(hits >= 2, "clicked the red button {hits} of 3 times");
    }
}
