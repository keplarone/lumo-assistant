//! Tools whose only effect is on the conversation: a visible plan, questions, and option cards.

use super::{object_schema, Origin, ToolCtx, ToolOutput, TypedTool};
use crate::agent::events::{AgentEvent, PlanStep};
use crate::error::{invalid, LumoError, Result};
use crate::policy::Risk;
use crate::util::new_id;
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};

pub struct UpdatePlan;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlanInput {
    pub steps: Vec<PlanStepInput>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlanStepInput {
    pub title: String,
    pub status: String,
}

#[async_trait]
impl TypedTool for UpdatePlan {
    type Input = PlanInput;
    const NAME: &'static str = "update_plan";
    const DESCRIPTION: &'static str = "Show or update the step-by-step plan for the current task in Lumo's task panel. Call it once you understand a multi-step task (before acting), and again whenever a step starts, finishes, fails or is skipped. Keep 2 to 8 short steps written as actions the user would recognize. Skip it for single-step requests.";
    fn schema(&self) -> Value {
        object_schema(
            json!({"steps": {"type": "array", "minItems": 1, "maxItems": 12, "items": object_schema(json!({
                "title": {"type": "string", "description": "Short imperative step, e.g. 'Sort screenshots into a folder'"},
                "status": {"type": "string", "enum": ["pending", "active", "done", "failed", "skipped"]}
            }), &["title", "status"])}}),
            &["steps"],
        )
    }
    fn risk(&self, _ctx: &ToolCtx, _: &PlanInput) -> Risk {
        Risk::Ui
    }
    fn label(&self, _: &PlanInput) -> String {
        "Updating the plan".into()
    }
    async fn run(&self, ctx: &ToolCtx, input: PlanInput) -> Result<ToolOutput> {
        if input.steps.is_empty() || input.steps.len() > 12 {
            return Err(invalid("a plan needs 1 to 12 steps"));
        }
        let mut steps = Vec::new();
        for s in input.steps {
            if !["pending", "active", "done", "failed", "skipped"].contains(&s.status.as_str()) {
                return Err(invalid(format!("unknown step status {}", s.status)));
            }
            steps.push(PlanStep { title: crate::util::preview(&s.title, 120), status: s.status });
        }
        let _ = ctx
            .core
            .db
            .conn()
            .execute("UPDATE runs SET plan_json = ?2 WHERE id = ?1", rusqlite::params![ctx.run_id, serde_json::to_string(&steps)?]);
        let done = steps.iter().filter(|s| s.status == "done").count();
        let total = steps.len();
        ctx.sink.emit(AgentEvent::Plan { steps });
        Ok(ToolOutput::text("Plan shown to the user.", format!("{done} of {total} steps done")))
    }
}

pub struct AskUser;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AskInput {
    pub question: String,
    #[serde(default)]
    pub options: Vec<String>,
    #[serde(default = "yes")]
    pub allow_free_text: bool,
}
fn yes() -> bool {
    true
}

#[async_trait]
impl TypedTool for AskUser {
    type Input = AskInput;
    const NAME: &'static str = "ask_user";
    const DESCRIPTION: &'static str = "Ask the user a question and wait for the answer. Use it only when the task cannot continue sensibly without their choice (for example which of two folders, or a delivery address); otherwise pick a reasonable default and say which. Offer up to 5 short options when the answer is a choice.";
    fn schema(&self) -> Value {
        object_schema(
            json!({
                "question": {"type": "string"},
                "options": {"type": "array", "items": {"type": "string"}, "maxItems": 5},
                "allow_free_text": {"type": "boolean", "description": "Whether the user may type their own answer. Default true."}
            }),
            &["question"],
        )
    }
    fn risk(&self, _ctx: &ToolCtx, _: &AskInput) -> Risk {
        Risk::Ui
    }
    fn label(&self, _: &AskInput) -> String {
        "Waiting for your answer".into()
    }
    async fn run(&self, ctx: &ToolCtx, input: AskInput) -> Result<ToolOutput> {
        if ctx.origin == Origin::Automation {
            return Err(LumoError::Unavailable(
                "Nobody is available to answer during a background automation. Use a sensible default and mention it in your report, or stop and report what is needed.".into(),
            ));
        }
        if input.options.len() > 5 {
            return Err(invalid("at most 5 options"));
        }
        let question_id = new_id();
        let (tx, rx) = tokio::sync::oneshot::channel();
        ctx.core.pending.questions.lock().insert(question_id.clone(), tx);
        ctx.sink.emit(AgentEvent::Question {
            question_id: question_id.clone(),
            question: input.question.clone(),
            options: input.options.clone(),
            allow_free_text: input.allow_free_text || input.options.is_empty(),
        });
        let answer = tokio::select! {
            a = rx => a.map_err(|_| LumoError::Cancelled)?,
            _ = ctx.cancel.cancelled() => {
                ctx.core.pending.questions.lock().remove(&question_id);
                return Err(LumoError::Cancelled);
            }
        };
        Ok(ToolOutput::text(format!("The user answered: {answer}"), format!("You answered: {}", crate::util::preview(&answer, 80))))
    }
}

/// Deliver an answer to a pending question.
pub fn answer_question(core: &crate::core::Core, question_id: &str, answer: &str) -> bool {
    match core.pending.questions.lock().remove(question_id) {
        Some(tx) => tx.send(answer.chars().take(4000).collect()).is_ok(),
        None => false,
    }
}

pub struct PresentOptions;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OptionsInput {
    pub title: String,
    pub items: Vec<OptionItem>,
}

#[derive(Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct OptionItem {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub details: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub price: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Where the information came from (a site name or "OpenStreetMap").
    pub source: String,
}

#[async_trait]
impl TypedTool for PresentOptions {
    type Input = OptionsInput;
    const NAME: &'static str = "present_options";
    const DESCRIPTION: &'static str = "Show the user a comparison of 2 to 6 options as cards (restaurants, products, approaches). Every fact on a card, especially prices, ratings and availability, must come from a tool result in this conversation; never estimate or invent them. Leave a field out when you don't have it, and always name the source.";
    fn schema(&self) -> Value {
        object_schema(
            json!({
                "title": {"type": "string"},
                "items": {"type": "array", "minItems": 1, "maxItems": 6, "items": object_schema(json!({
                    "title": {"type": "string"},
                    "subtitle": {"type": "string"},
                    "details": {"type": "array", "items": {"type": "string"}, "maxItems": 6},
                    "price": {"type": "string", "description": "Only if a tool result stated it, with currency."},
                    "url": {"type": "string"},
                    "source": {"type": "string"}
                }), &["title", "source"])}
            }),
            &["title", "items"],
        )
    }
    fn risk(&self, _ctx: &ToolCtx, _: &OptionsInput) -> Risk {
        Risk::Ui
    }
    fn label(&self, i: &OptionsInput) -> String {
        format!("Showing {} options", i.items.len())
    }
    async fn run(&self, ctx: &ToolCtx, input: OptionsInput) -> Result<ToolOutput> {
        if input.items.is_empty() || input.items.len() > 6 {
            return Err(invalid("show 1 to 6 options"));
        }
        for it in &input.items {
            if let Some(u) = &it.url {
                let ok = url::Url::parse(u).map(|u| u.scheme() == "https" || u.scheme() == "http").unwrap_or(false);
                if !ok {
                    return Err(invalid(format!("{u} is not a web link")));
                }
            }
        }
        let n = input.items.len();
        ctx.sink.emit(AgentEvent::Options { title: input.title.clone(), items: serde_json::to_value(&input.items)? });
        Ok(ToolOutput::text(
            "The options are shown to the user as cards. Ask which they prefer if a choice is needed.",
            format!("Showed {n} options"),
        ))
    }
}

pub struct SetMood;

pub const MOODS: &[&str] = &["neutral", "warm", "happy", "calm", "concerned", "celebrating"];

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MoodInput {
    pub mood: String,
}

#[async_trait]
impl TypedTool for SetMood {
    type Input = MoodInput;
    const NAME: &'static str = "set_mood";
    const DESCRIPTION: &'static str = "Set the Lumo mascot's expression to match the emotional tone of the conversation: warm for friendly chat, happy for good news, calm for stressful moments, concerned when the user is hurting, celebrating for wins, neutral otherwise. It only changes the mascot; it does nothing else.";
    fn schema(&self) -> Value {
        object_schema(json!({"mood": {"type": "string", "enum": MOODS}}), &["mood"])
    }
    fn risk(&self, _ctx: &ToolCtx, _: &MoodInput) -> Risk {
        Risk::Ui
    }
    fn label(&self, i: &MoodInput) -> String {
        format!("Feeling {}", i.mood)
    }
    async fn run(&self, ctx: &ToolCtx, input: MoodInput) -> Result<ToolOutput> {
        if !MOODS.contains(&input.mood.as_str()) {
            return Err(invalid(format!("unknown mood {}", input.mood)));
        }
        ctx.sink.emit(AgentEvent::Mood { mood: input.mood.clone() });
        Ok(ToolOutput::text(format!("Mascot mood set to {}.", input.mood), format!("Mood: {}", input.mood)))
    }
}

#[cfg(test)]
mod mood_tests {
    use super::*;
    use crate::core::testing::{core_with, FakePlatform};
    use crate::tools::tests::ctx;
    use std::sync::Arc;

    #[tokio::test]
    async fn sets_only_known_moods() {
        let (core, _dir) = core_with(Arc::new(FakePlatform::default()));
        let (c, sink) = ctx(core, Origin::User);
        SetMood.run(&c, MoodInput { mood: "concerned".into() }).await.unwrap();
        assert!(sink.0.lock().iter().any(|e| matches!(e, AgentEvent::Mood { mood } if mood == "concerned")));
        assert!(SetMood.run(&c, MoodInput { mood: "furious".into() }).await.is_err());
    }
}
