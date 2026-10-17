//! The morning brief: once a day at the user's chosen time, Lumo gathers today's weather, calendar,
//! reminders, renewing bills and price drops into a few warm sentences, shows a notification and
//! (when the user opted in) reads it aloud in the app. It is assembled by plain code, so it costs no
//! model usage and works on every plan.

use super::{bills, calendar, prices, reminders, weather};
use crate::core::Core;
use crate::error::Result;
use crate::util::now;
use chrono::{DateTime, Datelike, Local, NaiveDate, Weekday};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BriefData {
    pub day: String,
    pub weather: Option<weather::Weather>,
    pub events: Vec<String>,
    pub reminders: Vec<String>,
    /// "Netflix ($15.49) renews tomorrow".
    pub bills: Vec<String>,
    /// "Headphones dropped to $249.00 (was $299.00)".
    pub price_drops: Vec<String>,
    /// Sources that couldn't be read (shown, never hidden).
    pub problems: Vec<String>,
    /// Sources not set up yet, with where to set them up.
    pub missing: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Brief {
    pub day: String,
    pub text: String,
    pub data: BriefData,
    pub created_at: String,
    pub seen: bool,
}

/// Gather everything for a local day. Each source fails on its own without spoiling the rest.
pub async fn gather(core: &Core, day: NaiveDate) -> BriefData {
    let mut d = BriefData { day: day.format("%Y-%m-%d").to_string(), ..Default::default() };
    if core.settings().location.is_some() {
        match weather::today(core).await {
            Ok(w) => d.weather = Some(w),
            Err(e) => d.problems.push(format!("Weather: {e}")),
        }
    } else {
        d.missing.push("weather (set your location in Settings → General)".into());
    }
    if calendar::configured(core) {
        match calendar::day_events(core, day).await {
            Ok((events, problems)) => {
                d.events = events.iter().take(12).map(calendar::describe).collect();
                d.problems.extend(problems);
            }
            Err(e) => d.problems.push(format!("Calendar: {e}")),
        }
    } else {
        d.missing.push("your calendar (add it in Settings → Everyday)".into());
    }
    let now = Local::now();
    if let Ok(list) = reminders::on_day(core, day) {
        d.reminders = list
            .iter()
            .map(|r| {
                let at = DateTime::parse_from_rfc3339(&r.due_at)
                    .map(|t| t.with_timezone(&Local).format("%-I:%M %p").to_string())
                    .unwrap_or_default();
                format!("{} at {at}", r.text)
            })
            .collect();
    }
    if let Ok(subs) = bills::list(core) {
        for s in subs {
            if let Ok(next) = NaiveDate::parse_from_str(&s.next_renewal, "%Y-%m-%d") {
                let days = (next - day).num_days();
                if (0..=bills::WARN_DAYS).contains(&days) {
                    d.bills.push(format!("{} ({}) renews {}", s.name, bills::money(s.amount, &s.currency), bills::when_words(days)));
                }
            }
        }
    }
    if let Ok(watches) = prices::list(core) {
        let since = now - chrono::Duration::hours(30);
        for w in watches {
            let recent =
                w.last_checked_at.as_deref().and_then(|t| DateTime::parse_from_rfc3339(t).ok()).map(|t| t > since).unwrap_or(false);
            if let (Some(last), Some(first)) = (w.last_price, w.first_price) {
                if recent && last < first {
                    let cur = w.currency.clone().unwrap_or_default();
                    d.price_drops.push(format!("{} is {} (was {})", w.name, bills::money(last, &cur), bills::money(first, &cur)));
                }
            }
        }
    }
    d
}

fn greeting(name: Option<&str>, day: NaiveDate) -> String {
    let who = name.map(|n| format!(", {}", n.trim())).unwrap_or_default();
    match day.weekday() {
        Weekday::Mon => format!("Good morning{who}! Happy Monday."),
        Weekday::Fri => format!("Good morning{who}! It's Friday."),
        Weekday::Sat | Weekday::Sun => format!("Good morning{who}! Happy {}.", day.format("%A")),
        _ => format!("Good morning{who}!"),
    }
}

fn list_words(items: &[String]) -> String {
    match items {
        [] => String::new(),
        [one] => one.clone(),
        [a, b] => format!("{a} and {b}"),
        _ => format!("{}, and {}", items[..items.len() - 1].join(", "), items[items.len() - 1]),
    }
}

/// The brief as a few short paragraphs, written to be read aloud as well as read.
pub fn compose(name: Option<&str>, d: &BriefData) -> String {
    let day = NaiveDate::parse_from_str(&d.day, "%Y-%m-%d").unwrap_or_else(|_| Local::now().date_naive());
    let mut parts = vec![greeting(name.filter(|n| !n.trim().is_empty()), day)];
    if let Some(w) = &d.weather {
        parts.push(weather::sentence(w));
    }
    match d.events.len() {
        0 if d.missing.iter().all(|m| !m.starts_with("your calendar")) => parts.push("Your calendar is clear today.".into()),
        0 => {}
        1 => parts.push(format!("On your calendar: {}.", d.events[0])),
        n => parts.push(format!("You have {n} things on your calendar: {}.", list_words(&d.events))),
    }
    if !d.reminders.is_empty() {
        parts.push(format!("I'll remind you: {}.", list_words(&d.reminders)));
    }
    if !d.bills.is_empty() {
        parts.push(format!("Heads up: {}.", list_words(&d.bills)));
    }
    if !d.price_drops.is_empty() {
        parts.push(format!("Good news: {}.", list_words(&d.price_drops)));
    }
    if parts.len() == 1 {
        parts.push("Nothing on the schedule today. Enjoy it!".into());
    } else {
        parts.push("Have a lovely day!".into());
    }
    parts.join("\n\n")
}

pub fn today_brief(core: &Core) -> Result<Option<Brief>> {
    let day = Local::now().date_naive().format("%Y-%m-%d").to_string();
    let r = core.db.conn().query_row("SELECT day, text, data_json, created_at, seen FROM briefs WHERE day = ?1", [&day], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, i64>(4)?))
    });
    match r {
        Ok((day, text, data, created_at, seen)) => {
            Ok(Some(Brief { day, text, data: serde_json::from_str(&data).unwrap_or_default(), created_at, seen: seen != 0 }))
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn mark_seen(core: &Core, day: &str) -> Result<()> {
    core.db.conn().execute("UPDATE briefs SET seen = 1 WHERE day = ?1", [day])?;
    Ok(())
}

/// Build today's brief and save it (replacing one made earlier today), then tell the user.
pub async fn make_and_save(core: &Core) -> Result<Brief> {
    let day = Local::now().date_naive();
    let data = gather(core, day).await;
    let text = compose(core.settings().user_name.as_deref(), &data);
    let key = data.day.clone();
    core.db.conn().execute(
        "INSERT INTO briefs(day, text, data_json, created_at, seen) VALUES (?1, ?2, ?3, ?4, 0)
         ON CONFLICT(day) DO UPDATE SET text = excluded.text, data_json = excluded.data_json, created_at = excluded.created_at, seen = 0",
        rusqlite::params![key, text, serde_json::to_string(&data)?, now()],
    )?;
    // Older briefs aren't needed.
    core.db.conn().execute("DELETE FROM briefs WHERE day < date(?1, '-7 days')", [&key])?;
    let first = text.split("\n\n").nth(1).unwrap_or(&text).to_string();
    super::alert(core, "brief", "Your morning brief is ready", &first, Some(&key));
    today_brief(core).map(|b| b.expect("just saved"))
}

/// Whether the brief should be made now: it's on, today's time has come (within six hours), and
/// today's brief doesn't exist yet. A brief missed while Lumo was closed is made when it opens.
pub fn is_due(core: &Core, now: DateTime<Local>) -> bool {
    let s = core.settings();
    if !s.brief_enabled {
        return false;
    }
    let Ok(t) = reminders::parse_time(&s.brief_time) else { return false };
    let at = reminders::local_instant(now.date_naive().and_time(t));
    if now < at || now > at + chrono::Duration::hours(6) {
        return false;
    }
    !core.db.conn().query_row("SELECT 1 FROM briefs WHERE day = ?1", [now.date_naive().format("%Y-%m-%d").to_string()], |_| Ok(())).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::testing::{core_with, FakePlatform};
    use std::sync::Arc;

    #[test]
    fn the_brief_reads_like_a_friend_wrote_it() {
        let d = BriefData {
            day: "2026-10-16".into(),
            weather: Some(weather::Weather {
                place: "Brooklyn".into(),
                unit: "fahrenheit".into(),
                now_temp: Some(54),
                now_sky: Some("partly cloudy".into()),
                high: Some(61),
                low: Some(49),
                day_sky: Some("partly cloudy".into()),
                rain_mm: 0.0,
                rain_from: None,
            }),
            events: vec!["9:00 AM Standup".into(), "12:30 PM Lunch with Sam".into(), "All day: Mom's birthday".into()],
            reminders: vec!["Take my meds at 9:00 PM".into()],
            bills: vec!["Netflix ($15.49) renews tomorrow".into()],
            price_drops: vec![],
            problems: vec![],
            missing: vec![],
        };
        let text = compose(Some("Keder"), &d);
        let paras: Vec<&str> = text.split("\n\n").collect();
        assert_eq!(paras[0], "Good morning, Keder! It's Friday.");
        assert!(paras[1].starts_with("It's 54°F and partly cloudy in Brooklyn"));
        assert_eq!(paras[2], "You have 3 things on your calendar: 9:00 AM Standup, 12:30 PM Lunch with Sam, and All day: Mom's birthday.");
        assert_eq!(paras[3], "I'll remind you: Take my meds at 9:00 PM.");
        assert_eq!(paras[4], "Heads up: Netflix ($15.49) renews tomorrow.");
        assert_eq!(*paras.last().unwrap(), "Have a lovely day!");

        let empty = BriefData {
            day: "2026-10-17".into(),
            missing: vec!["your calendar (add it in Settings → Everyday)".into()],
            ..Default::default()
        };
        assert_eq!(compose(None, &empty), "Good morning! Happy Saturday.\n\nNothing on the schedule today. Enjoy it!");
    }

    #[tokio::test]
    async fn it_is_made_once_a_day_at_the_chosen_time() {
        let platform = Arc::new(FakePlatform::default());
        let (core, _d) = core_with(platform.clone());
        let mut s = core.settings();
        s.brief_enabled = true;
        s.brief_time = "08:00".into();
        crate::settings::save(&core.db, &s).unwrap();
        let today = Local::now().date_naive();
        let at = |h: u32, m: u32| reminders::local_instant(today.and_hms_opt(h, m, 0).unwrap());
        assert!(!is_due(&core, at(7, 59)));
        assert!(is_due(&core, at(8, 0)));
        assert!(is_due(&core, at(13, 30)), "made late if Lumo was closed at 8");
        assert!(!is_due(&core, at(14, 30)), "too late to call it a morning brief");

        reminders::add(&core, "Water the plants", &reminders::When { time: Some("23:59".into()), ..Default::default() }, "none").unwrap();
        let b = make_and_save(&core).await.unwrap();
        assert!(b.text.contains("I'll remind you: Water the plants at 11:59 PM."), "{}", b.text);
        assert!(b.data.missing.len() == 2, "no location and no calendar yet: {:?}", b.data.missing);
        assert!(!b.seen);
        assert_eq!(platform.notifications.lock().last().unwrap().0, "Your morning brief is ready");
        assert!(!is_due(&core, at(8, 1)), "only once a day");
        mark_seen(&core, &b.day).unwrap();
        assert!(today_brief(&core).unwrap().unwrap().seen);

        s.brief_enabled = false;
        crate::settings::save(&core.db, &s).unwrap();
        core.db.conn().execute("DELETE FROM briefs", []).unwrap();
        assert!(!is_due(&core, at(8, 0)));
    }
}
