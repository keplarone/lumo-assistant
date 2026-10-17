//! Tools for the everyday helpers: `get_my_day` (weather, calendar, reminders, bills, price watches)
//! and `keep_track` (add a reminder or a bill, watch a price, remove any of them). Two tools rather
//! than one per action, so the small on-device models keep enough context for the conversation.
//! The data and background checks live in `everyday`.
//!
//! Adding a reminder or a bill only changes Lumo's own lists (visible and removable in the app), so
//! it runs without a prompt in a chat, like `remember`; unattended automations need permission.
//! Watching a price starts background requests to a website, so it asks once.

use super::{object_schema, Origin, ToolCtx, ToolOutput, TypedTool};
use crate::agent::events::ActionPreview;
use crate::error::{invalid, Result};
use crate::everyday::{bills, brief, calendar, prices, reminders, weather};
use crate::policy::Risk;
use async_trait::async_trait;
use chrono::{DateTime, Local};
use serde::Deserialize;
use serde_json::{json, Value};

fn own_list_risk(ctx: &ToolCtx) -> Risk {
    // Unattended runs read untrusted content; they must not add things on their own.
    if ctx.origin == Origin::Automation {
        Risk::Write
    } else {
        Risk::Ui
    }
}

// ---- The user's day --------------------------------------------------------------------------

pub struct GetMyDay;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DayInput {
    #[serde(default)]
    pub date: Option<String>,
}

/// Every upcoming reminder, tracked bill and price watch with its id, for changing or removing them.
fn list_lines(ctx: &ToolCtx) -> Result<Vec<String>> {
    let now = Local::now();
    let mut lines = Vec::new();
    for r in reminders::upcoming(&ctx.core)?.iter().take(50) {
        let due = DateTime::parse_from_rfc3339(&r.due_at).map(|d| d.with_timezone(&Local)).unwrap_or(now);
        lines.push(format!(
            "Reminder: {}, {} ({}) [id {}]",
            r.text,
            reminders::describe_due(due, now),
            reminders::describe_repeat(&r.repeat),
            r.id
        ));
    }
    let subs = bills::list(&ctx.core)?;
    for s in &subs {
        lines.push(format!(
            "Bill: {}, {} {}, renews {} [id {}]",
            s.name,
            bills::money(s.amount, &s.currency),
            s.cycle,
            s.next_renewal,
            s.id
        ));
    }
    let mut totals: std::collections::BTreeMap<&str, f64> = Default::default();
    for s in &subs {
        *totals.entry(s.currency.as_str()).or_default() += bills::monthly_cost(s);
    }
    for (cur, total) in totals {
        lines.push(format!("Bills total: about {} a month ({cur})", bills::money(total, cur)));
    }
    for w in prices::list(&ctx.core)? {
        let cur = w.currency.clone().unwrap_or_default();
        let price = w.last_price.map(|p| bills::money(p, &cur)).unwrap_or_else(|| "unknown".into());
        let err = w.last_error.as_deref().map(|e| format!(", last check failed: {e}")).unwrap_or_default();
        let first = w.first_price.map(|p| bills::money(p, &cur)).unwrap_or_default();
        lines.push(format!("Price watch: {}, now {price} (started at {first}{err}) {} [id {}]", w.name, w.url, w.id));
    }
    Ok(lines)
}

#[async_trait]
impl TypedTool for GetMyDay {
    type Input = DayInput;
    const NAME: &'static str = "get_my_day";
    const DESCRIPTION: &'static str =
        "Weather, calendar, reminders and bills due for a day, plus all reminders, bills and price watches with ids.";
    fn schema(&self) -> Value {
        object_schema(json!({"date": {"type": "string"}}), &[])
    }
    fn risk(&self, _ctx: &ToolCtx, _: &DayInput) -> Risk {
        Risk::Read
    }
    fn label(&self, _: &DayInput) -> String {
        "Checking your day".into()
    }
    async fn run(&self, ctx: &ToolCtx, i: DayInput) -> Result<ToolOutput> {
        let today = Local::now().date_naive();
        let day = match i.date.as_deref() {
            Some(d) => reminders::parse_date(d)?,
            None => today,
        };
        if (day - today).num_days().abs() > 366 {
            return Err(invalid("pick a day within a year"));
        }
        let mut d = brief::gather(&ctx.core, day).await;
        if day != today {
            // The forecast summary only covers today.
            d.weather = None;
        }
        let mut facts = vec![format!("Day: {}", day.format("%A %Y-%m-%d"))];
        if let Some(w) = &d.weather {
            facts.push(format!("Weather: {} ({})", weather::sentence(w), weather::ATTRIBUTION));
        }
        if calendar::configured(&ctx.core) && d.events.is_empty() {
            facts.push("Calendar: nothing scheduled".into());
        }
        facts.push(if d.reminders.is_empty() {
            "Reminders that day: none".into()
        } else {
            format!("Reminders that day: {}", d.reminders.join("; "))
        });
        facts.push(if d.bills.is_empty() {
            "Bills renewing within 3 days: none".into()
        } else {
            format!("Bills renewing soon: {}", d.bills.join("; "))
        });
        for m in &d.missing {
            facts.push(format!("Not set up: {m}"));
        }
        for p in &d.problems {
            facts.push(format!("Couldn't read: {p}"));
        }
        // Calendar titles (other people can send invitations), bill names and product names come
        // from outside, so they are marked as data.
        let mut outside = Vec::new();
        if !d.events.is_empty() {
            outside.push(format!("Calendar events:\n{}", d.events.join("\n")));
        }
        let all = list_lines(ctx)?;
        if !all.is_empty() {
            outside.push(format!("Everything Lumo is keeping track of:\n{}", all.join("\n")));
        }
        Ok(ToolOutput {
            text: facts.join("\n"),
            untrusted: if outside.is_empty() { None } else { Some(outside.join("\n\n")) },
            summary: format!("Checked {}", if day == today { "today".to_string() } else { day.format("%A").to_string() }),
            data: Some(json!({"day": d})),
            ..Default::default()
        })
    }
}

// ---- Bills, price watches and removing things -----------------------------------------------

/// One tool for adding a bill, watching a price and removing anything, which keeps the tool list
/// short enough for the small on-device models' context.
pub struct KeepTrack;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TrackInput {
    pub action: String,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub time: Option<String>,
    #[serde(default)]
    pub date: Option<String>,
    #[serde(default)]
    pub in_minutes: Option<u32>,
    #[serde(default)]
    pub repeat: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub amount: Option<f64>,
    #[serde(default)]
    pub currency: Option<String>,
    #[serde(default)]
    pub cycle: Option<String>,
    #[serde(default)]
    pub next_renewal: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub id: Option<String>,
}

fn need<T: Clone>(v: &Option<T>, what: &str) -> Result<T> {
    v.clone().ok_or_else(|| invalid(format!("{what} is required for this action")))
}

#[async_trait]
impl TypedTool for KeepTrack {
    type Input = TrackInput;
    const NAME: &'static str = "keep_track";
    const DESCRIPTION: &'static str = "remind: text at time (24h HH:MM, optional date YYYY-MM-DD) or in_minutes; say so if AM/PM was unclear. add_bill: track a subscription, only facts the user gave. watch_price: alert when a product page\'s price drops. remove: id from get_my_day.";
    fn schema(&self) -> Value {
        object_schema(
            json!({
                "action": {"type": "string", "enum": ["remind", "add_bill", "watch_price", "remove"]},
                "text": {"type": "string"},
                "time": {"type": "string"},
                "date": {"type": "string"},
                "in_minutes": {"type": "integer"},
                "repeat": {"type": "string", "enum": reminders::REPEATS},
                "name": {"type": "string"},
                "amount": {"type": "number"},
                "currency": {"type": "string"},
                "cycle": {"type": "string", "enum": bills::CYCLES},
                "next_renewal": {"type": "string"},
                "url": {"type": "string"},
                "id": {"type": "string"}
            }),
            &["action"],
        )
    }
    fn risk(&self, ctx: &ToolCtx, i: &TrackInput) -> Risk {
        match i.action.as_str() {
            // Starts background requests to a website, so the user agrees once.
            "watch_price" => Risk::Write,
            "add_bill" | "remind" => own_list_risk(ctx),
            _ => Risk::Ui,
        }
    }
    fn label(&self, i: &TrackInput) -> String {
        match i.action.as_str() {
            "remind" => format!("Setting a reminder: {}", crate::util::preview(i.text.as_deref().unwrap_or(""), 50)),
            "add_bill" => format!("Tracking {}", crate::util::preview(i.name.as_deref().unwrap_or("a bill"), 40)),
            "watch_price" => {
                let host = i.url.as_deref().and_then(|u| url::Url::parse(u).ok()).and_then(|u| u.host_str().map(String::from));
                format!("Watching the price on {}", host.unwrap_or_else(|| "the page".into()))
            }
            _ => "Removing an item".into(),
        }
    }
    fn preview(&self, _ctx: &ToolCtx, i: &TrackInput) -> Result<ActionPreview> {
        match i.action.as_str() {
            "watch_price" => {
                let u = url::Url::parse(&need(&i.url, "url")?).map_err(|_| invalid("not a valid link"))?;
                Ok(ActionPreview {
                    title: format!(
                        "Check the price of {} every 6 hours",
                        i.name.as_deref().unwrap_or(u.host_str().unwrap_or("this product"))
                    ),
                    details: vec![("Page".into(), u.to_string())],
                    warning: None,
                })
            }
            "remind" => Ok(ActionPreview {
                title: format!("Add a reminder: {}", crate::util::preview(i.text.as_deref().unwrap_or(""), 80)),
                details: vec![],
                warning: None,
            }),
            _ => Ok(ActionPreview {
                title: format!(
                    "Track {} ({} {})",
                    i.name.as_deref().unwrap_or("a bill"),
                    bills::money(i.amount.unwrap_or(0.0), i.currency.as_deref().unwrap_or("USD")),
                    i.cycle.as_deref().unwrap_or("")
                ),
                details: vec![("Next renewal".into(), i.next_renewal.clone().unwrap_or_default())],
                warning: None,
            }),
        }
    }
    async fn run(&self, ctx: &ToolCtx, i: TrackInput) -> Result<ToolOutput> {
        match i.action.as_str() {
            "remind" => {
                let repeat = i.repeat.as_deref().unwrap_or("none");
                let when = reminders::When { time: i.time, date: i.date, in_minutes: i.in_minutes };
                let r = reminders::add(&ctx.core, &need(&i.text, "text")?, &when, repeat)?;
                let due = DateTime::parse_from_rfc3339(&r.due_at).map(|d| d.with_timezone(&Local)).unwrap_or_else(|_| Local::now());
                let when_text = reminders::describe_due(due, Local::now());
                let repeat_text =
                    if r.repeat == "none" { String::new() } else { format!(", then {}", reminders::describe_repeat(&r.repeat)) };
                Ok(ToolOutput {
                    text: format!("Reminder set for {when_text}{repeat_text} (id {}).", r.id),
                    summary: format!("Reminder set for {when_text}{repeat_text}"),
                    data: Some(json!({"reminder": r})),
                    ..Default::default()
                })
            }
            "add_bill" => {
                let s = bills::save(
                    &ctx.core,
                    None,
                    &bills::SubscriptionInput {
                        name: need(&i.name, "name")?,
                        amount: need(&i.amount, "amount")?,
                        currency: i.currency.unwrap_or_else(|| "USD".into()),
                        cycle: need(&i.cycle, "cycle")?,
                        next_renewal: need(&i.next_renewal, "next_renewal")?,
                        manage_url: None,
                    },
                )?;
                Ok(ToolOutput {
                    text: format!(
                        "Tracking {}: {} {}, next renewal {} (id {}). Lumo warns 3 days before.",
                        s.name,
                        bills::money(s.amount, &s.currency),
                        s.cycle,
                        s.next_renewal,
                        s.id
                    ),
                    summary: format!("Tracking {}", s.name),
                    data: Some(json!({"subscription": s})),
                    ..Default::default()
                })
            }
            "watch_price" => {
                let url = need(&i.url, "url")?;
                crate::plans::check_price_watch_slot(&ctx.core)?;
                let found = prices::read_price(&url).await?;
                let w = prices::add(&ctx.core, &url, i.name.as_deref(), None, &found)?;
                let cur = w.currency.clone().unwrap_or_default();
                Ok(ToolOutput {
                    text: format!(
                        "Watching \"{}\" (id {}). The page's price right now is {}. Lumo checks every 6 hours and notifies on a drop. The user can set a target price in Everyday.",
                        w.name,
                        w.id,
                        bills::money(found.price, &cur)
                    ),
                    summary: format!("Watching {} at {}", crate::util::preview(&w.name, 40), bills::money(found.price, &cur)),
                    data: Some(json!({"priceWatch": w})),
                    ..Default::default()
                })
            }
            "remove" => {
                let id = need(&i.id, "id")?;
                let c = &ctx.core;
                // Ids are unique across reminders, bills and price watches.
                let what = if let Ok(r) = reminders::get(c, &id) {
                    reminders::delete(c, &id)?;
                    format!("the reminder \"{}\"", r.text)
                } else if let Ok(s) = bills::get(c, &id) {
                    bills::delete(c, &id)?;
                    format!("tracking {}", s.name)
                } else {
                    let w = prices::get(c, &id)?;
                    prices::delete(c, &id)?;
                    format!("watching the price of {}", w.name)
                };
                Ok(ToolOutput::text(format!("Removed {what}."), format!("Removed {what}")))
            }
            other => Err(invalid(format!("unknown action {other}"))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::ctx;
    use super::super::{execute, Registry};
    use super::*;
    use crate::core::testing::{core_with, FakePlatform};
    use std::sync::Arc;

    #[tokio::test]
    async fn reminders_and_bills_are_added_from_chat_without_a_prompt_but_not_by_automations() {
        let (core, _d) = core_with(Arc::new(FakePlatform::default()));
        let r = Registry::standard();
        let names: Vec<String> = r.names().into_iter().map(String::from).collect();
        let (user, _) = ctx(core.clone(), Origin::User);
        let call = json!({"type": "tool_use", "id": "r1", "name": "keep_track", "input": {"action": "remind", "text": "Take my meds", "time": "21:00", "repeat": "daily"}});
        let res = execute(&r, &user, &call, &names).await;
        assert!(res.ok, "{}", res.block);
        assert!(res.block.to_string().contains("then every day"));
        assert_eq!(reminders::upcoming(&core).unwrap().len(), 1);

        let bill = json!({"type": "tool_use", "id": "b1", "name": "keep_track", "input": {"action": "add_bill", "name": "Netflix", "amount": 15.49, "cycle": "monthly", "next_renewal": "2026-11-03"}});
        assert!(execute(&r, &user, &bill, &names).await.ok);
        let day = json!({"type": "tool_use", "id": "l1", "name": "get_my_day", "input": {}});
        let out = execute(&r, &user, &day, &names).await;
        let text = out.block.to_string();
        assert!(text.contains("Bills total: about $15.49 a month (USD)") && text.contains("Reminder: Take my meds"), "{text}");
        let id = reminders::upcoming(&core).unwrap()[0].id.clone();
        let remove = json!({"type": "tool_use", "id": "x1", "name": "keep_track", "input": {"action": "remove", "id": id}});
        assert!(execute(&r, &user, &remove, &names).await.ok);
        assert!(reminders::upcoming(&core).unwrap().is_empty());
        assert!(!execute(&r, &user, &remove, &names).await.ok, "already gone");

        // An automation reading a web page can't plant reminders or bills.
        let (auto, _) = ctx(core.clone(), Origin::Automation);
        let res = execute(&r, &auto, &call, &names).await;
        assert!(!res.ok && res.needs_attention);
        assert!(reminders::upcoming(&core).unwrap().is_empty());
    }

    #[tokio::test]
    async fn my_day_says_what_is_not_set_up_instead_of_guessing() {
        let (core, _d) = core_with(Arc::new(FakePlatform::default()));
        let r = Registry::standard();
        let names: Vec<String> = r.names().into_iter().map(String::from).collect();
        let (user, _) = ctx(core.clone(), Origin::User);
        let call = json!({"type": "tool_use", "id": "d1", "name": "get_my_day", "input": {}});
        let out = execute(&r, &user, &call, &names).await;
        assert!(out.ok);
        let text = out.block.to_string();
        assert!(text.contains("Not set up: weather") && text.contains("Not set up: your calendar"), "{text}");
        assert!(!text.contains("Weather:"));
    }
}
