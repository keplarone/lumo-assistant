//! Lumo's models: a client for Lumo's model gateway (services/license, `POST /api/chat`), which runs
//! OpenRouter models with Lumo's own key after checking the plan, its models and its monthly allowance.
//! The app never holds a model provider key. Requests and responses are OpenAI-style Chat Completions;
//! the canonical (Anthropic-shaped) history is converted here.

use super::{retry_delay, EventSink, Message, ModelProvider, ModelRequest, ModelResponse, StreamEvent, Usage};
use crate::error::{LumoError, Result};
use async_trait::async_trait;
use futures_util::StreamExt;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

/// Older screenshots are dropped from what's sent: they cost the most and the model has acted on them.
const MAX_IMAGES: usize = 3;

pub struct LumoCloud {
    http: reqwest::Client,
    /// The gateway's base address, e.g. https://lumo-license.vercel.app.
    base_url: String,
    install_id: String,
    auth: GatewayAuth,
}

/** Who the gateway is told is asking. */
enum GatewayAuth {
    /// Builds without accounts: the license key on paid plans; Free is counted by the install id.
    License(Option<String>),
    /// The signed-in Lumo account: a fresh access token on every call (see account.rs).
    Account(std::sync::Weak<crate::core::Core>),
}

impl LumoCloud {
    pub fn new(http: reqwest::Client, base_url: &str, install_id: String, license_key: Option<String>) -> Self {
        LumoCloud { http, base_url: base_url.trim_end_matches('/').to_string(), install_id, auth: GatewayAuth::License(license_key) }
    }

    pub fn for_account(http: reqwest::Client, base_url: &str, install_id: String, core: std::sync::Weak<crate::core::Core>) -> Self {
        LumoCloud { http, base_url: base_url.trim_end_matches('/').to_string(), install_id, auth: GatewayAuth::Account(core) }
    }

    async fn bearer(&self, fresh: bool) -> Result<Option<String>> {
        match &self.auth {
            GatewayAuth::License(k) => Ok(k.clone()),
            GatewayAuth::Account(core) => {
                let core = core.upgrade().ok_or(LumoError::Cancelled)?;
                crate::account::gateway_token(&core, fresh).await.map(Some)
            }
        }
    }
}

/// Convert canonical (Anthropic-shaped) history into chat messages.
pub fn to_chat_messages(system: &str, messages: &[Message]) -> Vec<Value> {
    let mut out = vec![json!({"role": "system", "content": system})];
    let images: usize = messages.iter().flat_map(|m| &m.content).map(count_images).sum();
    let mut skip = images.saturating_sub(MAX_IMAGES);
    for m in messages {
        match m.role.as_str() {
            "system" => {
                let text = text_of(&m.content);
                out.push(json!({"role": "system", "content": text}));
            }
            "user" => {
                let mut parts = Vec::new();
                for b in &m.content {
                    match b["type"].as_str() {
                        Some("text") => parts.push(json!({"type": "text", "text": b["text"]})),
                        Some("image") if skip > 0 => {
                            skip -= 1;
                            parts.push(json!({"type": "text", "text": "[An earlier image, no longer shown.]"}));
                        }
                        Some("image") => {
                            if let Some(p) = image_part(b) {
                                parts.push(p);
                            }
                        }
                        Some("tool_result") => {
                            let content = match &b["content"] {
                                Value::String(s) => s.clone(),
                                Value::Array(items) => text_of(items),
                                _ => String::new(),
                            };
                            out.push(json!({"role": "tool", "tool_call_id": b["tool_use_id"], "content": content}));
                            // Chat Completions tool results are text only, so a screenshot a tool
                            // returned follows as a user message.
                            if let Value::Array(items) = &b["content"] {
                                for img in items.iter().filter(|i| i["type"] == "image") {
                                    if skip > 0 {
                                        skip -= 1;
                                    } else if let Some(p) = image_part(img) {
                                        parts.push(p);
                                    }
                                }
                            }
                        }
                        _ => {}
                    }
                }
                if !parts.is_empty() {
                    out.push(json!({"role": "user", "content": parts}));
                }
            }
            "assistant" => {
                let text = text_of(&m.content);
                let calls: Vec<Value> = m
                    .content
                    .iter()
                    .filter(|b| b["type"] == "tool_use")
                    .map(|b| json!({"id": b["id"], "type": "function", "function": {"name": b["name"], "arguments": b["input"].to_string()}}))
                    .collect();
                let mut msg = json!({"role": "assistant", "content": if text.is_empty() { Value::Null } else { json!(text) }});
                if !calls.is_empty() {
                    msg["tool_calls"] = json!(calls);
                }
                out.push(msg);
            }
            _ => {}
        }
    }
    out
}

fn image_part(b: &Value) -> Option<Value> {
    (b["source"]["type"] == "base64").then(|| {
        json!({
            "type": "image_url",
            "image_url": {"url": format!("data:{};base64,{}", b["source"]["media_type"].as_str().unwrap_or("image/png"), b["source"]["data"].as_str().unwrap_or(""))}
        })
    })
}

fn count_images(b: &Value) -> usize {
    match b["type"].as_str() {
        Some("image") => 1,
        Some("tool_result") => b["content"].as_array().map(|a| a.iter().filter(|i| i["type"] == "image").count()).unwrap_or(0),
        _ => 0,
    }
}

/// The gateway's error message, or a fallback.
fn gateway_error(status: u16, body: &str) -> LumoError {
    let v: Value = serde_json::from_str(body).unwrap_or_default();
    let msg = v["error"].as_str().map(String::from).unwrap_or_else(|| format!("Lumo's model service answered with HTTP {status}."));
    match (status, v["code"].as_str()) {
        (_, Some("plan_limit")) | (402, _) => LumoError::PlanLimit(msg),
        (_, Some("license_invalid")) | (401 | 403, _) => LumoError::Denied(msg),
        (_, Some("invalid")) | (400 | 413, _) => LumoError::Invalid(msg),
        _ => LumoError::Unavailable(msg),
    }
}

fn text_of(blocks: &[Value]) -> String {
    blocks.iter().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("\n")
}

#[async_trait]
impl ModelProvider for LumoCloud {
    fn name(&self) -> &'static str {
        "lumo"
    }

    async fn complete(&self, req: &ModelRequest, sink: EventSink<'_>, cancel: &CancellationToken) -> Result<ModelResponse> {
        let tools: Vec<Value> = req
            .tools
            .iter()
            .map(|t| json!({"type": "function", "function": {"name": t.name, "description": t.description, "parameters": t.input_schema}}))
            .collect();
        let mut body = json!({
            "model": req.model,
            "stream": true,
            "max_tokens": req.max_tokens.min(8192),
            "messages": to_chat_messages(&req.system, &req.messages),
        });
        if !tools.is_empty() {
            body["tools"] = json!(tools);
        }

        let mut attempt = 0;
        let mut fresh_token = false;
        let resp = loop {
            let mut rb = self.http.post(format!("{}/api/chat", self.base_url)).header("X-Lumo-Install", &self.install_id).json(&body);
            if let Some(k) = self.bearer(fresh_token).await? {
                rb = rb.bearer_auth(k);
            }
            let r = tokio::select! {
                r = rb.send() => r,
                _ = cancel.cancelled() => return Err(LumoError::Cancelled),
            };
            match r {
                Ok(r) if r.status().is_success() => break r,
                Ok(r) => {
                    let status = r.status().as_u16();
                    let ra = r.headers().get("retry-after").and_then(|v| v.to_str().ok()).map(String::from);
                    let text = r.text().await.unwrap_or_default();
                    // An access token can expire between the check and the call: refresh it once.
                    if status == 401 && !fresh_token && matches!(self.auth, GatewayAuth::Account(_)) {
                        fresh_token = true;
                        continue;
                    }
                    let err = gateway_error(status, &text);
                    // Busy models and short outages are retried; plan limits and bad requests are not.
                    if matches!(err, LumoError::Unavailable(_)) && matches!(status, 429 | 500 | 502 | 503 | 504) && attempt < 3 {
                        attempt += 1;
                        tokio::time::sleep(retry_delay(attempt, ra.as_deref())).await;
                        continue;
                    }
                    return Err(err);
                }
                Err(e) if attempt < 3 && (e.is_connect() || e.is_timeout()) => {
                    attempt += 1;
                    tokio::time::sleep(retry_delay(attempt, None)).await;
                }
                Err(e) => {
                    return Err(LumoError::Unavailable(format!(
                        "Could not reach Lumo's model service. Check your internet connection. ({e})"
                    )))
                }
            }
        };

        let mut text = String::new();
        let mut calls: Vec<(String, String, String)> = Vec::new(); // id, name, arguments
        let mut finish = String::from("stop");
        let mut usage = Usage::default();
        let mut served: Option<String> = None;
        let mut events = Box::pin(super::sse::events(resp.bytes_stream()));
        loop {
            let next = tokio::select! {
                n = events.next() => n,
                _ = cancel.cancelled() => return Err(LumoError::Cancelled),
            };
            let Some(ev) = next else { break };
            let ev = ev.map_err(|e| LumoError::Provider(format!("The model stream dropped: {e}")))?;
            if ev.data.trim() == "[DONE]" {
                break;
            }
            let Ok(d) = serde_json::from_str::<Value>(&ev.data) else { continue };
            if let Some(e) = d.get("error").filter(|e| e.is_object()) {
                return Err(LumoError::Provider(format!(
                    "The model stopped with an error: {}",
                    e["message"].as_str().unwrap_or("unknown error")
                )));
            }
            if served.is_none() {
                served = d["model"].as_str().map(String::from);
            }
            if let Some(u) = d.get("usage").filter(|u| u.is_object()) {
                usage.input_tokens = u["prompt_tokens"].as_u64().unwrap_or(0);
                usage.output_tokens = u["completion_tokens"].as_u64().unwrap_or(0);
            }
            let Some(choice) = d["choices"].get(0) else { continue };
            let delta = &choice["delta"];
            if let Some(t) = delta["content"].as_str() {
                if !t.is_empty() {
                    text.push_str(t);
                    sink(StreamEvent::TextDelta(t.into()));
                }
            }
            if let Some(tcs) = delta["tool_calls"].as_array() {
                for tc in tcs {
                    let i = tc["index"].as_u64().unwrap_or(calls.len() as u64) as usize;
                    while calls.len() <= i {
                        calls.push((String::new(), String::new(), String::new()));
                    }
                    let c = &mut calls[i];
                    if let Some(id) = tc["id"].as_str() {
                        c.0 = id.into();
                    }
                    if let Some(n) = tc["function"]["name"].as_str() {
                        if c.1.is_empty() {
                            c.1 = n.into();
                            sink(StreamEvent::ToolUseStarted { id: c.0.clone(), name: n.into() });
                        }
                    }
                    if let Some(a) = tc["function"]["arguments"].as_str() {
                        c.2.push_str(a);
                    }
                }
            }
            if let Some(f) = choice["finish_reason"].as_str() {
                finish = f.into();
            }
        }

        let mut content = Vec::new();
        if !text.is_empty() {
            content.push(json!({"type": "text", "text": text}));
        }
        for (i, (id, name, args)) in calls.into_iter().enumerate() {
            let id = if id.is_empty() { format!("call_{i}") } else { id };
            let mut block = json!({"type": "tool_use", "id": id, "name": name, "input": {}});
            match serde_json::from_str::<Value>(if args.trim().is_empty() { "{}" } else { &args }) {
                Ok(v) if v.is_object() => block["input"] = v,
                _ => block["__lumo_invalid_input"] = json!(true),
            }
            content.push(block);
        }
        let has_tools = content.iter().any(|b| b["type"] == "tool_use");
        let stop_reason = match finish.as_str() {
            "length" => "max_tokens",
            _ if has_tools => "tool_use",
            _ => "end_turn",
        }
        .to_string();
        Ok(ModelResponse { content, stop_reason, stop_details: None, usage, model: served.unwrap_or_else(|| req.model.clone()) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ToolDef;
    use wiremock::matchers::{body_partial_json, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[test]
    fn converts_history_dropping_thinking() {
        let msgs = vec![
            Message::user(vec![json!({"type": "text", "text": "hi"})]),
            Message::assistant(vec![
                json!({"type": "thinking", "thinking": "", "signature": "s"}),
                json!({"type": "text", "text": "checking"}),
                json!({"type": "tool_use", "id": "t1", "name": "list_directory", "input": {"path": "/x"}}),
            ]),
            Message::user(vec![json!({"type": "tool_result", "tool_use_id": "t1", "content": [{"type": "text", "text": "a.txt"}]})]),
        ];
        let out = to_chat_messages("sys", &msgs);
        assert_eq!(out[0], json!({"role": "system", "content": "sys"}));
        assert_eq!(out[2]["content"], "checking");
        assert_eq!(out[2]["tool_calls"][0]["function"]["arguments"], "{\"path\":\"/x\"}");
        assert_eq!(out[3], json!({"role": "tool", "tool_call_id": "t1", "content": "a.txt"}));
    }

    #[test]
    fn sends_only_the_latest_images_and_screenshots_from_tools() {
        let img = |d: &str| json!({"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": d}});
        let msgs = vec![
            Message::user(vec![json!({"type": "text", "text": "look"}), img("A"), img("B")]),
            Message::assistant(vec![json!({"type": "tool_use", "id": "s1", "name": "take_screenshot", "input": {}})]),
            Message::user(vec![
                json!({"type": "tool_result", "tool_use_id": "s1", "content": [{"type": "text", "text": "Screen"}, img("C")]}),
            ]),
            Message::assistant(vec![json!({"type": "tool_use", "id": "s2", "name": "take_screenshot", "input": {}})]),
            Message::user(vec![json!({"type": "tool_result", "tool_use_id": "s2", "content": [img("D")]})]),
        ];
        let out = to_chat_messages("sys", &msgs);
        let urls: Vec<String> = out
            .iter()
            .filter_map(|m| m["content"].as_array())
            .flatten()
            .filter_map(|p| p["image_url"]["url"].as_str().map(String::from))
            .collect();
        assert_eq!(urls, ["data:image/png;base64,B", "data:image/png;base64,C", "data:image/png;base64,D"]);
        assert_eq!(out[1]["content"][1]["text"], "[An earlier image, no longer shown.]");
        // The screenshot follows its tool message.
        assert_eq!(out[3], json!({"role": "tool", "tool_call_id": "s1", "content": "Screen"}));
        assert_eq!(out[4]["role"], "user");
    }

    fn request() -> ModelRequest {
        ModelRequest {
            model: "auto".into(),
            system: "s".into(),
            tools: vec![ToolDef { name: "list_directory".into(), description: "d".into(), input_schema: json!({"type": "object"}) }],
            messages: vec![Message::user(vec![json!({"type": "text", "text": "ls"})])],
            max_tokens: 32000,
        }
    }

    #[tokio::test]
    async fn streams_text_and_tool_calls_through_the_gateway() {
        let server = MockServer::start().await;
        let chunks = [
            json!({"model": "anthropic/claude-haiku-5.5", "choices": [{"delta": {"content": "Sure. "}}]}),
            json!({"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "c1", "function": {"name": "list_directory", "arguments": "{\"pa"}}]}}]}),
            json!({"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": "th\":\"/tmp\"}"}}]}, "finish_reason": "tool_calls"}]}),
            json!({"choices": [], "usage": {"prompt_tokens": 10, "completion_tokens": 7}}),
        ];
        let body: String = chunks.iter().map(|c| format!("data: {c}\n\n")).collect::<String>() + "data: [DONE]\n\n";
        Mock::given(method("POST"))
            .and(path("/api/chat"))
            .and(header("x-lumo-install", "0123456789abcdef0123456789abcdef"))
            .and(header("authorization", "Bearer mem_ABC123"))
            .and(body_partial_json(json!({"model": "auto", "max_tokens": 8192})))
            .respond_with(ResponseTemplate::new(200).set_body_raw(body, "text/event-stream"))
            .mount(&server)
            .await;
        let p = LumoCloud::new(reqwest::Client::new(), &server.uri(), "0123456789abcdef0123456789abcdef".into(), Some("mem_ABC123".into()));
        let r = p.complete(&request(), &|_| {}, &CancellationToken::new()).await.unwrap();
        assert_eq!(r.stop_reason, "tool_use");
        assert_eq!(r.content[0]["text"], "Sure. ");
        assert_eq!(r.content[1]["input"], json!({"path": "/tmp"}));
        assert_eq!(r.usage.output_tokens, 7);
        assert_eq!(r.model, "anthropic/claude-haiku-5.5");
    }

    #[tokio::test]
    async fn gateway_refusals_become_plan_limits_and_clear_messages() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(402).set_body_json(
                json!({"code": "plan_limit", "error": "You've used all of this month's Lite usage. It resets on November 1."}),
            ))
            .mount(&server)
            .await;
        let p = LumoCloud::new(reqwest::Client::new(), &server.uri(), "0".repeat(32), None);
        let err = p.complete(&request(), &|_| {}, &CancellationToken::new()).await.unwrap_err();
        assert_eq!(err.code(), "plan_limit");
        assert_eq!(err.to_string(), "You've used all of this month's Lite usage. It resets on November 1.");
        assert_eq!(gateway_error(403, r#"{"code":"license_invalid","error":"Lapsed."}"#).code(), "denied");
        assert_eq!(gateway_error(502, "<html>").to_string(), "Lumo's model service answered with HTTP 502.");
    }
}
