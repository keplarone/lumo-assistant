//! What Free, Lumo Lite and Lumo Pro include, and the checks that enforce it.
//!
//! Every limit lives in the `PLANS` table below. The plan itself comes only from a verified license
//! (`license.rs`). Enforcement is here in the Rust core, never in the webview:
//! - model usage: a monthly token allowance (input + output tokens of every model call), resetting on
//!   the 1st of each calendar month in local time. A new model call is refused once it is used up; a
//!   call already in flight always finishes.
//! - which models and providers a plan may use (`check_model`, at selection and at run time);
//! - how many automations may be active (`check_automation_slot`, `pause_excess_automations`);
//! - whether Lumo may control the mouse and keyboard (`check_tool`).
//!
//! All of this runs on the user's computer, so a modified build could skip it. That is acceptable
//! while every model call is paid for by the user (their own key or their own hardware); if Lumo ever
//! pays for cloud usage, it needs metering on a server.

use crate::core::Core;
use crate::error::{LumoError, Result};
use crate::local_models::{same_tag, CATALOG};
use crate::model::{ModelRequest, ModelResponse};
use crate::settings::Settings;
use crate::util::now as now_str;
use chrono::{DateTime, Datelike, Local, NaiveDate, TimeZone};
use serde::Serialize;
use serde_json::Value;

pub struct PlanLimits {
    pub id: &'static str,
    pub name: &'static str,
    /// Model tokens (input + output) per calendar month, local time. None means unlimited.
    pub monthly_tokens: Option<u64>,
    /// On-device models (runtime tags) the plan may use. None means every on-device model.
    pub local_models: Option<&'static [&'static str]>,
    /// Anthropic and OpenAI-compatible servers.
    pub cloud_models: bool,
    /// Automations that may be turned on at once. None means no limit.
    pub automations: Option<u32>,
    /// The `control_computer` tool (mouse and keyboard).
    pub computer_control: bool,
}

/// The plans, cheapest first. Change limits here; everything else reads this table.
pub const PLANS: [PlanLimits; 4] = [
    PlanLimits {
        id: "free",
        name: "Free",
        monthly_tokens: Some(1_000_000),
        local_models: Some(&["qwen3:4b", "qwen3:8b"]),
        cloud_models: false,
        automations: Some(1),
        computer_control: false,
    },
    PlanLimits {
        id: "lite",
        name: "Lumo Lite",
        monthly_tokens: Some(30_000_000),
        local_models: None,
        cloud_models: true,
        automations: Some(10),
        computer_control: true,
    },
    PlanLimits {
        id: "pro",
        name: "Lumo Pro",
        monthly_tokens: Some(150_000_000),
        local_models: None,
        cloud_models: true,
        automations: None,
        computer_control: true,
    },
    PlanLimits {
        id: "unlimited",
        name: "Lumo Unlimited",
        monthly_tokens: None,
        local_models: None,
        cloud_models: true,
        automations: None,
        computer_control: true,
    },
];

/// The limits for a plan id. Anything unknown gets Free.
pub fn limits(plan: &str) -> &'static PlanLimits {
    PLANS.iter().find(|p| p.id == plan).unwrap_or(&PLANS[0])
}

pub fn current(core: &Core) -> &'static PlanLimits {
    limits(&core.settings().plan)
}

fn plan_limit(msg: impl Into<String>) -> LumoError {
    LumoError::PlanLimit(msg.into())
}

/// Plans above `l`, for "upgrade to …" hints.
fn higher(l: &PlanLimits) -> impl Iterator<Item = &'static PlanLimits> + '_ {
    PLANS.iter().skip_while(move |p| p.id != l.id).skip(1)
}

fn join_and(items: &[&str]) -> String {
    match items {
        [] => String::new(),
        [one] => one.to_string(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

// ---- Monthly usage --------------------------------------------------------------------------

/// "2026-10": the local calendar month a call counts toward.
fn month_key(at: DateTime<Local>) -> String {
    at.format("%Y-%m").to_string()
}

/// Local midnight on the 1st of the next month, when the allowance resets.
pub fn next_reset(now: DateTime<Local>) -> DateTime<Local> {
    let (y, m) = if now.month() == 12 { (now.year() + 1, 1) } else { (now.year(), now.month() + 1) };
    let first = NaiveDate::from_ymd_opt(y, m, 1).and_then(|d| d.and_hms_opt(0, 0, 0)).expect("valid date");
    Local.from_local_datetime(&first).earliest().unwrap_or_else(|| Local.from_utc_datetime(&first))
}

pub fn tokens_used(core: &Core, at: DateTime<Local>) -> u64 {
    core.db
        .conn()
        .query_row("SELECT tokens FROM usage_monthly WHERE month = ?1", [month_key(at)], |r| r.get::<_, i64>(0))
        .map(|n| n.max(0) as u64)
        .unwrap_or(0)
}

/// Add a finished model call's tokens to the month the call was made in.
pub fn record_tokens_at(core: &Core, tokens: u64, call_started: DateTime<Local>) -> Result<()> {
    core.db.conn().execute(
        "INSERT INTO usage_monthly(month, tokens, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(month) DO UPDATE SET tokens = min(tokens + excluded.tokens, 9223372036854775807), updated_at = excluded.updated_at",
        rusqlite::params![month_key(call_started), tokens.min(i64::MAX as u64) as i64, now_str()],
    )?;
    Ok(())
}

/// Record a finished model call and tell every window about the new usage.
pub fn record_call(core: &Core, req: &ModelRequest, resp: &ModelResponse, call_started: DateTime<Local>) {
    if let Err(e) = record_tokens_at(core, response_tokens(req, resp), call_started) {
        log::warn!("could not record model usage: {e}");
    }
    if let Ok(v) = serde_json::to_value(usage(core)) {
        core.platform.broadcast("plan-usage-changed", v);
    }
}

/// Input + output tokens the provider reported, or an estimate (about 4 characters per token over
/// the request and response text) when it reported none.
pub fn response_tokens(req: &ModelRequest, resp: &ModelResponse) -> u64 {
    let reported = resp.usage.input_tokens + resp.usage.output_tokens;
    if reported > 0 {
        return reported;
    }
    let tools: usize = req.tools.iter().map(|t| t.name.len() + t.description.len() + t.input_schema.to_string().len()).sum();
    let chars = req.system.len()
        + tools
        + req.messages.iter().map(|m| m.content.iter().map(text_chars).sum::<usize>()).sum::<usize>()
        + resp.content.iter().map(text_chars).sum::<usize>();
    (chars as u64).div_ceil(4)
}

/// Characters of text in a content block, leaving out binary payloads and signatures.
fn text_chars(v: &Value) -> usize {
    match v {
        Value::String(s) => s.len(),
        Value::Array(a) => a.iter().map(text_chars).sum(),
        Value::Object(o) => {
            o.iter().filter(|(k, _)| !matches!(k.as_str(), "source" | "data" | "signature" | "type")).map(|(_, v)| text_chars(v)).sum()
        }
        _ => 0,
    }
}

/// Refuse a new model call once this month's allowance is used up. Checked before every model call;
/// a call already in flight always finishes.
pub fn check_allowance(core: &Core) -> Result<()> {
    check_allowance_at(core, Local::now())
}

pub fn check_allowance_at(core: &Core, now: DateTime<Local>) -> Result<()> {
    let l = current(core);
    let Some(limit) = l.monthly_tokens else { return Ok(()) };
    if tokens_used(core, now) < limit {
        return Ok(());
    }
    let metered: Vec<&PlanLimits> = higher(l).filter(|p| p.monthly_tokens.is_some()).collect();
    let unlimited: Vec<&str> = higher(l).filter(|p| p.monthly_tokens.is_none()).map(short_name).collect();
    let mut options = Vec::new();
    if !metered.is_empty() {
        let names: Vec<&str> = metered.iter().map(|p| short_name(p)).collect();
        let ratios: Vec<String> = metered.iter().map(|p| format!("{}×", p.monthly_tokens.unwrap_or(0) / limit.max(1))).collect();
        options.push(format!("{} for {} more", names.join(" or "), ratios.join(" or ")));
    }
    if !unlimited.is_empty() {
        options.push(format!("{} for no limit", unlimited.join(" or ")));
    }
    let hint = if options.is_empty() { String::new() } else { format!(" Upgrade to {}.", options.join(", or to ")) };
    Err(plan_limit(format!(
        "You've used all of this month's {} usage. It resets on {}.{hint}",
        short_name(l),
        next_reset(now).format("%B %-d")
    )))
}

/// "Free", "Lite", "Pro", "Unlimited".
fn short_name(l: &PlanLimits) -> &'static str {
    l.name.trim_start_matches("Lumo ")
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanInfo {
    pub id: &'static str,
    pub name: &'static str,
    /// None means unlimited.
    pub monthly_tokens: Option<u64>,
    /// Display names of the on-device models the plan includes.
    pub local_models: Vec<String>,
    pub cloud_models: bool,
    pub automations: Option<u32>,
    pub computer_control: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanUsage {
    pub plan: String,
    /// Input + output tokens of model calls this calendar month.
    pub tokens_used: u64,
    /// None on a plan with unlimited usage.
    pub tokens_limit: Option<u64>,
    /// 0 to 100, rounded. None on a plan with unlimited usage.
    pub percent_used: Option<u8>,
    /// Local midnight on the 1st of next month (RFC 3339).
    pub resets_at: String,
    /// Runtime tags of the on-device models in Lumo's catalog that this plan may use.
    pub allowed_models: Vec<String>,
    pub cloud_models: bool,
    /// None means no limit.
    pub automations_allowed: Option<u32>,
    pub computer_control: bool,
    /// Every plan's limits, from the same table, for the Plans screen.
    pub plans: Vec<PlanInfo>,
}

pub fn usage(core: &Core) -> PlanUsage {
    usage_at(core, Local::now())
}

pub fn usage_at(core: &Core, now: DateTime<Local>) -> PlanUsage {
    let l = current(core);
    let used = tokens_used(core, now);
    PlanUsage {
        plan: l.id.into(),
        tokens_used: used,
        tokens_limit: l.monthly_tokens,
        percent_used: l.monthly_tokens.map(|limit| percent(used, limit)),
        resets_at: next_reset(now).to_rfc3339(),
        allowed_models: CATALOG.iter().filter(|e| local_allowed(l, e.id)).map(|e| e.id.to_string()).collect(),
        cloud_models: l.cloud_models,
        automations_allowed: l.automations,
        computer_control: l.computer_control,
        plans: PLANS
            .iter()
            .map(|p| PlanInfo {
                id: p.id,
                name: p.name,
                monthly_tokens: p.monthly_tokens,
                local_models: CATALOG.iter().filter(|e| local_allowed(p, e.id)).map(|e| e.tier.to_string()).collect(),
                cloud_models: p.cloud_models,
                automations: p.automations,
                computer_control: p.computer_control,
            })
            .collect(),
    }
}

fn percent(used: u64, limit: u64) -> u8 {
    if limit == 0 {
        return 100;
    }
    ((used as f64 / limit as f64) * 100.0).round().clamp(0.0, 100.0) as u8
}

// ---- Models ---------------------------------------------------------------------------------

fn local_allowed(l: &PlanLimits, model: &str) -> bool {
    l.local_models.map(|ids| ids.iter().any(|id| same_tag(id, model))).unwrap_or(true)
}

fn model_label(model: &str) -> String {
    CATALOG.iter().find(|e| same_tag(e.id, model)).map(|e| e.tier.to_string()).unwrap_or_else(|| model.to_string())
}

/// Whether a plan may use this provider and model. An empty on-device model (none chosen yet) is
/// allowed here; running then fails with "choose a model".
pub fn model_allowed(l: &PlanLimits, provider: &str, model: &str) -> bool {
    match provider {
        "local" => model.is_empty() || local_allowed(l, model),
        _ => l.cloud_models,
    }
}

pub fn check_model(l: &PlanLimits, provider: &str, model: &str) -> Result<()> {
    if model_allowed(l, provider, model) {
        return Ok(());
    }
    let included: Vec<String> = CATALOG.iter().filter(|e| local_allowed(l, e.id)).map(|e| e.tier.to_string()).collect();
    let included = included.iter().map(String::as_str).collect::<Vec<_>>();
    let or_list = match included.as_slice() {
        [rest @ .., last] if !rest.is_empty() => format!("{} or {last}", rest.join(", ")),
        other => other.join(""),
    };
    let upgrade = join_and(&higher(l).filter(|p| model_allowed(p, provider, model)).map(|p| p.name).collect::<Vec<_>>());
    Err(plan_limit(if provider == "local" {
        format!(
            "{} is part of {upgrade}. On the {} plan you can use {or_list}: choose one in Settings → Model, or upgrade.",
            model_label(model),
            l.name
        )
    } else {
        format!(
            "Cloud and custom model providers are part of {upgrade}. On the {} plan Lumo runs on-device models ({or_list}): choose one in Settings → Model, or upgrade.",
            l.name
        )
    }))
}

/// The cheapest plan that includes an on-device model, when the current plan doesn't.
pub fn required_plan(core: &Core, model: &str) -> Option<&'static str> {
    let l = current(core);
    if local_allowed(l, model) {
        return None;
    }
    PLANS.iter().find(|p| local_allowed(p, model)).map(|p| p.id)
}

/// Saving settings may not switch to a provider or model the plan doesn't include. A stale on-device
/// choice from a higher plan is cleared (rather than refused) when the user switches back to on-device
/// models, so they can pick an included one.
pub fn check_settings_change(old: &Settings, new: &mut Settings) -> Result<()> {
    if old.provider == new.provider && old.chat_model() == new.chat_model() {
        return Ok(());
    }
    let l = limits(&old.plan);
    if new.provider == "local" && new.local_model == old.local_model && !model_allowed(l, "local", &new.local_model) {
        new.local_model.clear();
    }
    check_model(l, &new.provider, &new.chat_model())
}

// ---- Automations ----------------------------------------------------------------------------

fn enabled_automations(core: &Core, except: &str) -> Result<u32> {
    Ok(core.db.conn().query_row("SELECT count(*) FROM automations WHERE enabled = 1 AND id != ?1", [except], |r| r.get::<_, u32>(0))?)
}

/// Refuse turning on one more automation than the plan includes. `editing` is the automation being
/// saved, which doesn't count against itself.
pub fn check_automation_slot(core: &Core, editing: Option<&str>) -> Result<()> {
    let l = current(core);
    let Some(cap) = l.automations else { return Ok(()) };
    let n = enabled_automations(core, editing.unwrap_or(""))?;
    if n < cap {
        return Ok(());
    }
    let mut more: Vec<String> = higher(l).filter_map(|p| p.automations.map(|c| format!("{} includes {c}", p.name))).collect();
    let no_limit: Vec<&str> = higher(l).filter(|p| p.automations.is_none()).map(|p| p.name).collect();
    match no_limit.as_slice() {
        [] => {}
        [one] => more.push(format!("{one} has no limit")),
        many => more.push(format!("{} have no limit", join_and(many))),
    }
    Err(plan_limit(format!(
        "The {} plan includes {cap} active automation{}, and you already have {n} turned on. Turn one off first, or upgrade: {}.",
        l.name,
        if cap == 1 { "" } else { "s" },
        join_and(&more.iter().map(String::as_str).collect::<Vec<_>>())
    )))
}

/// After a downgrade, turn off the automations beyond the plan's count (newest first). Nothing is
/// deleted; the user can choose which to turn back on. Returns how many were paused.
pub fn pause_excess_automations(core: &Core) -> Result<usize> {
    let Some(cap) = current(core).automations else { return Ok(0) };
    let ids: Vec<String> = {
        let conn = core.db.conn();
        let mut st = conn.prepare("SELECT id FROM automations WHERE enabled = 1 ORDER BY created_at, id")?;
        let rows = st.query_map([], |r| r.get(0))?.collect::<std::result::Result<Vec<String>, _>>()?;
        rows
    };
    let extra: Vec<&String> = ids.iter().skip(cap as usize).collect();
    if extra.is_empty() {
        return Ok(0);
    }
    {
        let conn = core.db.conn();
        for id in &extra {
            conn.execute(
                "UPDATE automations SET enabled = 0, next_run_at = NULL, updated_at = ?2 WHERE id = ?1",
                rusqlite::params![id, now_str()],
            )?;
        }
    }
    crate::audit::record(&core.db, "system", "automations_paused_by_plan", None, Some(&serde_json::json!({"count": extra.len()})), "ok");
    core.platform.broadcast("automations-changed", serde_json::json!({"id": extra[0]}));
    Ok(extra.len())
}

// ---- Tools ----------------------------------------------------------------------------------

/// Refuse tools the plan doesn't include. Checked before any approval is asked for.
pub fn check_tool(core: &Core, name: &str) -> Result<()> {
    let l = current(core);
    if name == "control_computer" && !l.computer_control {
        let upgrade = join_and(&higher(l).filter(|p| p.computer_control).map(|p| p.name).collect::<Vec<_>>());
        return Err(plan_limit(format!(
            "Controlling the mouse and keyboard is part of {upgrade}, so Lumo can't do it on the {} plan. Upgrade in Settings → Plans, or do this step yourself.",
            l.name
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::testing::{core_with, set_plan, FakePlatform};
    use std::sync::Arc;

    fn local(y: i32, m: u32, d: u32, h: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(y, m, d, h, 0, 0).unwrap()
    }

    #[test]
    fn the_table_matches_the_published_limits() {
        let (f, l, p, u) = (limits("free"), limits("lite"), limits("pro"), limits("unlimited"));
        assert_eq!((f.monthly_tokens, f.automations, f.computer_control, f.cloud_models), (Some(1_000_000), Some(1), false, false));
        assert_eq!((l.monthly_tokens, l.automations, l.computer_control, l.cloud_models), (Some(30_000_000), Some(10), true, true));
        assert_eq!((p.monthly_tokens, p.automations, p.computer_control, p.cloud_models), (Some(150_000_000), None, true, true));
        assert_eq!((u.monthly_tokens, u.automations, u.computer_control, u.cloud_models, u.local_models), (None, None, true, true, None));
        assert_eq!(limits("bogus").id, "free");
        assert_eq!(PLANS.map(|p| p.id), ["free", "lite", "pro", "unlimited"]);
    }

    #[test]
    fn monthly_allowance_counts_refuses_at_the_limit_and_resets_on_the_first() {
        let (core, _d) = core_with(Arc::new(FakePlatform::default()));
        let now = local(2026, 10, 16, 10);
        let u = usage_at(&core, now);
        assert_eq!((u.tokens_used, u.tokens_limit, u.percent_used), (0, Some(1_000_000), Some(0)));
        assert_eq!(u.resets_at, local(2026, 11, 1, 0).to_rfc3339());

        record_tokens_at(&core, 800_000, now).unwrap();
        let u = usage_at(&core, now);
        assert_eq!((u.tokens_used, u.percent_used), (800_000, Some(80)));
        check_allowance_at(&core, now).unwrap();

        // The call that crosses the limit was allowed to finish; the next one is refused.
        record_tokens_at(&core, 250_000, now).unwrap();
        assert_eq!(usage_at(&core, now).percent_used, Some(100));
        let err = check_allowance_at(&core, now).unwrap_err();
        assert_eq!(err.code(), "plan_limit");
        assert_eq!(
            err.to_string(),
            "You've used all of this month's Free usage. It resets on November 1. Upgrade to Lite or Pro for 30× or 150× more, or to Unlimited for no limit."
        );

        // A new calendar month starts from zero.
        let november = local(2026, 11, 1, 0);
        check_allowance_at(&core, november).unwrap();
        assert_eq!(usage_at(&core, november).tokens_used, 0);
        assert_eq!(usage_at(&core, november).resets_at, local(2026, 12, 1, 0).to_rfc3339());
        assert_eq!(next_reset(local(2026, 12, 31, 23)), local(2027, 1, 1, 0));

        // A higher plan raises the limit without resetting usage.
        set_plan(&core, "lite");
        check_allowance_at(&core, now).unwrap();
        assert_eq!(usage_at(&core, now).percent_used, Some(4));
        record_tokens_at(&core, 30_000_000, now).unwrap();
        assert_eq!(
            check_allowance_at(&core, now).unwrap_err().to_string(),
            "You've used all of this month's Lite usage. It resets on November 1. Upgrade to Pro for 5× more, or to Unlimited for no limit."
        );
        set_plan(&core, "pro");
        record_tokens_at(&core, 150_000_000, now).unwrap();
        assert_eq!(
            check_allowance_at(&core, now).unwrap_err().to_string(),
            "You've used all of this month's Pro usage. It resets on November 1. Upgrade to Unlimited for no limit."
        );

        // Unlimited: usage is still counted and shown, but never refused.
        set_plan(&core, "unlimited");
        record_tokens_at(&core, 10_000_000_000, now).unwrap();
        check_allowance_at(&core, now).unwrap();
        let u = usage_at(&core, now);
        assert_eq!((u.plan.as_str(), u.tokens_limit, u.percent_used, u.automations_allowed), ("unlimited", None, None, None));
        assert_eq!(u.tokens_used, 10_181_050_000);
        assert!(u.computer_control && u.cloud_models && u.allowed_models.len() == 4);
        assert_eq!(u.plans.len(), 4);
        assert_eq!(serde_json::to_value(&u).unwrap()["tokensLimit"], serde_json::Value::Null);
    }

    #[test]
    fn tokens_come_from_reported_usage_or_an_estimate() {
        use crate::model::{Message, ServerTools, Usage};
        let req = ModelRequest {
            model: "m".into(),
            system: "x".repeat(400),
            tools: vec![],
            server_tools: ServerTools::default(),
            messages: vec![Message::user(vec![
                serde_json::json!({"type": "text", "text": "y".repeat(400)}),
                serde_json::json!({"type": "image", "source": {"type": "base64", "data": "z".repeat(100_000)}}),
            ])],
            max_tokens: 100,
            effort: "low".into(),
        };
        let mut resp = ModelResponse {
            content: vec![serde_json::json!({"type": "text", "text": "w".repeat(200)})],
            stop_reason: "end_turn".into(),
            stop_details: None,
            usage: Usage::default(),
            model: "m".into(),
        };
        assert_eq!(response_tokens(&req, &resp), 250, "1000 characters of text ≈ 250 tokens; image data is not text");
        resp.usage = Usage { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 9000, ..Default::default() };
        assert_eq!(response_tokens(&req, &resp), 1500);
    }

    #[test]
    fn models_and_providers_follow_the_plan() {
        let free = limits("free");
        assert!(model_allowed(free, "local", "qwen3:4b") && model_allowed(free, "local", "qwen3:8b"));
        assert!(!model_allowed(free, "local", "gpt-oss:20b") && !model_allowed(free, "local", "qwen3:30b"));
        assert!(!model_allowed(free, "anthropic", "claude-opus-5-5") && !model_allowed(free, "openai_compatible", "llama3.1"));
        let msg = check_model(free, "local", "qwen3:30b").unwrap_err().to_string();
        assert!(
            msg.starts_with("Nova 5.5 is part of Lumo Lite, Lumo Pro and Lumo Unlimited.") && msg.contains("Orbit 3.8 or Nebula 4.2"),
            "{msg}"
        );
        let msg = check_model(free, "anthropic", "claude-opus-5-5").unwrap_err().to_string();
        assert!(msg.contains("Cloud and custom model providers are part of Lumo Lite, Lumo Pro and Lumo Unlimited"), "{msg}");
        for plan in ["lite", "pro", "unlimited"] {
            let l = limits(plan);
            for m in ["qwen3:4b", "qwen3:8b", "gpt-oss:20b", "qwen3:30b"] {
                assert!(model_allowed(l, "local", m), "{plan} {m}");
            }
            assert!(model_allowed(l, "anthropic", "claude-opus-5-5") && model_allowed(l, "openai_compatible", "x"));
        }

        // Saving settings: switching to a locked provider or model is refused; unrelated saves are not.
        let old = Settings { provider: "local".into(), local_model: "qwen3:4b".into(), ..Default::default() };
        let mut to_cloud = Settings { provider: "anthropic".into(), ..old.clone() };
        assert_eq!(check_settings_change(&old, &mut to_cloud).unwrap_err().code(), "plan_limit");
        let mut to_nova = Settings { local_model: "qwen3:30b".into(), ..old.clone() };
        assert!(check_settings_change(&old, &mut to_nova).is_err());
        let mut theme = Settings { theme: "dark".into(), ..old.clone() };
        check_settings_change(&old, &mut theme).unwrap();
        // A stale Nova choice is cleared when switching back to on-device models.
        let stale = Settings { provider: "anthropic".into(), local_model: "qwen3:30b".into(), ..Default::default() };
        let mut back = Settings { provider: "local".into(), ..stale.clone() };
        check_settings_change(&stale, &mut back).unwrap();
        assert_eq!(back.local_model, "");
        let pro = Settings { plan: "pro".into(), ..old.clone() };
        check_settings_change(&pro, &mut Settings { provider: "anthropic".into(), ..pro.clone() }).unwrap();
    }

    #[tokio::test]
    async fn run_time_provider_refuses_a_locked_setting() {
        let (core, _d) = core_with(Arc::new(FakePlatform::default()));
        core.secrets.set("anthropic_api_key", "sk-ant-test").unwrap();
        // An old setting from a higher plan cannot be used on Free.
        let mut s = core.settings();
        s.provider = "anthropic".into();
        crate::settings::save(&core.db, &s).unwrap();
        assert_eq!(core.provider().err().unwrap().code(), "plan_limit");
        s.provider = "local".into();
        s.local_model = "gpt-oss:20b".into();
        crate::settings::save(&core.db, &s).unwrap();
        assert!(core.provider().err().unwrap().to_string().starts_with("Solar 5.4 is part of"));
        assert_eq!(required_plan(&core, "gpt-oss:20b"), Some("lite"));
        assert_eq!(required_plan(&core, "qwen3:8b"), None);
        set_plan(&core, "lite");
        // Allowed now: what's missing is only the download.
        let err = core.provider().err().unwrap();
        assert_eq!(err.code(), "unavailable");
        assert!(err.to_string().starts_with("Solar 5.4 isn't downloaded yet"), "{err}");
        assert_eq!(required_plan(&core, "gpt-oss:20b"), None);
        let u = usage(&core);
        assert_eq!(u.allowed_models.len(), 4);
        assert_eq!((u.automations_allowed, u.computer_control, u.cloud_models), (Some(10), true, true));
        assert_eq!(u.plans[0].local_models, vec!["Orbit 3.8".to_string(), "Nebula 4.2".to_string()]);
    }

    #[test]
    fn automation_count_follows_the_plan_and_downgrades_pause_the_extras() {
        use crate::automations::{self, AutomationInput, Trigger};
        let platform = Arc::new(FakePlatform::default());
        let (core, _d) = core_with(platform.clone());
        let input = |name: &str, enabled: bool| AutomationInput {
            name: name.into(),
            prompt: "Check things".into(),
            agent_id: None,
            trigger: Trigger::Interval { minutes: 60 },
            allowed_tools: vec![],
            enabled,
            notify: true,
        };
        // Free: one active automation.
        let first = automations::save(&core, None, &input("One", true)).unwrap();
        let err = automations::save(&core, None, &input("Two", true)).unwrap_err();
        assert_eq!(err.code(), "plan_limit");
        assert!(err.to_string().contains("Lumo Lite includes 10 and Lumo Pro and Lumo Unlimited have no limit"), "{err}");
        // Saving the active one again, or saving another one turned off, is fine; turning it on is not.
        automations::save(&core, Some(&first.id), &input("One renamed", true)).unwrap();
        let off = automations::save(&core, None, &input("Two", false)).unwrap();
        assert!(automations::save(&core, Some(&off.id), &input("Two", true)).is_err());

        // Lite: up to ten.
        set_plan(&core, "lite");
        for i in 2..=10 {
            automations::save(&core, None, &input(&format!("A{i}"), true)).unwrap();
        }
        assert!(automations::save(&core, Some(&off.id), &input("Two", true)).is_err(), "eleventh refused");
        // Pro: no limit.
        set_plan(&core, "pro");
        automations::save(&core, Some(&off.id), &input("Two", true)).unwrap();
        assert_eq!(pause_excess_automations(&core).unwrap(), 0);

        // Back to Free: the oldest stays on, the rest are paused, nothing is deleted.
        set_plan(&core, "free");
        assert_eq!(pause_excess_automations(&core).unwrap(), 10);
        let all = automations::list(&core).unwrap();
        assert_eq!(all.len(), 11);
        let on: Vec<_> = all.iter().filter(|a| a.enabled).collect();
        assert_eq!(on.len(), 1);
        assert_eq!(on[0].id, first.id);
        assert!(all.iter().filter(|a| !a.enabled).all(|a| a.next_run_at.is_none()));
        assert!(platform.broadcasts.lock().iter().any(|(e, _)| e == "automations-changed"));
        // The scheduler applies it too, so paused automations never come due.
        let due = automations::due(&core, chrono::Utc::now() + chrono::Duration::days(1)).unwrap();
        assert_eq!(due, vec![first.id.clone()]);
    }
}
