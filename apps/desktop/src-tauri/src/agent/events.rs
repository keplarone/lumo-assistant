//! Events a run streams to the UI. Mirrored in apps/desktop/src/lib/ipc.ts.

use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Understanding,
    Planning,
    Executing,
    Verifying,
    Reporting,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanStep {
    pub title: String,
    /// "pending", "active", "done", "failed" or "skipped".
    pub status: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActionPreview {
    /// One line, e.g. "Move 14 files into folders by type".
    pub title: String,
    /// Exact parameters as label/value pairs, e.g. ("Destination", "~/Downloads/Images").
    pub details: Vec<(String, String)>,
    /// Optional warning shown prominently (e.g. "This opens a checkout page").
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentEvent {
    #[serde(rename_all = "camelCase")]
    RunStarted { run_id: String, conversation_id: String },
    Phase { phase: Phase },
    TextDelta { text: String },
    ProgressNote { text: String },
    Plan { steps: Vec<PlanStep> },
    #[serde(rename_all = "camelCase")]
    ToolStarted { call_id: String, name: String, label: String, risk: String, input: Value },
    #[serde(rename_all = "camelCase")]
    ToolFinished { call_id: String, name: String, ok: bool, summary: String, data: Option<Value> },
    #[serde(rename_all = "camelCase")]
    ApprovalRequested { approval_id: String, call_id: String, tier: String, native: bool, preview: ActionPreview },
    #[serde(rename_all = "camelCase")]
    ApprovalResolved { approval_id: String, approved: bool },
    #[serde(rename_all = "camelCase")]
    Question { question_id: String, question: String, options: Vec<String>, allow_free_text: bool },
    Options { title: String, items: Value },
    /// Show a project's live preview.
    #[serde(rename_all = "camelCase")]
    OpenPreview { project_id: String, url: String },
    /// Something privacy-relevant happened (screen captured, clipboard read).
    Privacy { kind: String, detail: String },
    #[serde(rename_all = "camelCase")]
    AssistantMessage { message_id: String },
    #[serde(rename_all = "camelCase")]
    RunFinished { run_id: String, status: String, summary: Option<String>, error: Option<String> },
}

pub trait EventSink: Send + Sync {
    fn emit(&self, ev: AgentEvent);
}

/// Collects events (tests, automations).
#[derive(Default)]
pub struct Collector(pub parking_lot::Mutex<Vec<AgentEvent>>);
impl EventSink for Collector {
    fn emit(&self, ev: AgentEvent) {
        self.0.lock().push(ev);
    }
}
