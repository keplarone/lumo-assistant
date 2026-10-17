//! Plain-word reminders ("remind me to take my meds at 9"). The model turns the words into a time and
//! a repeat; firing is plain code in the scheduler loop (a notification and a mascot pop-out), so a
//! reminder never calls a model and never counts against the plan's automations.

use crate::core::Core;
use crate::error::{invalid, LumoError, Result};
use crate::util::{new_id, now};
use chrono::{DateTime, Datelike, Duration, Local, LocalResult, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc, Weekday};
use serde::Serialize;

pub const REPEATS: &[&str] = &["none", "daily", "weekdays", "weekly", "monthly"];
const MAX_ACTIVE: i64 = 500;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reminder {
    pub id: String,
    pub text: String,
    /// The next time it fires (UTC).
    pub due_at: String,
    pub repeat: String,
    pub done: bool,
    pub last_fired_at: Option<String>,
    pub created_at: String,
}

/// When to remind: a clock time (with an optional date), or a number of minutes from now.
#[derive(Debug, Clone, Default)]
pub struct When {
    pub time: Option<String>,
    pub date: Option<String>,
    pub in_minutes: Option<u32>,
}

/// A local wall-clock time as an instant. In a DST gap the time moves forward an hour; in an overlap
/// the earlier of the two is used.
pub fn local_instant(naive: NaiveDateTime) -> DateTime<Local> {
    match Local.from_local_datetime(&naive) {
        LocalResult::Single(t) => t,
        LocalResult::Ambiguous(a, _) => a,
        LocalResult::None => Local.from_local_datetime(&(naive + Duration::hours(1))).earliest().unwrap_or_else(Local::now),
    }
}

pub fn parse_time(s: &str) -> Result<NaiveTime> {
    let s = s.trim();
    let (h, m) = s.split_once(':').ok_or_else(|| invalid("time must be HH:MM (24-hour)"))?;
    let (h, m): (u32, u32) =
        (h.parse().map_err(|_| invalid("time must be HH:MM (24-hour)"))?, m.parse().map_err(|_| invalid("time must be HH:MM (24-hour)"))?);
    NaiveTime::from_hms_opt(h, m, 0).ok_or_else(|| invalid("time must be HH:MM (24-hour)"))
}

pub fn parse_date(s: &str) -> Result<NaiveDate> {
    NaiveDate::parse_from_str(s.trim(), "%Y-%m-%d").map_err(|_| invalid("date must be YYYY-MM-DD"))
}

/// The first time a reminder fires, from `now`.
pub fn first_due(when: &When, repeat: &str, now: DateTime<Local>) -> Result<DateTime<Local>> {
    if let Some(m) = when.in_minutes {
        if when.time.is_some() || when.date.is_some() {
            return Err(invalid("give either in_minutes or a time, not both"));
        }
        if !(1..=60 * 24 * 366).contains(&m) {
            return Err(invalid("in_minutes must be between 1 minute and a year"));
        }
        return Ok(now + Duration::minutes(m as i64));
    }
    let time = parse_time(when.time.as_deref().ok_or_else(|| invalid("say when: a time (HH:MM) or in_minutes"))?)?;
    match when.date.as_deref() {
        Some(d) => {
            let at = local_instant(parse_date(d)?.and_time(time));
            if at <= now {
                return Err(invalid("that time has already passed"));
            }
            if at > now + Duration::days(366 * 2) {
                return Err(invalid("reminders can be set up to two years ahead"));
            }
            Ok(at)
        }
        None => {
            // The next time the clock shows `time`, on a day the repeat allows.
            let mut day = now.date_naive();
            for _ in 0..8 {
                let at = local_instant(day.and_time(time));
                if at > now && (repeat != "weekdays" || is_weekday(day)) {
                    return Ok(at);
                }
                day = day.succ_opt().ok_or_else(|| invalid("date out of range"))?;
            }
            Err(invalid("could not schedule that time"))
        }
    }
}

fn is_weekday(d: NaiveDate) -> bool {
    !matches!(d.weekday(), Weekday::Sat | Weekday::Sun)
}

/// The same local day number in a later month, clamped to that month's length (Jan 31 → Feb 28).
pub fn add_months(d: NaiveDate, months: u32) -> NaiveDate {
    let total = d.year() * 12 + d.month0() as i32 + months as i32;
    let (y, m) = (total.div_euclid(12), total.rem_euclid(12) as u32 + 1);
    (0..4).find_map(|back| NaiveDate::from_ymd_opt(y, m, d.day() - back)).unwrap_or(d)
}

/// The next time a repeating reminder fires after it fired at `last` (local wall-clock time kept).
pub fn next_after(last: DateTime<Local>, repeat: &str, now: DateTime<Local>) -> Option<DateTime<Local>> {
    let time = last.time();
    let mut day = last.date_naive();
    // Skip occurrences missed while Lumo was closed: one notification, not a burst.
    for _ in 0..2000 {
        day = match repeat {
            "daily" => day.succ_opt()?,
            "weekdays" => {
                let mut d = day.succ_opt()?;
                while !is_weekday(d) {
                    d = d.succ_opt()?;
                }
                d
            }
            "weekly" => day + Duration::days(7),
            "monthly" => add_months(last.date_naive(), months_between(last.date_naive(), day) + 1),
            _ => return None,
        };
        let at = local_instant(day.and_time(time));
        if at > now {
            return Some(at);
        }
    }
    None
}

fn months_between(a: NaiveDate, b: NaiveDate) -> u32 {
    ((b.year() - a.year()) * 12 + b.month() as i32 - a.month() as i32).max(0) as u32
}

fn row(r: &rusqlite::Row) -> rusqlite::Result<Reminder> {
    Ok(Reminder {
        id: r.get(0)?,
        text: r.get(1)?,
        due_at: r.get(2)?,
        repeat: r.get(3)?,
        done: r.get::<_, i64>(4)? != 0,
        last_fired_at: r.get(5)?,
        created_at: r.get(6)?,
    })
}
const COLS: &str = "id, text, due_at, repeat, done, last_fired_at, created_at";

pub fn add(core: &Core, text: &str, when: &When, repeat: &str) -> Result<Reminder> {
    let text = text.trim();
    if text.is_empty() || text.chars().count() > 300 {
        return Err(invalid("a reminder must be 1 to 300 characters"));
    }
    if !REPEATS.contains(&repeat) {
        return Err(invalid("repeat must be none, daily, weekdays, weekly or monthly"));
    }
    let active: i64 = core.db.conn().query_row("SELECT count(*) FROM reminders WHERE done = 0", [], |r| r.get(0))?;
    if active >= MAX_ACTIVE {
        return Err(invalid("you have 500 reminders already; finish or delete some first"));
    }
    let due = first_due(when, repeat, Local::now())?;
    let id = new_id();
    core.db.conn().execute(
        &format!("INSERT INTO reminders({COLS}) VALUES (?1, ?2, ?3, ?4, 0, NULL, ?5)"),
        rusqlite::params![id, text, due.with_timezone(&Utc).to_rfc3339(), repeat, now()],
    )?;
    core.platform.broadcast("everyday-changed", serde_json::json!({"kind": "reminders"}));
    get(core, &id)
}

pub fn get(core: &Core, id: &str) -> Result<Reminder> {
    core.db
        .conn()
        .query_row(&format!("SELECT {COLS} FROM reminders WHERE id = ?1"), [id], row)
        .map_err(|_| LumoError::NotFound("reminder".into()))
}

/// Upcoming reminders, soonest first.
pub fn upcoming(core: &Core) -> Result<Vec<Reminder>> {
    let conn = core.db.conn();
    let mut st = conn.prepare(&format!("SELECT {COLS} FROM reminders WHERE done = 0 ORDER BY due_at"))?;
    let rows = st.query_map([], row)?.collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Upcoming reminders that fire on a local day.
pub fn on_day(core: &Core, day: NaiveDate) -> Result<Vec<Reminder>> {
    Ok(upcoming(core)?
        .into_iter()
        .filter(|r| DateTime::parse_from_rfc3339(&r.due_at).map(|d| d.with_timezone(&Local).date_naive() == day).unwrap_or(false))
        .collect())
}

pub fn delete(core: &Core, id: &str) -> Result<()> {
    let n = core.db.conn().execute("DELETE FROM reminders WHERE id = ?1", [id])?;
    if n == 0 {
        return Err(LumoError::NotFound("reminder".into()));
    }
    core.platform.broadcast("everyday-changed", serde_json::json!({"kind": "reminders"}));
    Ok(())
}

/// Fire every reminder that is due: notify, then move repeating ones to their next time and mark
/// one-off ones done. Returns how many fired.
pub fn fire_due(core: &Core, at: DateTime<Utc>) -> Result<usize> {
    let due: Vec<Reminder> = upcoming(core)?
        .into_iter()
        .filter(|r| DateTime::parse_from_rfc3339(&r.due_at).map(|d| d.with_timezone(&Utc) <= at).unwrap_or(false))
        .collect();
    for r in &due {
        let fired = DateTime::parse_from_rfc3339(&r.due_at).map(|d| d.with_timezone(&Local)).unwrap_or_else(|_| Local::now());
        let next = next_after(fired, &r.repeat, at.with_timezone(&Local));
        {
            let conn = core.db.conn();
            match next {
                Some(n) => conn.execute(
                    "UPDATE reminders SET due_at = ?2, last_fired_at = ?3 WHERE id = ?1",
                    rusqlite::params![r.id, n.with_timezone(&Utc).to_rfc3339(), now()],
                )?,
                None => conn.execute("UPDATE reminders SET done = 1, last_fired_at = ?2 WHERE id = ?1", rusqlite::params![r.id, now()])?,
            };
        }
        super::alert(core, "reminder", "Reminder", &r.text, Some(&r.id));
    }
    if !due.is_empty() {
        core.platform.broadcast("everyday-changed", serde_json::json!({"kind": "reminders"}));
    }
    Ok(due.len())
}

/// "9:00 AM today", "Fri 6:30 PM", "Oct 30, 9:00 AM".
pub fn describe_due(due: DateTime<Local>, now: DateTime<Local>) -> String {
    let time = due.format("%-I:%M %p").to_string();
    let days = (due.date_naive() - now.date_naive()).num_days();
    match days {
        0 => format!("{time} today"),
        1 => format!("{time} tomorrow"),
        2..=6 => format!("{} {time}", due.format("%a")),
        _ => format!("{}, {time}", due.format("%b %-d")),
    }
}

pub fn describe_repeat(repeat: &str) -> &'static str {
    match repeat {
        "daily" => "every day",
        "weekdays" => "every weekday",
        "weekly" => "every week",
        "monthly" => "every month",
        _ => "once",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::testing::{core_with, FakePlatform};
    use std::sync::Arc;

    fn local(y: i32, m: u32, d: u32, h: u32, min: u32) -> DateTime<Local> {
        local_instant(NaiveDate::from_ymd_opt(y, m, d).unwrap().and_hms_opt(h, min, 0).unwrap())
    }

    #[test]
    fn plain_times_become_the_next_matching_moment() {
        let now = local(2026, 10, 16, 21, 0); // a Friday evening
        let at9 = When { time: Some("09:00".into()), ..Default::default() };
        assert_eq!(first_due(&at9, "none", now).unwrap(), local(2026, 10, 17, 9, 0), "9:00 already passed today");
        let at22 = When { time: Some("22:15".into()), ..Default::default() };
        assert_eq!(first_due(&at22, "daily", now).unwrap(), local(2026, 10, 16, 22, 15));
        assert_eq!(first_due(&at9, "weekdays", now).unwrap(), local(2026, 10, 19, 9, 0), "skips the weekend");
        let soon = When { in_minutes: Some(20), ..Default::default() };
        assert_eq!(first_due(&soon, "none", now).unwrap(), now + Duration::minutes(20));
        let dated = When { time: Some("08:30".into()), date: Some("2026-12-24".into()), ..Default::default() };
        assert_eq!(first_due(&dated, "none", now).unwrap(), local(2026, 12, 24, 8, 30));
        for bad in [
            When { time: Some("25:00".into()), ..Default::default() },
            When { time: Some("9am".into()), ..Default::default() },
            When { time: Some("08:00".into()), date: Some("2026-10-01".into()), ..Default::default() },
            When { in_minutes: Some(0), ..Default::default() },
            When { in_minutes: Some(5), time: Some("09:00".into()), ..Default::default() },
            When::default(),
        ] {
            assert!(first_due(&bad, "none", now).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn repeats_keep_the_clock_time_and_skip_missed_ones() {
        let fri9 = local(2026, 10, 16, 9, 0);
        assert_eq!(next_after(fri9, "daily", fri9).unwrap(), local(2026, 10, 17, 9, 0));
        assert_eq!(next_after(fri9, "weekdays", fri9).unwrap(), local(2026, 10, 19, 9, 0));
        assert_eq!(next_after(fri9, "weekly", fri9).unwrap(), local(2026, 10, 23, 9, 0));
        assert_eq!(next_after(fri9, "monthly", fri9).unwrap(), local(2026, 11, 16, 9, 0));
        assert!(next_after(fri9, "none", fri9).is_none());
        // Lumo was closed for three days: the next one is after now, not a backlog.
        assert_eq!(next_after(fri9, "daily", local(2026, 10, 19, 12, 0)).unwrap(), local(2026, 10, 20, 9, 0));
        // Month ends clamp and then return to the original day.
        let jan31 = local(2027, 1, 31, 8, 0);
        assert_eq!(next_after(jan31, "monthly", jan31).unwrap(), local(2027, 2, 28, 8, 0));
        assert_eq!(add_months(NaiveDate::from_ymd_opt(2027, 1, 31).unwrap(), 2), NaiveDate::from_ymd_opt(2027, 3, 31).unwrap());
    }

    #[test]
    fn due_reminders_notify_once_and_repeating_ones_move_on() {
        let platform = Arc::new(FakePlatform::default());
        let (core, _d) = core_with(platform.clone());
        let once = add(&core, "Take my meds", &When { in_minutes: Some(5), ..Default::default() }, "none").unwrap();
        let daily = add(&core, "Stretch", &When { in_minutes: Some(10), ..Default::default() }, "daily").unwrap();
        assert_eq!(fire_due(&core, Utc::now()).unwrap(), 0);
        assert_eq!(fire_due(&core, Utc::now() + Duration::minutes(11)).unwrap(), 2);
        let notes = platform.notifications.lock().clone();
        assert!(notes.iter().any(|(_, b)| b == "Take my meds") && notes.iter().any(|(_, b)| b == "Stretch"));
        assert!(get(&core, &once.id).unwrap().done);
        let d = get(&core, &daily.id).unwrap();
        assert!(!d.done && d.due_at > daily.due_at);
        // Nothing fires twice.
        assert_eq!(fire_due(&core, Utc::now() + Duration::minutes(12)).unwrap(), 0);
        assert_eq!(upcoming(&core).unwrap().len(), 1);
        assert!(add(&core, " ", &When { in_minutes: Some(5), ..Default::default() }, "none").is_err());
        assert!(add(&core, "x", &When { in_minutes: Some(5), ..Default::default() }, "hourly").is_err());
        delete(&core, &daily.id).unwrap();
        assert!(upcoming(&core).unwrap().is_empty());
    }
}
