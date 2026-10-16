//! OpenAI-compatible Chat Completions adapter, for model servers the user runs themselves (LM
//! Studio, Ollama, a llama.cpp server) and other vendors that speak this protocol. Thinking and server-tool blocks in history
//! are dropped when converting, since these endpoints cannot read them.

use super::{retry_delay, retryable_status, EventSink, Message, ModelProvider, ModelRequest, ModelResponse, StreamEvent, Usage};
use crate::error::{LumoError, Result};
use async_trait::async_trait;
use futures_util::StreamExt;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

pub struct OpenAiCompatible {
    http: reqwest::Client,
    base_url: String,
    api_key: Option<String>,
    model: String,
}

impl OpenAiCompatible {
    pub fn new(http: reqwest::Client, base_url: &str, api_key: Option<String>, model: String) -> Self {
        OpenAiCompatible { http, base_url: base_url.trim_end_matches('/').to_string(), api_key, model }
    }
}

/// Convert canonical (Anthropic-shaped) history into chat messages.
pub fn to_chat_messages(system: &str, messages: &[Message]) -> Vec<Value> {
    let mut out = vec![json!({"role": "system", "content": system})];
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
                        Some("image") if b["source"]["type"] == "base64" => parts.push(json!({
                            "type": "image_url",
                            "image_url": {"url": format!("data:{};base64,{}", b["source"]["media_type"].as_str().unwrap_or("image/png"), b["source"]["data"].as_str().unwrap_or(""))}
                        })),
                        Some("tool_result") => {
                            let content = match &b["content"] {
                                Value::String(s) => s.clone(),
                                Value::Array(items) => text_of(items),
                                _ => String::new(),
                            };
                            out.push(json!({"role": "tool", "tool_call_id": b["tool_use_id"], "content": content}));
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

fn text_of(blocks: &[Value]) -> String {
    blocks.iter().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("\n")
}

#[async_trait]
impl ModelProvider for OpenAiCompatible {
    fn name(&self) -> &'static str {
        "openai_compatible"
    }

    async fn complete(&self, req: &ModelRequest, sink: EventSink<'_>, cancel: &CancellationToken) -> Result<ModelResponse> {
        let tools: Vec<Value> = req
            .tools
            .iter()
            .map(|t| json!({"type": "function", "function": {"name": t.name, "description": t.description, "parameters": t.input_schema}}))
            .collect();
        let mut body = json!({
            "model": self.model,
            "stream": true,
            "stream_options": {"include_usage": true},
            "max_tokens": req.max_tokens.min(16384),
            "messages": to_chat_messages(&req.system, &req.messages),
        });
        if !tools.is_empty() {
            body["tools"] = json!(tools);
        }

        let mut attempt = 0;
        let resp = loop {
            let mut rb = self.http.post(format!("{}/chat/completions", self.base_url)).json(&body);
            if let Some(k) = &self.api_key {
                rb = rb.bearer_auth(k);
            }
            let r = tokio::select! {
                r = rb.send() => r,
                _ = cancel.cancelled() => return Err(LumoError::Cancelled),
            };
            match r {
                Ok(r) if r.status().is_success() => break r,
                Ok(r) if retryable_status(r.status().as_u16()) && attempt < 3 => {
                    attempt += 1;
                    let ra = r.headers().get("retry-after").and_then(|v| v.to_str().ok()).map(String::from);
                    tokio::time::sleep(retry_delay(attempt, ra.as_deref())).await;
                }
                Ok(r) => {
                    let status = r.status();
                    let text = r.text().await.unwrap_or_default();
                    return Err(LumoError::Provider(format!("The model endpoint returned {status}: {}", crate::util::preview(&text, 300))));
                }
                Err(e) if attempt < 3 && (e.is_connect() || e.is_timeout()) => {
                    attempt += 1;
                    tokio::time::sleep(retry_delay(attempt, None)).await;
                }
                Err(e) => {
                    return Err(LumoError::Provider(format!(
                        "Could not reach the model endpoint at {} ({e}). Is the local model server running?",
                        self.base_url
                    )))
                }
            }
        };

        let mut text = String::new();
        let mut calls: Vec<(String, String, String)> = Vec::new(); // id, name, arguments
        let mut finish = String::from("stop");
        let mut usage = Usage::default();
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
        Ok(ModelResponse { content, stop_reason, stop_details: None, usage, model: self.model.clone() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ServerTools, ToolDef};
    use wiremock::matchers::{method, path};
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

    #[tokio::test]
    async fn streams_text_and_tool_calls() {
        let server = MockServer::start().await;
        let chunks = [
            json!({"choices": [{"delta": {"content": "Sure. "}}]}),
            json!({"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "c1", "function": {"name": "list_directory", "arguments": "{\"pa"}}]}}]}),
            json!({"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": "th\":\"/tmp\"}"}}]}, "finish_reason": "tool_calls"}]}),
            json!({"choices": [], "usage": {"prompt_tokens": 10, "completion_tokens": 7}}),
        ];
        let body: String = chunks.iter().map(|c| format!("data: {c}\n\n")).collect::<String>() + "data: [DONE]\n\n";
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_raw(body, "text/event-stream"))
            .mount(&server)
            .await;
        let p = OpenAiCompatible::new(reqwest::Client::new(), &format!("{}/v1", server.uri()), None, "llama".into());
        let req = ModelRequest {
            model: "x".into(),
            system: "s".into(),
            tools: vec![ToolDef { name: "list_directory".into(), description: "d".into(), input_schema: json!({"type": "object"}) }],
            server_tools: ServerTools::default(),
            messages: vec![Message::user(vec![json!({"type": "text", "text": "ls"})])],
            max_tokens: 1000,
            effort: "low".into(),
        };
        let r = p.complete(&req, &|_| {}, &CancellationToken::new()).await.unwrap();
        assert_eq!(r.stop_reason, "tool_use");
        assert_eq!(r.content[0]["text"], "Sure. ");
        assert_eq!(r.content[1]["input"], json!({"path": "/tmp"}));
        assert_eq!(r.usage.output_tokens, 7);
    }
}
