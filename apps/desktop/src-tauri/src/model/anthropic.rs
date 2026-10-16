//! Anthropic Messages API adapter (raw HTTPS + SSE; there is no official Rust SDK).
//!
//! - Adaptive thinking with `output_config.effort`; progress notes via `thinking.display: "updates"`.
//! - Content blocks are reassembled exactly as streamed (including thinking signatures and server
//!   tool blocks) so they can be replayed unchanged: the API binds thinking blocks to the prefix.
//! - `block_binding.prefix_mismatch_behavior: "drop_block"` degrades instead of failing if a prefix
//!   ever does change (for example after a model switch).
//! - Server-side refusal fallbacks are enabled on models that support them.
//! - Optional request features are dropped automatically if the API rejects them, so a beta change
//!   degrades the experience instead of breaking every request.

use super::{retry_delay, retryable_status, EventSink, ModelProvider, ModelRequest, ModelResponse, StreamEvent, Usage};
use crate::error::{LumoError, Result};
use async_trait::async_trait;
use futures_util::StreamExt;
use serde_json::{json, Map, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use tokio_util::sync::CancellationToken;

const API_VERSION: &str = "2023-06-01";
const BETA_DISPLAY_UPDATES: &str = "thinking-display-updates-2026-08-18";
const BETA_BLOCK_BINDING: &str = "thinking-binding-controls-2026-08-01";
const BETA_FALLBACK: &str = "server-side-fallback-2026-07-01";

pub struct Anthropic {
    http: reqwest::Client,
    base_url: String,
    api_key: String,
    /// Set after the API rejected an optional feature; later requests omit them.
    minimal: AtomicBool,
}

/// What a given model accepts. Only the models Lumo offers are listed; unknown models get the
/// conservative profile.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ModelCaps {
    pub progress_updates: bool,
    pub fallbacks: bool,
    pub dynamic_web_tools: bool,
}

pub fn caps(model: &str) -> ModelCaps {
    match model {
        "claude-opus-5-5" | "claude-sonnet-5-5" | "claude-fable-5-1" => {
            ModelCaps { progress_updates: true, fallbacks: true, dynamic_web_tools: true }
        }
        "claude-opus-5" | "claude-sonnet-5" | "claude-opus-4-8" | "claude-opus-4-7" | "claude-opus-4-6" | "claude-sonnet-4-6" => {
            ModelCaps { progress_updates: false, fallbacks: false, dynamic_web_tools: true }
        }
        _ => ModelCaps { progress_updates: false, fallbacks: false, dynamic_web_tools: false },
    }
}

impl Anthropic {
    pub fn new(http: reqwest::Client, base_url: &str, api_key: String) -> Self {
        Anthropic { http, base_url: base_url.trim_end_matches('/').to_string(), api_key, minimal: AtomicBool::new(false) }
    }

    /// Build the request body and beta header list.
    pub fn build_body(&self, req: &ModelRequest, minimal: bool) -> (Value, Vec<&'static str>) {
        let caps = caps(&req.model);
        let mut betas = Vec::new();
        let mut thinking = Map::new();
        thinking.insert("type".into(), json!("adaptive"));
        if !minimal {
            if caps.progress_updates {
                thinking.insert("display".into(), json!("updates"));
                betas.push(BETA_DISPLAY_UPDATES);
            }
            thinking.insert("block_binding".into(), json!({"prefix_mismatch_behavior": "drop_block"}));
            betas.push(BETA_BLOCK_BINDING);
        }

        let mut tools: Vec<Value> = req
            .tools
            .iter()
            .map(|t| {
                json!({
                    "name": t.name,
                    "description": t.description,
                    "input_schema": t.input_schema,
                    "eager_input_streaming": true,
                })
            })
            .collect();
        if req.server_tools.web_search {
            let ty = if caps.dynamic_web_tools { "web_search_20260209" } else { "web_search_20250305" };
            tools.push(json!({"type": ty, "name": "web_search", "max_uses": 8}));
        }
        if req.server_tools.web_fetch {
            let ty = if caps.dynamic_web_tools { "web_fetch_20260209" } else { "web_fetch_20250910" };
            tools.push(json!({"type": ty, "name": "web_fetch", "max_uses": 8}));
        }
        if req.server_tools.computer {
            tools.push(json!({"type": "computer_toolset_20260801", "configs": {"zoom": {"enabled": false}}}));
        }

        let messages: Vec<Value> = req.messages.iter().map(|m| json!({"role": m.role, "content": m.content})).collect();

        let mut body = json!({
            "model": req.model,
            "max_tokens": req.max_tokens,
            "stream": true,
            "system": [{"type": "text", "text": req.system}],
            "messages": messages,
            "thinking": Value::Object(thinking),
            "output_config": {"effort": req.effort},
            "cache_control": {"type": "ephemeral"},
        });
        if !tools.is_empty() {
            body["tools"] = Value::Array(tools);
        }
        if !minimal && caps.fallbacks {
            body["fallbacks"] = json!("default");
            betas.push(BETA_FALLBACK);
        }
        (body, betas)
    }

    async fn attempt(
        &self,
        req: &ModelRequest,
        minimal: bool,
        sink: EventSink<'_>,
        cancel: &CancellationToken,
        emitted: &mut bool,
    ) -> std::result::Result<ModelResponse, AttemptError> {
        let (body, betas) = self.build_body(req, minimal);
        let mut rb = self
            .http
            .post(format!("{}/v1/messages", self.base_url))
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", API_VERSION)
            .header("content-type", "application/json")
            .json(&body);
        if !betas.is_empty() {
            rb = rb.header("anthropic-beta", betas.join(","));
        }
        let resp = tokio::select! {
            r = rb.send() => r.map_err(|e| AttemptError::Retryable(e.to_string(), None))?,
            _ = cancel.cancelled() => return Err(AttemptError::Fatal(LumoError::Cancelled)),
        };
        let status = resp.status().as_u16();
        if status >= 400 {
            let retry_after = resp.headers().get("retry-after").and_then(|v| v.to_str().ok()).map(String::from);
            let text = resp.text().await.unwrap_or_default();
            let message = serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|v| v["error"]["message"].as_str().map(String::from))
                .unwrap_or_else(|| crate::util::preview(&text, 300));
            if retryable_status(status) {
                return Err(AttemptError::Retryable(format!("{status}: {message}"), retry_after));
            }
            if status == 400 && !minimal && mentions_optional_feature(&message) {
                return Err(AttemptError::Degrade(message));
            }
            return Err(AttemptError::Fatal(LumoError::Provider(describe_status(status, &message))));
        }

        let mut asm = Assembler::default();
        let mut events = Box::pin(super::sse::events(resp.bytes_stream()));
        loop {
            let next = tokio::select! {
                n = events.next() => n,
                _ = cancel.cancelled() => return Err(AttemptError::Fatal(LumoError::Cancelled)),
            };
            let Some(item) = next else { break };
            let ev = item.map_err(|e| {
                if *emitted {
                    AttemptError::Fatal(LumoError::Provider(format!("The connection to Anthropic dropped mid-response: {e}")))
                } else {
                    AttemptError::Retryable(e.to_string(), None)
                }
            })?;
            if ev.data.is_empty() {
                continue;
            }
            let data: Value = match serde_json::from_str(&ev.data) {
                Ok(v) => v,
                Err(_) => continue,
            };
            match asm.apply(&data, sink, emitted) {
                Ok(true) => break,
                Ok(false) => {}
                Err(StreamError::Api(kind, msg)) => {
                    let retry = matches!(kind.as_str(), "overloaded_error" | "api_error" | "rate_limit_error");
                    return Err(if retry && !*emitted {
                        AttemptError::Retryable(msg, None)
                    } else {
                        AttemptError::Fatal(LumoError::Provider(msg))
                    });
                }
            }
        }
        asm.finish(&req.model).map_err(AttemptError::Fatal)
    }
}

enum AttemptError {
    Retryable(String, Option<String>),
    Degrade(String),
    Fatal(LumoError),
}

fn mentions_optional_feature(msg: &str) -> bool {
    let m = msg.to_ascii_lowercase();
    ["beta", "display", "block_binding", "fallbacks", "extra inputs", "eager_input_streaming", "cache_control"]
        .iter()
        .any(|k| m.contains(k))
}

fn describe_status(status: u16, message: &str) -> String {
    match status {
        401 => "Anthropic rejected the API key. Check it in Settings → Model.".into(),
        403 => format!("Anthropic refused the request: {message}"),
        404 => format!("Anthropic could not find that model or endpoint: {message}"),
        413 => "The request was too large for the API. Try attaching fewer or smaller files.".into(),
        _ => format!("Anthropic returned an error ({status}): {message}"),
    }
}

#[async_trait]
impl ModelProvider for Anthropic {
    fn name(&self) -> &'static str {
        "anthropic"
    }

    async fn complete(&self, req: &ModelRequest, sink: EventSink<'_>, cancel: &CancellationToken) -> Result<ModelResponse> {
        let mut attempt = 0u32;
        loop {
            let minimal = self.minimal.load(Ordering::Relaxed);
            let mut emitted = false;
            match self.attempt(req, minimal, sink, cancel, &mut emitted).await {
                Ok(r) => return Ok(r),
                Err(AttemptError::Fatal(e)) => return Err(e),
                Err(AttemptError::Degrade(msg)) => {
                    log::warn!("Anthropic rejected optional request features, retrying without them: {msg}");
                    self.minimal.store(true, Ordering::Relaxed);
                }
                Err(AttemptError::Retryable(msg, retry_after)) => {
                    attempt += 1;
                    if attempt > 3 {
                        return Err(LumoError::Provider(format!("Anthropic is unavailable right now ({msg}). Please try again shortly.")));
                    }
                    let d = retry_delay(attempt, retry_after.as_deref());
                    log::warn!("Anthropic request failed ({msg}); retry {attempt} in {d:?}");
                    tokio::select! {
                        _ = tokio::time::sleep(d) => {}
                        _ = cancel.cancelled() => return Err(LumoError::Cancelled),
                    }
                }
            }
        }
    }
}

enum StreamError {
    Api(String, String),
}

/// Rebuilds content blocks from stream events.
#[derive(Default)]
struct Assembler {
    blocks: Vec<Value>,
    partial_json: Vec<String>,
    stop_reason: Option<String>,
    stop_details: Option<Value>,
    usage: Usage,
    model: Option<String>,
}

impl Assembler {
    /// Returns Ok(true) at message_stop.
    fn apply(&mut self, d: &Value, sink: EventSink<'_>, emitted: &mut bool) -> std::result::Result<bool, StreamError> {
        match d["type"].as_str().unwrap_or("") {
            "message_start" => {
                self.model = d["message"]["model"].as_str().map(String::from);
                merge_usage(&mut self.usage, &d["message"]["usage"]);
            }
            "content_block_start" => {
                let idx = d["index"].as_u64().unwrap_or(self.blocks.len() as u64) as usize;
                let block = d["content_block"].clone();
                while self.blocks.len() <= idx {
                    self.blocks.push(Value::Null);
                    self.partial_json.push(String::new());
                }
                match block["type"].as_str().unwrap_or("") {
                    "tool_use" => {
                        *emitted = true;
                        sink(StreamEvent::ToolUseStarted {
                            id: block["id"].as_str().unwrap_or("").into(),
                            name: block["name"].as_str().unwrap_or("").into(),
                        });
                    }
                    "server_tool_use" => {
                        *emitted = true;
                        sink(StreamEvent::ServerToolStarted { name: block["name"].as_str().unwrap_or("").into() });
                    }
                    t if t.ends_with("_tool_result") => {
                        sink(StreamEvent::ServerToolFinished {
                            name: t.trim_end_matches("_tool_result").into(),
                            summary: summarize_server_result(&block),
                        });
                    }
                    _ => {}
                }
                self.blocks[idx] = block;
            }
            "content_block_delta" => {
                let idx = d["index"].as_u64().unwrap_or(0) as usize;
                let delta = &d["delta"];
                let Some(block) = self.blocks.get_mut(idx) else { return Ok(false) };
                match delta["type"].as_str().unwrap_or("") {
                    "text_delta" => {
                        let t = delta["text"].as_str().unwrap_or("");
                        append_str(block, "text", t);
                        *emitted = true;
                        sink(StreamEvent::TextDelta(t.to_string()));
                    }
                    "thinking_delta" => append_str(block, "thinking", delta["thinking"].as_str().unwrap_or("")),
                    "signature_delta" => {
                        block["signature"] =
                            json!(format!("{}{}", block["signature"].as_str().unwrap_or(""), delta["signature"].as_str().unwrap_or("")));
                    }
                    "input_json_delta" => self.partial_json[idx].push_str(delta["partial_json"].as_str().unwrap_or("")),
                    "citations_delta" => {
                        if !block["citations"].is_array() {
                            block["citations"] = json!([]);
                        }
                        if let Some(arr) = block["citations"].as_array_mut() {
                            arr.push(delta["citation"].clone());
                        }
                    }
                    _ => {}
                }
            }
            "content_block_stop" => {
                let idx = d["index"].as_u64().unwrap_or(0) as usize;
                if let Some(block) = self.blocks.get_mut(idx) {
                    let ty = block["type"].as_str().unwrap_or("").to_string();
                    if ty == "tool_use" || ty == "server_tool_use" {
                        let raw = std::mem::take(&mut self.partial_json[idx]);
                        if !raw.trim().is_empty() {
                            match serde_json::from_str::<Value>(&raw) {
                                Ok(v) if v.is_object() => block["input"] = v,
                                _ => {
                                    // Invalid or truncated input: replay an empty object and let the agent
                                    // return an error result instead of executing anything.
                                    block["input"] = json!({});
                                    block["__lumo_invalid_input"] = json!(true);
                                }
                            }
                        } else if !block["input"].is_object() {
                            block["input"] = json!({});
                        }
                    }
                    if ty == "thinking" {
                        let note = block["thinking"].as_str().unwrap_or("").trim().to_string();
                        if !note.is_empty() {
                            sink(StreamEvent::ProgressNote(note));
                        }
                    }
                }
            }
            "message_delta" => {
                if let Some(r) = d["delta"]["stop_reason"].as_str() {
                    self.stop_reason = Some(r.to_string());
                }
                if !d["delta"]["stop_details"].is_null() {
                    self.stop_details = Some(d["delta"]["stop_details"].clone());
                }
                merge_usage(&mut self.usage, &d["usage"]);
            }
            "message_stop" => return Ok(true),
            "error" => {
                return Err(StreamError::Api(
                    d["error"]["type"].as_str().unwrap_or("error").to_string(),
                    d["error"]["message"].as_str().unwrap_or("The model stream reported an error").to_string(),
                ))
            }
            _ => {}
        }
        Ok(false)
    }

    fn finish(mut self, requested_model: &str) -> Result<ModelResponse> {
        let Some(stop_reason) = self.stop_reason.take() else {
            return Err(LumoError::Provider("The response ended before it was complete. Please try again.".into()));
        };
        let content = self.blocks.into_iter().filter(|b| !b.is_null()).collect();
        Ok(ModelResponse {
            content,
            stop_reason,
            stop_details: self.stop_details,
            usage: self.usage,
            model: self.model.unwrap_or_else(|| requested_model.to_string()),
        })
    }
}

fn append_str(block: &mut Value, key: &str, s: &str) {
    let cur = block[key].as_str().unwrap_or("").to_string();
    block[key] = json!(cur + s);
}

fn merge_usage(u: &mut Usage, v: &Value) {
    let get = |k: &str| v[k].as_u64();
    if let Some(x) = get("input_tokens") {
        u.input_tokens = u.input_tokens.max(x);
    }
    if let Some(x) = get("output_tokens") {
        u.output_tokens = u.output_tokens.max(x);
    }
    if let Some(x) = get("cache_read_input_tokens") {
        u.cache_read_input_tokens = u.cache_read_input_tokens.max(x);
    }
    if let Some(x) = get("cache_creation_input_tokens") {
        u.cache_creation_input_tokens = u.cache_creation_input_tokens.max(x);
    }
}

fn summarize_server_result(block: &Value) -> String {
    match &block["content"] {
        Value::Array(items) => {
            let titles: Vec<&str> = items.iter().filter_map(|i| i["title"].as_str()).take(3).collect();
            if titles.is_empty() {
                format!("{} results", items.len())
            } else {
                format!("{} results: {}", items.len(), titles.join(" · "))
            }
        }
        Value::Object(o) => {
            if let Some(code) = o.get("error_code").and_then(|c| c.as_str()) {
                format!("failed ({code})")
            } else if let Some(url) = o.get("url").and_then(|u| u.as_str()) {
                format!("read {url}")
            } else {
                "done".into()
            }
        }
        _ => "done".into(),
    }
}

/// Strip internal markers before a block goes back to the API.
pub fn clean_for_replay(content: &[Value]) -> Vec<Value> {
    content
        .iter()
        .map(|b| {
            let mut b = b.clone();
            if let Some(o) = b.as_object_mut() {
                o.remove("__lumo_invalid_input");
            }
            b
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Message, ServerTools, ToolDef};
    use std::sync::{Arc, Mutex};
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, Request, ResponseTemplate};

    fn sse(events: &[Value]) -> String {
        events.iter().map(|e| format!("event: {}\ndata: {}\n\n", e["type"].as_str().unwrap(), e)).collect()
    }

    fn req() -> ModelRequest {
        ModelRequest {
            model: "claude-opus-5-5".into(),
            system: "You are Lumo.".into(),
            tools: vec![ToolDef {
                name: "list_directory".into(),
                description: "List a folder".into(),
                input_schema: json!({"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}),
            }],
            server_tools: ServerTools { web_search: true, web_fetch: true, computer: false },
            messages: vec![Message::user(vec![json!({"type": "text", "text": "What's in Downloads?"})])],
            max_tokens: 32000,
            effort: "medium".into(),
        }
    }

    fn tool_stream() -> String {
        sse(&[
            json!({"type": "message_start", "message": {"id": "msg_1", "model": "claude-opus-5-5", "usage": {"input_tokens": 120, "cache_read_input_tokens": 100}}}),
            json!({"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": "", "signature": ""}}),
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "Checking the folder."}}),
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": "sig-abc"}}),
            json!({"type": "content_block_stop", "index": 0}),
            json!({"type": "content_block_start", "index": 1, "content_block": {"type": "text", "text": ""}}),
            json!({"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "Let me look."}}),
            json!({"type": "content_block_stop", "index": 1}),
            json!({"type": "content_block_start", "index": 2, "content_block": {"type": "tool_use", "id": "toolu_1", "name": "list_directory", "input": {}}}),
            json!({"type": "content_block_delta", "index": 2, "delta": {"type": "input_json_delta", "partial_json": "{\"path\": \"~/Dow"}}),
            json!({"type": "content_block_delta", "index": 2, "delta": {"type": "input_json_delta", "partial_json": "nloads\"}"}}),
            json!({"type": "content_block_stop", "index": 2}),
            json!({"type": "message_delta", "delta": {"stop_reason": "tool_use"}, "usage": {"output_tokens": 42}}),
            json!({"type": "message_stop"}),
        ])
    }

    #[tokio::test]
    async fn streams_and_reassembles_blocks_exactly() {
        let server = MockServer::start().await;
        let seen: Arc<Mutex<Vec<Request>>> = Arc::default();
        let seen2 = seen.clone();
        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .and(header("x-api-key", "sk-test"))
            .and(header("anthropic-version", "2023-06-01"))
            .respond_with(move |r: &Request| {
                seen2.lock().unwrap().push(r.clone());
                ResponseTemplate::new(200).set_body_raw(tool_stream(), "text/event-stream")
            })
            .mount(&server)
            .await;

        let p = Anthropic::new(reqwest::Client::new(), &server.uri(), "sk-test".into());
        let events: Arc<Mutex<Vec<StreamEvent>>> = Arc::default();
        let ev2 = events.clone();
        let sink = move |e: StreamEvent| ev2.lock().unwrap().push(e);
        let r = p.complete(&req(), &sink, &CancellationToken::new()).await.unwrap();

        assert_eq!(r.stop_reason, "tool_use");
        assert_eq!(r.content.len(), 3);
        assert_eq!(r.content[0], json!({"type": "thinking", "thinking": "Checking the folder.", "signature": "sig-abc"}));
        assert_eq!(r.content[1], json!({"type": "text", "text": "Let me look."}));
        assert_eq!(r.content[2]["input"], json!({"path": "~/Downloads"}));
        assert_eq!(r.usage.input_tokens, 120);
        assert_eq!(r.usage.output_tokens, 42);
        assert_eq!(r.usage.cache_read_input_tokens, 100);
        let ev = events.lock().unwrap();
        assert!(ev.contains(&StreamEvent::ProgressNote("Checking the folder.".into())));
        assert!(ev.contains(&StreamEvent::TextDelta("Let me look.".into())));

        // Request shape: adaptive thinking with updates, server tools, eager streaming, betas.
        let body: Value = serde_json::from_slice(&seen.lock().unwrap()[0].body).unwrap();
        assert_eq!(body["thinking"]["type"], "adaptive");
        assert_eq!(body["thinking"]["display"], "updates");
        assert_eq!(body["thinking"]["block_binding"]["prefix_mismatch_behavior"], "drop_block");
        assert_eq!(body["output_config"]["effort"], "medium");
        assert_eq!(body["fallbacks"], "default");
        assert_eq!(body["tools"][0]["eager_input_streaming"], true);
        assert_eq!(body["tools"][1]["type"], "web_search_20260209");
        assert_eq!(body["tools"][2]["type"], "web_fetch_20260209");
        assert!(body.get("temperature").is_none());
        let beta = seen.lock().unwrap()[0].headers.get("anthropic-beta").unwrap().to_str().unwrap().to_string();
        assert!(beta.contains(BETA_DISPLAY_UPDATES) && beta.contains(BETA_BLOCK_BINDING) && beta.contains(BETA_FALLBACK));
    }

    #[tokio::test]
    async fn retries_overload_then_succeeds() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(
                ResponseTemplate::new(529)
                    .insert_header("retry-after", "0")
                    .set_body_string(r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#),
            )
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_raw(tool_stream(), "text/event-stream"))
            .mount(&server)
            .await;
        let p = Anthropic::new(reqwest::Client::new(), &server.uri(), "k".into());
        let r = p.complete(&req(), &|_| {}, &CancellationToken::new()).await.unwrap();
        assert_eq!(r.stop_reason, "tool_use");
    }

    #[tokio::test]
    async fn degrades_when_an_optional_feature_is_rejected() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(header("anthropic-beta", &*format!("{BETA_DISPLAY_UPDATES},{BETA_BLOCK_BINDING},{BETA_FALLBACK}")))
            .respond_with(
                ResponseTemplate::new(400).set_body_string(
                    r#"{"type":"error","error":{"type":"invalid_request_error","message":"thinking.display: unknown beta"}}"#,
                ),
            )
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_raw(tool_stream(), "text/event-stream"))
            .mount(&server)
            .await;
        let p = Anthropic::new(reqwest::Client::new(), &server.uri(), "k".into());
        assert!(p.complete(&req(), &|_| {}, &CancellationToken::new()).await.is_ok());
        let (body, betas) = p.build_body(&req(), true);
        assert!(betas.is_empty());
        assert!(body["thinking"].get("display").is_none());
        assert!(body.get("fallbacks").is_none());
    }

    #[tokio::test]
    async fn bad_key_is_a_clear_error_and_not_retried() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(
                ResponseTemplate::new(401)
                    .set_body_string(r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#),
            )
            .expect(1)
            .mount(&server)
            .await;
        let p = Anthropic::new(reqwest::Client::new(), &server.uri(), "bad".into());
        let e = p.complete(&req(), &|_| {}, &CancellationToken::new()).await.unwrap_err();
        assert!(e.to_string().contains("rejected the API key"));
    }

    #[tokio::test]
    async fn truncated_tool_input_is_flagged_not_executed() {
        let server = MockServer::start().await;
        let body = sse(&[
            json!({"type": "message_start", "message": {"model": "claude-opus-5-5", "usage": {"input_tokens": 1}}}),
            json!({"type": "content_block_start", "index": 0, "content_block": {"type": "tool_use", "id": "t", "name": "write_file", "input": {}}}),
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": "{\"path\": \"a.txt\", \"content\": \"unterm"}}),
            json!({"type": "content_block_stop", "index": 0}),
            json!({"type": "message_delta", "delta": {"stop_reason": "max_tokens"}, "usage": {"output_tokens": 5}}),
            json!({"type": "message_stop"}),
        ]);
        Mock::given(method("POST")).respond_with(ResponseTemplate::new(200).set_body_raw(body, "text/event-stream")).mount(&server).await;
        let p = Anthropic::new(reqwest::Client::new(), &server.uri(), "k".into());
        let r = p.complete(&req(), &|_| {}, &CancellationToken::new()).await.unwrap();
        assert_eq!(r.stop_reason, "max_tokens");
        assert_eq!(r.content[0]["input"], json!({}));
        assert_eq!(r.content[0]["__lumo_invalid_input"], true);
        assert!(clean_for_replay(&r.content)[0].get("__lumo_invalid_input").is_none());
    }

    #[tokio::test]
    async fn stream_without_stop_reason_is_an_error() {
        let server = MockServer::start().await;
        let body = sse(&[json!({"type": "message_start", "message": {"model": "m", "usage": {}}})]);
        Mock::given(method("POST")).respond_with(ResponseTemplate::new(200).set_body_raw(body, "text/event-stream")).mount(&server).await;
        let p = Anthropic::new(reqwest::Client::new(), &server.uri(), "k".into());
        assert!(p.complete(&req(), &|_| {}, &CancellationToken::new()).await.is_err());
    }

    #[test]
    fn haiku_gets_basic_web_tools_and_no_updates() {
        let p = Anthropic::new(reqwest::Client::new(), "https://x", "k".into());
        let mut r = req();
        r.model = "claude-haiku-5-5".into();
        let (body, betas) = p.build_body(&r, false);
        assert_eq!(body["tools"][1]["type"], "web_search_20250305");
        assert!(body["thinking"].get("display").is_none());
        assert!(body.get("fallbacks").is_none());
        assert_eq!(betas, vec![BETA_BLOCK_BINDING]);
    }
}
