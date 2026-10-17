//! Automations: saved requests that run on a schedule with nobody watching.
//!
//! They run under the strict background policy (see `tools::authorize`): read tools only, plus any
//! write tools the user explicitly allowed when saving the automation. Anything needing a decision
//! or a native confirmation stops the run and marks it "needs attention" with a notification.

use crate::agent::{self, events::Collector, StartRequest};
use crate::core::Core;
use crate::error::{invalid, LumoError, Result};
use crate::tools::{Origin, Registry};
use crate::util::{new_id, now};
use chrono::{DateTime, Local, Utc};
use serde::{Deserialize, Serialize};
use std::str::FromStr;
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Trigger {
    /// At a local time on chosen weekdays (empty = every day).
    Daily {
        time: String,
        #[serde(default)]
        days: Vec<String>,
    },
    Interval {
        minutes: u32,
    },
    /// Advanced: a cron expression with seconds (sec min hour day month weekday).
    Cron {
        expression: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Automation {
    pub id: String,
    pub name: String,
    pub prompt: String,
    pub agent_id: Option<String>,
    pub trigger: Trigger,
    /// Write tools this automation may use without asking.
    pub allowed_tools: Vec<String>,
    pub enabled: bool,
    pub notify: bool,
    pub created_at: String,
    pub updated_at: String,
    pub last_run_at: Option<String>,
    pub next_run_at: Option<String>,
    pub last_status: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationInput {
    pub name: String,
    pub prompt: String,
    #[serde(default)]
    pub agent_id: Option<String>,
    pub trigger: Trigger,
    #[serde(default)]
    pub allowed_tools: Vec<String>,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default = "yes")]
    pub notify: bool,
}
fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRun {
    pub id: String,
    pub automation_id: String,
    pub run_id: Option<String>,
    pub conversation_id: Option<String>,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub status: String,
    pub error: Option<String>,
    pub summary: Option<String>,
}

/// Write tools an automation may be allowed to use. Sensitive tools are never allowed.
pub const ALLOWABLE_WRITE_TOOLS: &[&str] = &["write_file", "create_folder", "move_files", "move_to_trash", "write_clipboard", "open_url"];

const DAYS: [&str; 7] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

pub fn cron_for(trigger: &Trigger) -> Result<Option<cron::Schedule>> {
    match trigger {
        Trigger::Daily { time, days } => {
            let (h, m) = time.split_once(':').ok_or_else(|| invalid("time must be HH:MM"))?;
            let h: u32 = h.parse().map_err(|_| invalid("time must be HH:MM"))?;
            let m: u32 = m.parse().map_err(|_| invalid("time must be HH:MM"))?;
            if h > 23 || m > 59 {
                return Err(invalid("time must be HH:MM"));
            }
            for d in days {
                if !DAYS.contains(&d.as_str()) {
                    return Err(invalid(format!("unknown day {d}")));
                }
            }
            let dow = if days.is_empty() || days.len() == 7 {
                "*".to_string()
            } else {
                days.iter().map(|d| capitalize(d)).collect::<Vec<_>>().join(",")
            };
            Ok(Some(cron::Schedule::from_str(&format!("0 {m} {h} * * {dow}")).map_err(|e| invalid(e.to_string()))?))
        }
        Trigger::Interval { minutes } => {
            if !(5..=10_080).contains(minutes) {
                return Err(invalid("interval must be between 5 minutes and 7 days"));
            }
            Ok(None)
        }
        Trigger::Cron { expression } => {
            Ok(Some(cron::Schedule::from_str(expression).map_err(|e| invalid(format!("invalid schedule: {e}")))?))
        }
    }
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

/// The next time a trigger fires after `after`.
pub fn next_run(trigger: &Trigger, after: DateTime<Utc>) -> Result<DateTime<Utc>> {
    match trigger {
        Trigger::Interval { minutes } => {
            cron_for(trigger)?;
            Ok(after + chrono::Duration::minutes(*minutes as i64))
        }
        _ => {
            let s = cron_for(trigger)?.expect("cron trigger");
            let local = after.with_timezone(&Local);
            s.after(&local).next().map(|d| d.with_timezone(&Utc)).ok_or_else(|| invalid("this schedule never fires"))
        }
    }
}

fn validate(i: &AutomationInput) -> Result<()> {
    if i.name.trim().is_empty() || i.name.len() > 100 {
        return Err(invalid("a name must be 1 to 100 characters"));
    }
    if i.prompt.trim().is_empty() || i.prompt.len() > 10_000 {
        return Err(invalid("describe what the automation should do"));
    }
    for t in &i.allowed_tools {
        if !ALLOWABLE_WRITE_TOOLS.contains(&t.as_str()) {
            return Err(invalid(format!("{t} cannot be allowed in an automation")));
        }
    }
    cron_for(&i.trigger)?;
    Ok(())
}

fn row(r: &rusqlite::Row) -> rusqlite::Result<Automation> {
    let trig: String = r.get(4)?;
    let allowed: String = r.get(5)?;
    Ok(Automation {
        id: r.get(0)?,
        name: r.get(1)?,
        prompt: r.get(2)?,
        agent_id: r.get(3)?,
        trigger: serde_json::from_str(&trig).unwrap_or(Trigger::Interval { minutes: 60 }),
        allowed_tools: serde_json::from_str(&allowed).unwrap_or_default(),
        enabled: r.get::<_, i64>(6)? != 0,
        notify: r.get::<_, i64>(7)? != 0,
        created_at: r.get(8)?,
        updated_at: r.get(9)?,
        last_run_at: r.get(10)?,
        next_run_at: r.get(11)?,
        last_status: r.get(12)?,
    })
}

const COLS: &str = "id, name, prompt, agent_id, trigger_json, allowed_tools_json, enabled, notify, created_at, updated_at, last_run_at, next_run_at, last_status";

pub fn list(core: &Core) -> Result<Vec<Automation>> {
    let conn = core.db.conn();
    let mut st = conn.prepare(&format!("SELECT {COLS} FROM automations ORDER BY created_at"))?;
    let rows = st.query_map([], row)?.collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn get(core: &Core, id: &str) -> Result<Automation> {
    core.db
        .conn()
        .query_row(&format!("SELECT {COLS} FROM automations WHERE id = ?1"), [id], row)
        .map_err(|_| LumoError::NotFound("automation".into()))
}

pub fn save(core: &Core, id: Option<&str>, i: &AutomationInput) -> Result<Automation> {
    validate(i)?;
    if i.enabled {
        crate::plans::check_automation_slot(core, id)?;
    }
    let t = now();
    let next = if i.enabled { Some(next_run(&i.trigger, Utc::now())?.to_rfc3339()) } else { None };
    let id = id.map(String::from).unwrap_or_else(new_id);
    core.db.conn().execute(
        &format!(
            "INSERT INTO automations({COLS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, NULL, ?10, NULL)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, prompt = excluded.prompt, agent_id = excluded.agent_id, trigger_json = excluded.trigger_json,
             allowed_tools_json = excluded.allowed_tools_json, enabled = excluded.enabled, notify = excluded.notify, updated_at = excluded.updated_at, next_run_at = excluded.next_run_at"
        ),
        rusqlite::params![id, i.name.trim(), i.prompt.trim(), i.agent_id, serde_json::to_string(&i.trigger)?, serde_json::to_string(&i.allowed_tools)?, i.enabled as i64, i.notify as i64, t, next],
    )?;
    crate::audit::record(
        &core.db,
        "user",
        "save_automation",
        Some(i.name.trim()),
        Some(&serde_json::json!({"allowedTools": i.allowed_tools})),
        "ok",
    );
    get(core, &id)
}

pub fn delete(core: &Core, id: &str) -> Result<()> {
    core.db.conn().execute("DELETE FROM automations WHERE id = ?1", [id])?;
    Ok(())
}

pub fn runs(core: &Core, automation_id: &str, limit: u32) -> Result<Vec<AutomationRun>> {
    let conn = core.db.conn();
    let mut st = conn.prepare(
        "SELECT id, automation_id, run_id, conversation_id, started_at, finished_at, status, error, summary FROM automation_runs WHERE automation_id = ?1 ORDER BY started_at DESC LIMIT ?2",
    )?;
    let rows = st
        .query_map(rusqlite::params![automation_id, limit], |r| {
            Ok(AutomationRun {
                id: r.get(0)?,
                automation_id: r.get(1)?,
                run_id: r.get(2)?,
                conversation_id: r.get(3)?,
                started_at: r.get(4)?,
                finished_at: r.get(5)?,
                status: r.get(6)?,
                error: r.get(7)?,
                summary: r.get(8)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Run an automation now and record the result. Returns the final status.
pub async fn run_now(core: Arc<Core>, registry: Arc<Registry>, id: &str) -> Result<AutomationRun> {
    let a = get(&core, id)?;
    let ar_id = new_id();
    let started = now();
    core.db.conn().execute(
        "INSERT INTO automation_runs(id, automation_id, started_at, status) VALUES (?1, ?2, ?3, 'running')",
        rusqlite::params![ar_id, a.id, started],
    )?;
    core.platform.broadcast("automations-changed", serde_json::json!({"id": a.id}));
    let req =
        StartRequest { text: format!("[Automation \"{}\"] {}", a.name, a.prompt), agent_id: a.agent_id.clone(), ..Default::default() };
    let (status, error, summary, run_id, conv_id) =
        match agent::prepare(&core, &registry, &req, Origin::Automation, a.allowed_tools.clone()) {
            Ok(spec) => {
                let (run_id, conv_id) = (spec.run_id.clone(), spec.conversation_id.clone());
                let out = agent::drive(core.clone(), registry.clone(), spec, Arc::new(Collector::default())).await;
                let status = if out.needs_attention { "needs_attention".to_string() } else { out.status.clone() };
                (status, out.error, out.summary, Some(run_id), Some(conv_id))
            }
            Err(e @ LumoError::PlanLimit(_)) => ("limit_reached".to_string(), Some(e.to_string()), None, None, None),
            Err(e) => ("failed".to_string(), Some(e.to_string()), None, None, None),
        };
    let finished = now();
    let next = if a.enabled { next_run(&a.trigger, Utc::now()).ok().map(|d| d.to_rfc3339()) } else { None };
    {
        let conn = core.db.conn();
        conn.execute(
            "UPDATE automation_runs SET run_id = ?2, conversation_id = ?3, finished_at = ?4, status = ?5, error = ?6, summary = ?7 WHERE id = ?1",
            rusqlite::params![ar_id, run_id, conv_id, finished, status, error, summary],
        )?;
        conn.execute(
            "UPDATE automations SET last_run_at = ?2, last_status = ?3, next_run_at = ?4 WHERE id = ?1",
            rusqlite::params![a.id, started, status, next],
        )?;
    }
    if a.notify || status != "done" {
        let body = match status.as_str() {
            "done" => summary.clone().unwrap_or_else(|| "Finished.".into()),
            "needs_attention" => "Needs your attention: it stopped at a step that requires your approval.".into(),
            "limit_reached" => error.clone().unwrap_or_default(),
            _ => format!("Didn't finish: {}", error.clone().unwrap_or_else(|| status.clone())),
        };
        let _ = core.platform.notify(&a.name, &crate::util::preview(&body, 200));
    }
    core.platform.broadcast("automations-changed", serde_json::json!({"id": a.id}));
    Ok(AutomationRun {
        id: ar_id,
        automation_id: a.id,
        run_id,
        conversation_id: conv_id,
        started_at: started,
        finished_at: Some(finished),
        status,
        error,
        summary,
    })
}

/// IDs of automations that are due now.
pub fn due(core: &Core, at: DateTime<Utc>) -> Result<Vec<String>> {
    if core.settings().automations_paused {
        return Ok(vec![]);
    }
    // Automations beyond the plan's count (after a downgrade) are paused, never run.
    crate::plans::pause_excess_automations(core)?;
    let all = list(core)?;
    Ok(all
        .into_iter()
        .filter(|a| a.enabled)
        .filter(|a| {
            a.next_run_at
                .as_deref()
                .and_then(|n| DateTime::parse_from_rfc3339(n).ok())
                .map(|n| n.with_timezone(&Utc) <= at)
                .unwrap_or(false)
        })
        .filter(|a| !core.pending.runs.lock().values().any(|r| r.origin == "automation" && r.title.contains(&a.name)))
        .map(|a| a.id)
        .collect())
}

/// The scheduler loop. Checks every 30 seconds; a run missed while Lumo was closed runs once at start.
/// The everyday helpers (reminders, the morning brief, bills, price watch) run from here too.
pub async fn scheduler(core: Arc<Core>, registry: Arc<Registry>) {
    loop {
        crate::everyday::tick(core.clone()).await;
        match due(&core, Utc::now()) {
            Ok(ids) => {
                for id in ids {
                    let (c, r) = (core.clone(), registry.clone());
                    tokio::spawn(async move {
                        if let Err(e) = run_now(c, r, &id).await {
                            log::warn!("automation {id} failed to start: {e}");
                        }
                    });
                }
            }
            Err(e) => log::warn!("scheduler: {e}"),
        }
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::tests::{resp, tool_use, Scripted};
    use crate::core::testing::{core_with, set_plan, FakePlatform};
    use serde_json::json;

    #[test]
    fn schedules_compute_the_next_run() {
        let t = DateTime::parse_from_rfc3339("2026-10-16T12:00:00Z").unwrap().with_timezone(&Utc);
        assert_eq!(next_run(&Trigger::Interval { minutes: 30 }, t).unwrap(), t + chrono::Duration::minutes(30));
        let daily = next_run(&Trigger::Daily { time: "09:30".into(), days: vec![] }, t).unwrap();
        assert!(daily > t && daily - t <= chrono::Duration::days(1));
        let weekly = next_run(&Trigger::Daily { time: "08:00".into(), days: vec!["mon".into()] }, t).unwrap();
        assert_eq!(weekly.with_timezone(&Local).format("%a").to_string(), "Mon");
        assert!(cron_for(&Trigger::Daily { time: "25:00".into(), days: vec![] }).is_err());
        assert!(cron_for(&Trigger::Interval { minutes: 1 }).is_err());
    }

    #[tokio::test]
    async fn a_due_automation_runs_records_and_notifies() {
        let platform = Arc::new(FakePlatform::default());
        let (core, _d) = core_with(platform.clone());
        set_plan(&core, "lite");
        let scripted = Scripted::new(vec![
            resp(vec![tool_use("w", "write_clipboard", json!({"text": "x"}))], "tool_use"),
            resp(vec![json!({"type": "text", "text": "Checked. Nothing new."})], "end_turn"),
        ]);
        *core.provider_override.lock() = Some(scripted);
        let input = AutomationInput {
            name: "Morning check".into(),
            prompt: "Check things".into(),
            agent_id: None,
            trigger: Trigger::Interval { minutes: 60 },
            allowed_tools: vec![],
            enabled: true,
            notify: true,
        };
        let a = save(&core, None, &input).unwrap();
        assert!(due(&core, Utc::now()).unwrap().is_empty());
        assert_eq!(due(&core, Utc::now() + chrono::Duration::minutes(61)).unwrap(), vec![a.id.clone()]);
        let r = run_now(core.clone(), Arc::new(Registry::standard()), &a.id).await.unwrap();
        // write_clipboard was not allowed for this automation, so the run needs attention.
        assert_eq!(r.status, "needs_attention");
        assert!(platform.clipboard.lock().is_empty());
        assert_eq!(platform.notifications.lock().len(), 1);
        let a2 = get(&core, &a.id).unwrap();
        assert_eq!(a2.last_status.as_deref(), Some("needs_attention"));
        assert!(a2.next_run_at.is_some());
        assert!(
            save(&core, None, &AutomationInput { allowed_tools: vec!["run_command".into()], ..input }).is_err(),
            "sensitive tools can't be pre-allowed"
        );
    }

    #[tokio::test]
    async fn the_runner_stops_when_the_plan_allowance_is_used_up() {
        let platform = Arc::new(FakePlatform::default());
        let (core, _d) = core_with(platform.clone());
        set_plan(&core, "lite");
        let scripted = Scripted::new(vec![resp(vec![json!({"type": "text", "text": "Done."})], "end_turn")]);
        *core.provider_override.lock() = Some(scripted.clone());
        let a = save(
            &core,
            None,
            &AutomationInput {
                name: "Digest".into(),
                prompt: "Summarize".into(),
                agent_id: None,
                trigger: Trigger::Interval { minutes: 60 },
                allowed_tools: vec![],
                enabled: true,
                notify: false,
            },
        )
        .unwrap();
        *scripted.plan_limit.lock() = Some("You've used all of this month's Lite usage. It resets on November 1.".into());
        let r = run_now(core.clone(), Arc::new(Registry::standard()), &a.id).await.unwrap();
        assert_eq!(r.status, "limit_reached");
        assert!(scripted.responses.lock().len() == 1, "nothing was answered");
        let note = platform.notifications.lock().last().cloned().unwrap();
        assert!(note.1.starts_with("You've used all of this month's Lite usage."), "{note:?}");
    }
}
