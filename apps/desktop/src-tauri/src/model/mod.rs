//! Provider-agnostic model gateway.
//!
//! Conversation content is stored in the Anthropic Messages content-block shape (the richest format:
//! text, thinking with signatures, tool_use, tool_result, server tool blocks). The Anthropic adapter
//! sends it verbatim, which keeps history append-only. Other adapters convert it.

pub mod anthropic;
pub mod openai;
pub mod sse;

use crate::error::Result;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Message {
    pub role: String,
    pub content: Vec<Value>,
}

impl Message {
    pub fn user(content: Vec<Value>) -> Self {
        Message { role: "user".into(), content }
    }
    pub fn assistant(content: Vec<Value>) -> Self {
        Message { role: "assistant".into(), content }
    }
    pub fn system(text: &str) -> Self {
        Message { role: "system".into(), content: vec![serde_json::json!({"type": "text", "text": text})] }
    }
}

/// A client-side tool definition (JSON Schema input).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ServerTools {
    pub web_search: bool,
    pub web_fetch: bool,
    /// The computer-use toolset (screenshots + input). Its calls are executed locally.
    pub computer: bool,
}

#[derive(Debug, Clone)]
pub struct ModelRequest {
    pub model: String,
    pub system: String,
    pub tools: Vec<ToolDef>,
    pub server_tools: ServerTools,
    pub messages: Vec<Message>,
    pub max_tokens: u32,
    pub effort: String,
}

/// Incremental events while a response streams, for live UI.
#[derive(Debug, Clone, PartialEq)]
pub enum StreamEvent {
    TextDelta(String),
    /// A short note the model wrote between tool calls (progress update).
    ProgressNote(String),
    ToolUseStarted { id: String, name: String },
    ServerToolStarted { name: String },
    ServerToolFinished { name: String, summary: String },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_input_tokens: u64,
    pub cache_creation_input_tokens: u64,
}

impl Usage {
    pub fn add(&mut self, o: &Usage) {
        self.input_tokens += o.input_tokens;
        self.output_tokens += o.output_tokens;
        self.cache_read_input_tokens += o.cache_read_input_tokens;
        self.cache_creation_input_tokens += o.cache_creation_input_tokens;
    }
}

#[derive(Debug, Clone)]
pub struct ModelResponse {
    /// Content blocks exactly as they should be replayed in history.
    pub content: Vec<Value>,
    pub stop_reason: String,
    pub stop_details: Option<Value>,
    pub usage: Usage,
    /// Which model actually produced the response (differs after a server-side fallback).
    pub model: String,
}

pub type EventSink<'a> = &'a (dyn Fn(StreamEvent) + Send + Sync);

#[async_trait]
pub trait ModelProvider: Send + Sync {
    fn name(&self) -> &'static str;
    async fn complete(&self, req: &ModelRequest, sink: EventSink<'_>, cancel: &CancellationToken) -> Result<ModelResponse>;
}

/// Statuses worth retrying before any output has reached the user.
pub fn retryable_status(code: u16) -> bool {
    matches!(code, 408 | 409 | 429 | 500 | 502 | 503 | 504 | 529)
}

/// Parse a `retry-after` header (seconds) into a bounded delay.
pub fn retry_delay(attempt: u32, retry_after: Option<&str>) -> std::time::Duration {
    let secs = retry_after
        .and_then(|v| v.trim().parse::<f64>().ok())
        .unwrap_or_else(|| 2f64.powi(attempt as i32))
        .clamp(0.5, 30.0);
    std::time::Duration::from_millis((secs * 1000.0) as u64)
}
