//! The user's calendar, read from private iCalendar (ICS) addresses they paste in Settings. Google
//! Calendar, Outlook and iCloud all offer one ("secret address in iCal format"), so there is no
//! account sign-in and nothing to pay for. The addresses work like passwords, so they live in the
//! system keychain, and they are fetched with the same public-address checks as web pages.

use crate::core::Core;
use crate::error::{invalid, LumoError, Result};
use chrono::{DateTime, Duration, Local, NaiveDate, NaiveDateTime, TimeZone, Utc};
use serde::Serialize;
use std::collections::{HashMap, HashSet};

/// Keychain entry holding the addresses, one per line.
pub const SECRET: &str = "calendar_ics_urls";
const MAX_FEEDS: usize = 5;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub title: String,
    pub start: DateTime<Local>,
    pub end: DateTime<Local>,
    pub all_day: bool,
    pub location: Option<String>,
}

/// Check and normalize the pasted addresses: https (or webcal, which is https), at most five.
pub fn normalize_urls(raw: &str) -> Result<Vec<String>> {
    let mut out = Vec::new();
    for line in raw.lines().map(str::trim).filter(|l| !l.is_empty()) {
        let fixed = match line.strip_prefix("webcal://") {
            Some(rest) => format!("https://{rest}"),
            None => line.to_string(),
        };
        let u = url::Url::parse(&fixed).map_err(|_| invalid(format!("'{}' is not a calendar address", crate::util::preview(line, 60))))?;
        if u.scheme() != "https" || u.host_str().is_none() {
            return Err(invalid("calendar addresses must start with https:// or webcal://"));
        }
        if !out.contains(&u.to_string()) {
            out.push(u.to_string());
        }
    }
    if out.len() > MAX_FEEDS {
        return Err(invalid(format!("add at most {MAX_FEEDS} calendars")));
    }
    Ok(out)
}

pub fn configured(core: &Core) -> bool {
    core.secrets.get(SECRET).ok().flatten().map(|s| !s.trim().is_empty()).unwrap_or(false)
}

/// Lines of an ICS file with folded lines joined.
fn unfold(text: &str) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    for raw in text.split('\n') {
        let l = raw.trim_end_matches('\r');
        if (l.starts_with(' ') || l.starts_with('\t')) && !lines.is_empty() {
            lines.last_mut().unwrap().push_str(&l[1..]);
        } else {
            lines.push(l.to_string());
        }
    }
    lines
}

struct Prop {
    name: String,
    params: Vec<(String, String)>,
    value: String,
}

fn parse_prop(line: &str) -> Option<Prop> {
    // NAME;PARAM=VAL;PARAM="VAL:WITH:COLONS":VALUE
    let mut in_quote = false;
    let colon = line.char_indices().find(|&(_, c)| {
        if c == '"' {
            in_quote = !in_quote;
        }
        c == ':' && !in_quote
    })?;
    let (head, value) = (&line[..colon.0], &line[colon.0 + 1..]);
    let mut parts = head.split(';');
    let name = parts.next()?.to_ascii_uppercase();
    let params = parts.filter_map(|p| p.split_once('=')).map(|(k, v)| (k.to_ascii_uppercase(), v.trim_matches('"').to_string())).collect();
    Some(Prop { name, params, value: value.to_string() })
}

fn unescape(s: &str) -> String {
    s.replace("\\n", " ").replace("\\N", " ").replace("\\,", ",").replace("\\;", ";").replace("\\\\", "\\").trim().to_string()
}

/// A date or date-time value as a local instant. Unknown time zones (such as Windows names) are read
/// as local time, which is right for most people's own calendars.
fn parse_when(value: &str, tzid: Option<&str>) -> Option<(DateTime<Local>, bool)> {
    let v = value.trim();
    if v.len() == 8 {
        let d = NaiveDate::parse_from_str(v, "%Y%m%d").ok()?;
        return Some((super::reminders::local_instant(d.and_hms_opt(0, 0, 0)?), true));
    }
    if let Some(utc) = v.strip_suffix('Z') {
        let n = NaiveDateTime::parse_from_str(utc, "%Y%m%dT%H%M%S").ok()?;
        return Some((Utc.from_utc_datetime(&n).with_timezone(&Local), false));
    }
    let n = NaiveDateTime::parse_from_str(v, "%Y%m%dT%H%M%S").ok()?;
    if let Some(tz) = tzid.and_then(|t| t.parse::<chrono_tz::Tz>().ok()) {
        if let Some(t) = tz.from_local_datetime(&n).earliest() {
            return Some((t.with_timezone(&Local), false));
        }
    }
    Some((super::reminders::local_instant(n), false))
}

/// "PT1H30M", "P1D", "P1W" as a duration.
fn parse_duration(s: &str) -> Option<Duration> {
    let s = s.trim().trim_start_matches('+');
    let rest = s.strip_prefix('P')?;
    let (mut total, mut num, mut in_time) = (Duration::zero(), String::new(), false);
    for c in rest.chars() {
        match c {
            'T' => in_time = true,
            '0'..='9' => num.push(c),
            _ => {
                let n: i64 = num.parse().ok()?;
                num.clear();
                total += match (c, in_time) {
                    ('W', _) => Duration::weeks(n),
                    ('D', _) => Duration::days(n),
                    ('H', true) => Duration::hours(n),
                    ('M', true) => Duration::minutes(n),
                    ('S', true) => Duration::seconds(n),
                    _ => return None,
                };
            }
        }
    }
    Some(total)
}

fn param<'a>(p: &'a Prop, key: &str) -> Option<&'a str> {
    p.params.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
}

/// The DTSTART/RRULE/EXDATE lines in the form the rrule crate accepts: all-day dates become local
/// midnight and unknown time zones are dropped (read as local time), matching `parse_when`.
fn rule_line(p: &Prop) -> String {
    let tz = param(p, "TZID").filter(|t| t.parse::<chrono_tz::Tz>().is_ok());
    let values: Vec<String> =
        p.value.split(',').map(|v| if v.trim().len() == 8 { format!("{}T000000", v.trim()) } else { v.trim().to_string() }).collect();
    match tz {
        Some(t) => format!("{};TZID={t}:{}", p.name, values.join(",")),
        None => format!("{}:{}", p.name, values.join(",")),
    }
}

struct RawEvent {
    uid: String,
    title: String,
    start: DateTime<Local>,
    all_day: bool,
    length: Duration,
    location: Option<String>,
    recurrence_id: Option<DateTime<Local>>,
    rule_lines: Vec<String>,
    cancelled: bool,
}

fn raw_events(text: &str) -> Vec<RawEvent> {
    let mut out = Vec::new();
    let mut cur: Option<Vec<Prop>> = None;
    for line in unfold(text) {
        match line.trim() {
            "BEGIN:VEVENT" => cur = Some(Vec::new()),
            "END:VEVENT" => {
                if let Some(props) = cur.take() {
                    if let Some(e) = to_raw(&props) {
                        out.push(e);
                    }
                }
            }
            _ => {
                if let (Some(props), Some(p)) = (cur.as_mut(), parse_prop(&line)) {
                    props.push(p);
                }
            }
        }
        if out.len() > 20_000 {
            break;
        }
    }
    out
}

fn to_raw(props: &[Prop]) -> Option<RawEvent> {
    let get = |n: &str| props.iter().find(|p| p.name == n);
    let dtstart = get("DTSTART")?;
    let (start, all_day) = parse_when(&dtstart.value, param(dtstart, "TZID"))?;
    let length = match (get("DTEND"), get("DURATION")) {
        (Some(e), _) => parse_when(&e.value, param(e, "TZID")).map(|(end, _)| end - start).unwrap_or_else(Duration::zero),
        (None, Some(d)) => parse_duration(&d.value).unwrap_or_else(Duration::zero),
        _ if all_day => Duration::days(1),
        _ => Duration::zero(),
    };
    let mut rule_lines = vec![rule_line(dtstart)];
    for p in props.iter().filter(|p| matches!(p.name.as_str(), "RRULE" | "EXDATE" | "RDATE")) {
        rule_lines.push(if p.name == "RRULE" { format!("RRULE:{}", p.value.trim()) } else { rule_line(p) });
    }
    Some(RawEvent {
        uid: get("UID").map(|p| p.value.trim().to_string()).unwrap_or_default(),
        title: get("SUMMARY").map(|p| unescape(&p.value)).filter(|s| !s.is_empty()).unwrap_or_else(|| "(No title)".into()),
        start,
        all_day,
        length: length.max(Duration::zero()),
        location: get("LOCATION").map(|p| unescape(&p.value)).filter(|s| !s.is_empty()),
        recurrence_id: get("RECURRENCE-ID").and_then(|p| parse_when(&p.value, param(p, "TZID"))).map(|(t, _)| t),
        rule_lines,
        cancelled: get("STATUS").map(|p| p.value.trim().eq_ignore_ascii_case("CANCELLED")).unwrap_or(false),
    })
}

/// Start times of a (possibly repeating) event that begin before `to` and end after `from`.
fn occurrences(e: &RawEvent, from: DateTime<Local>, to: DateTime<Local>) -> Vec<DateTime<Local>> {
    if !e.rule_lines.iter().any(|l| l.starts_with("RRULE") || l.starts_with("RDATE")) {
        return if e.start < to && e.start + e.length.max(Duration::seconds(1)) > from { vec![e.start] } else { vec![] };
    }
    let set: rrule::RRuleSet = match e.rule_lines.join("\n").parse() {
        Ok(s) => s,
        Err(err) => {
            log::warn!("calendar: skipping a repeat rule Lumo can't read ({err})");
            return if e.start < to && e.start + e.length > from { vec![e.start] } else { vec![] };
        }
    };
    let lo = (from - e.length - Duration::seconds(1)).with_timezone(&rrule::Tz::LOCAL);
    let hi = to.with_timezone(&rrule::Tz::LOCAL);
    set.after(lo)
        .before(hi)
        .all(500)
        .dates
        .into_iter()
        .map(|d| d.with_timezone(&Local))
        .filter(|s| *s < to && *s + e.length.max(Duration::seconds(1)) > from)
        .collect()
}

/// Events overlapping [from, to), earliest first, from the text of one or more ICS files.
pub fn events_between(ics: &[String], from: DateTime<Local>, to: DateTime<Local>) -> Vec<Event> {
    let mut out = Vec::new();
    for text in ics {
        let raws = raw_events(text);
        // A moved or cancelled single instance (RECURRENCE-ID) replaces that instance of the series.
        let overridden: HashSet<(String, i64)> =
            raws.iter().filter_map(|e| e.recurrence_id.map(|r| (e.uid.clone(), r.timestamp()))).collect();
        for e in &raws {
            if e.cancelled {
                continue;
            }
            for start in occurrences(e, from, to) {
                if e.recurrence_id.is_none() && overridden.contains(&(e.uid.clone(), start.timestamp())) {
                    continue;
                }
                out.push(Event { title: e.title.clone(), start, end: start + e.length, all_day: e.all_day, location: e.location.clone() });
            }
        }
    }
    out.sort_by_key(|e| (!e.all_day, e.start));
    let mut seen = HashMap::new();
    out.retain(|e| seen.insert((e.title.clone(), e.start), ()).is_none());
    out
}

/// Events on a local day from every saved calendar. Calendars that fail are reported, not fatal.
pub async fn day_events(core: &Core, day: NaiveDate) -> Result<(Vec<Event>, Vec<String>)> {
    let Some(raw) = core.secrets.get(SECRET)? else {
        return Err(LumoError::Unavailable(
            "No calendar is connected. Add your calendar's private iCal address in Settings → Everyday.".into(),
        ));
    };
    let urls = normalize_urls(&raw)?;
    let mut texts = Vec::new();
    let mut problems = Vec::new();
    for (i, u) in urls.iter().enumerate() {
        let what = if urls.len() == 1 { "Your calendar".to_string() } else { format!("Calendar {}", i + 1) };
        match crate::tools::web::fetch_public(u, "text/calendar,*/*;q=0.5", 10 * 1024 * 1024).await {
            Ok(p) if p.status < 300 => texts.push(String::from_utf8_lossy(&p.body).to_string()),
            Ok(p) => problems.push(format!("{what} could not be read (HTTP {}). Its address may have changed.", p.status)),
            Err(e) => problems.push(format!("{what} could not be read: {e}")),
        }
    }
    let from = super::reminders::local_instant(day.and_hms_opt(0, 0, 0).unwrap_or_default());
    let to = super::reminders::local_instant(day.succ_opt().unwrap_or(day).and_hms_opt(0, 0, 0).unwrap_or_default());
    Ok((events_between(&texts, from, to), problems))
}

/// "9:00 AM Standup", "All day: Mom's birthday".
pub fn describe(e: &Event) -> String {
    if e.all_day {
        format!("All day: {}", e.title)
    } else {
        format!("{} {}", e.start.format("%-I:%M %p"), e.title)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ICS: &str = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\n\
BEGIN:VEVENT\r\nUID:a\r\nDTSTART:20261016T120000Z\r\nDTEND:20261016T123000Z\r\nSUMMARY:Dentist\\, Dr. Lee\r\nLOCATION:12 Main St\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nUID:b\r\nDTSTART;VALUE=DATE:20261016\r\nDTEND;VALUE=DATE:20261017\r\nSUMMARY:Mom's birth\r\n day\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nUID:c\r\nDTSTART;TZID=Unknown Windows Zone:20261001T090000\r\nDURATION:PT15M\r\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR\r\nSUMMARY:Standup\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nUID:c\r\nRECURRENCE-ID;TZID=Unknown Windows Zone:20261019T090000\r\nDTSTART;TZID=Unknown Windows Zone:20261019T110000\r\nDURATION:PT15M\r\nSUMMARY:Standup (moved)\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nUID:d\r\nDTSTART:20261016T121500Z\r\nDTEND:20261016T130000Z\r\nSTATUS:CANCELLED\r\nSUMMARY:Cancelled thing\r\nEND:VEVENT\r\n\
END:VCALENDAR\r\n";

    fn day(y: i32, m: u32, d: u32) -> (DateTime<Local>, DateTime<Local>) {
        let n = NaiveDate::from_ymd_opt(y, m, d).unwrap();
        let at = |n: NaiveDate| crate::everyday::reminders::local_instant(n.and_hms_opt(0, 0, 0).unwrap());
        (at(n), at(n.succ_opt().unwrap()))
    }

    #[test]
    fn reads_single_all_day_repeating_and_moved_events() {
        let (from, to) = day(2026, 10, 16); // a Friday
        let ev = events_between(&[ICS.to_string()], from, to);
        let titles: Vec<&str> = ev.iter().map(|e| e.title.as_str()).collect();
        assert!(titles.contains(&"Mom's birthday"), "{titles:?}");
        assert!(titles.contains(&"Standup"), "{titles:?}");
        assert!(!titles.contains(&"Cancelled thing"));
        assert_eq!(ev[0].title, "Mom's birthday", "all-day events come first");
        let dentist = ev.iter().find(|e| e.title.starts_with("Dentist")).expect("dentist (UTC times)");
        assert_eq!(dentist.title, "Dentist, Dr. Lee");
        assert_eq!(dentist.location.as_deref(), Some("12 Main St"));
        assert_eq!(dentist.end - dentist.start, Duration::minutes(30));
        let standup = ev.iter().find(|e| e.title == "Standup").unwrap();
        assert_eq!(standup.start.format("%H:%M").to_string(), "09:00", "unknown zones read as local time");
        assert_eq!(describe(standup), "9:00 AM Standup");

        // Monday the 19th: the moved instance replaces the regular one.
        let (from, to) = day(2026, 10, 19);
        let mon: Vec<String> = events_between(&[ICS.to_string()], from, to).iter().map(describe).collect();
        assert_eq!(mon, vec!["11:00 AM Standup (moved)".to_string()]);
        // Saturday: nothing repeats.
        let (from, to) = day(2026, 10, 17);
        assert!(events_between(&[ICS.to_string()], from, to).is_empty());
    }

    #[test]
    fn addresses_are_checked_and_webcal_becomes_https() {
        let urls = normalize_urls(
            "webcal://p01-caldav.icloud.com/published/2/abc\n\nhttps://calendar.google.com/calendar/ical/x/private-y/basic.ics",
        )
        .unwrap();
        assert_eq!(urls[0], "https://p01-caldav.icloud.com/published/2/abc");
        assert_eq!(urls.len(), 2);
        assert!(normalize_urls("http://example.com/cal.ics").is_err());
        assert!(normalize_urls("file:///etc/passwd").is_err());
        assert!(normalize_urls("https://a.example/1\n").is_ok());
        let six: String = (0..6).map(|i| format!("https://a.example/{i}\n")).collect();
        assert!(normalize_urls(&six).is_err());
    }

    #[test]
    fn durations_parse() {
        assert_eq!(parse_duration("PT1H30M"), Some(Duration::minutes(90)));
        assert_eq!(parse_duration("P1D"), Some(Duration::days(1)));
        assert_eq!(parse_duration("P1W"), Some(Duration::weeks(1)));
        assert_eq!(parse_duration("1H"), None);
    }
}
