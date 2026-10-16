//! What Free, Lumo Lite and Lumo Pro include, and the checks that enforce it.
//!
//! Model use is metered on the server: Lumo's model gateway (models.rs, services/license) decides
//! which OpenRouter models each plan may use and enforces its monthly allowance, since Lumo pays for
//! those calls. This table covers what runs on the user's computer, enforced here in the Rust core,
//! never in the webview:
//! - how many automations may be active (`check_automation_slot`, `pause_excess_automations`);
//! - whether Lumo may control the mouse and keyboard (`check_tool`).
//!
//! The plan itself comes only from a verified license (`license.rs`), and the gateway re-checks it.

use crate::core::Core;
use crate::error::{LumoError, Result};
use crate::models::CatalogModel;
use crate::util::now as now_str;
use serde::Serialize;

pub struct PlanLimits {
    pub id: &'static str,
    pub name: &'static str,
    /// Monthly price in US dollars, shown until the gateway's catalog arrives.
    pub price_usd: f64,
    /// Automations that may be turned on at once. None means no limit.
    pub automations: Option<u32>,
    /// The `control_computer` tool (mouse and keyboard).
    pub computer_control: bool,
}

/// The plans, cheapest first. Change limits here; everything else reads this table.
pub const PLANS: [PlanLimits; 3] = [
    PlanLimits { id: "free", name: "Free", price_usd: 0.0, automations: Some(1), computer_control: false },
    PlanLimits { id: "lite", name: "Lumo Lite", price_usd: 19.99, automations: Some(10), computer_control: true },
    PlanLimits { id: "pro", name: "Lumo Pro", price_usd: 49.99, automations: None, computer_control: true },
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

// ---- What the Plans screen and model picker show --------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanInfo {
    pub id: &'static str,
    pub name: &'static str,
    pub price_usd: f64,
    pub automations: Option<u32>,
    pub computer_control: bool,
    /// The model "Auto" uses on this plan, when known.
    pub default_model: Option<String>,
    /// Empty until the gateway's catalog has arrived once.
    pub models: Vec<CatalogModel>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanUsage {
    pub plan: String,
    /// 0 to 100. None when the gateway couldn't be reached.
    pub percent_used: Option<u8>,
    /// Midnight UTC on the 1st of next month (RFC 3339), when known.
    pub resets_at: Option<String>,
    /// Why usage couldn't be read, if it couldn't.
    pub usage_error: Option<String>,
    /// None means no limit.
    pub automations_allowed: Option<u32>,
    pub computer_control: bool,
    /// Every plan, from this table and the gateway's catalog.
    pub plans: Vec<PlanInfo>,
}

/// This month's usage from the gateway, and what every plan includes.
pub async fn usage(core: &Core) -> PlanUsage {
    let (server, catalog) = tokio::join!(crate::models::usage(core), crate::models::catalog(core));
    let catalog = catalog.ok();
    let l = current(core);
    let (percent_used, resets_at, usage_error) = match server {
        Ok(u) => (Some(u.percent_used.min(100)), Some(u.resets_at), None),
        Err(e) => (None, None, Some(e.to_string())),
    };
    PlanUsage {
        plan: l.id.into(),
        percent_used,
        resets_at,
        usage_error,
        automations_allowed: l.automations,
        computer_control: l.computer_control,
        plans: PLANS
            .iter()
            .map(|p| {
                let c = catalog.as_ref().and_then(|c| c.plan(p.id));
                PlanInfo {
                    id: p.id,
                    name: p.name,
                    price_usd: c.map(|c| c.price_usd).unwrap_or(p.price_usd),
                    automations: p.automations,
                    computer_control: p.computer_control,
                    default_model: c.and_then(|c| c.default_model.clone()),
                    models: c.map(|c| c.models.clone()).unwrap_or_default(),
                }
            })
            .collect(),
    }
}

/// Refresh usage in the background and tell every window (after a run, when it may have changed).
pub fn refresh_in_background(core: std::sync::Arc<Core>) {
    tokio::spawn(async move {
        let u = usage(&core).await;
        if let Ok(v) = serde_json::to_value(u) {
            core.platform.broadcast("plan-usage-changed", v);
        }
    });
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

    #[test]
    fn the_table_matches_the_published_plans() {
        let (f, l, p) = (limits("free"), limits("lite"), limits("pro"));
        assert_eq!((f.automations, f.computer_control, f.price_usd), (Some(1), false, 0.0));
        assert_eq!((l.automations, l.computer_control, l.price_usd), (Some(10), true, 19.99));
        assert_eq!((p.automations, p.computer_control, p.price_usd), (None, true, 49.99));
        assert_eq!(limits("unlimited").id, "free", "the retired plan is gone");
        assert_eq!(PLANS.map(|p| p.id), ["free", "lite", "pro"]);
    }

    #[tokio::test]
    async fn usage_shows_the_plans_even_when_the_gateway_is_unreachable() {
        let (core, _d) = core_with(Arc::new(FakePlatform::default()));
        core.endpoints.lock().lumo_api = Some("http://127.0.0.1:9".into());
        set_plan(&core, "lite");
        let u = usage(&core).await;
        assert_eq!((u.plan.as_str(), u.percent_used, u.automations_allowed), ("lite", None, Some(10)));
        assert!(u.usage_error.is_some());
        assert_eq!(u.plans.iter().map(|p| p.price_usd).collect::<Vec<_>>(), [0.0, 19.99, 49.99]);
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
        assert!(err.to_string().contains("Lumo Lite includes 10 and Lumo Pro has no limit"), "{err}");
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
