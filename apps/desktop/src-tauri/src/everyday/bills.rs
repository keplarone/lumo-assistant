//! Bills and subscriptions. Lumo keeps a list of recurring charges (added by the user, or found in a
//! bank or card statement they export as CSV) and warns a few days before each one renews. No bank
//! connection and no payment details: only a name, an amount, a cycle and the next renewal date.

use crate::core::Core;
use crate::error::{invalid, LumoError, Result};
use crate::util::{new_id, now};
use chrono::{Datelike, Duration, Local, NaiveDate};
use serde::Serialize;
use std::collections::HashMap;

pub const CYCLES: &[&str] = &["weekly", "monthly", "yearly"];
/// Days before a renewal that Lumo warns.
pub const WARN_DAYS: i64 = 3;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Subscription {
    pub id: String,
    pub name: String,
    pub amount: f64,
    pub currency: String,
    pub cycle: String,
    /// Local date, YYYY-MM-DD.
    pub next_renewal: String,
    /// Where the user manages or cancels it.
    pub manage_url: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone)]
pub struct SubscriptionInput {
    pub name: String,
    pub amount: f64,
    pub currency: String,
    pub cycle: String,
    pub next_renewal: String,
    pub manage_url: Option<String>,
}

pub fn validate(i: &SubscriptionInput) -> Result<NaiveDate> {
    if i.name.trim().is_empty() || i.name.chars().count() > 80 {
        return Err(invalid("a name must be 1 to 80 characters"));
    }
    if !(i.amount.is_finite() && i.amount >= 0.0 && i.amount < 1_000_000.0) {
        return Err(invalid("the amount must be a positive number"));
    }
    let c = i.currency.trim();
    if c.len() != 3 || !c.chars().all(|ch| ch.is_ascii_alphabetic()) {
        return Err(invalid("currency must be a 3-letter code like USD or EUR"));
    }
    if !CYCLES.contains(&i.cycle.as_str()) {
        return Err(invalid("cycle must be weekly, monthly or yearly"));
    }
    if let Some(u) = &i.manage_url {
        let parsed = url::Url::parse(u).map_err(|_| invalid("the manage link is not a valid address"))?;
        if parsed.scheme() != "https" {
            return Err(invalid("the manage link must start with https://"));
        }
    }
    NaiveDate::parse_from_str(i.next_renewal.trim(), "%Y-%m-%d").map_err(|_| invalid("next renewal must be a date (YYYY-MM-DD)"))
}

/// The renewal after `d` for a cycle. Monthly and yearly keep the day of the month where it exists.
pub fn advance(d: NaiveDate, cycle: &str, anchor_day: u32) -> NaiveDate {
    match cycle {
        "weekly" => d + Duration::days(7),
        "yearly" => super::reminders::add_months(d.with_day(1).unwrap_or(d), 12)
            .with_day(anchor_day.min(days_in_month(d.year() + 1, d.month())))
            .unwrap_or(d),
        _ => {
            let next = super::reminders::add_months(d.with_day(1).unwrap_or(d), 1);
            next.with_day(anchor_day.min(days_in_month(next.year(), next.month()))).unwrap_or(next)
        }
    }
}

fn days_in_month(y: i32, m: u32) -> u32 {
    (28..=31).rev().find(|d| NaiveDate::from_ymd_opt(y, m, *d).is_some()).unwrap_or(28)
}

/// What one renewal costs per month, for the monthly total.
pub fn monthly_cost(s: &Subscription) -> f64 {
    match s.cycle.as_str() {
        "weekly" => s.amount * 52.0 / 12.0,
        "yearly" => s.amount / 12.0,
        _ => s.amount,
    }
}

pub fn money(amount: f64, currency: &str) -> String {
    let sym = match currency {
        "USD" => "$",
        "EUR" => "€",
        "GBP" => "£",
        "JPY" => "¥",
        "CAD" => "CA$",
        "AUD" => "A$",
        "INR" => "₹",
        _ => "",
    };
    if sym.is_empty() {
        format!("{amount:.2} {currency}")
    } else {
        format!("{sym}{amount:.2}")
    }
}

fn row(r: &rusqlite::Row) -> rusqlite::Result<Subscription> {
    Ok(Subscription {
        id: r.get(0)?,
        name: r.get(1)?,
        amount: r.get(2)?,
        currency: r.get(3)?,
        cycle: r.get(4)?,
        next_renewal: r.get(5)?,
        manage_url: r.get(6)?,
        created_at: r.get(7)?,
    })
}
const COLS: &str = "id, name, amount, currency, cycle, next_renewal, manage_url, created_at";

pub fn list(core: &Core) -> Result<Vec<Subscription>> {
    let conn = core.db.conn();
    let mut st = conn.prepare(&format!("SELECT {COLS} FROM subscriptions ORDER BY next_renewal, name"))?;
    let rows = st.query_map([], row)?.collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn get(core: &Core, id: &str) -> Result<Subscription> {
    core.db
        .conn()
        .query_row(&format!("SELECT {COLS} FROM subscriptions WHERE id = ?1"), [id], row)
        .map_err(|_| LumoError::NotFound("subscription".into()))
}

/// Add or update. A subscription with the same name (ignoring case) is updated rather than duplicated.
pub fn save(core: &Core, id: Option<&str>, i: &SubscriptionInput) -> Result<Subscription> {
    let date = validate(i)?;
    let existing: Option<String> = match id {
        Some(id) => Some(get(core, id)?.id),
        None => core.db.conn().query_row("SELECT id FROM subscriptions WHERE lower(name) = lower(?1)", [i.name.trim()], |r| r.get(0)).ok(),
    };
    let count: i64 = core.db.conn().query_row("SELECT count(*) FROM subscriptions", [], |r| r.get(0))?;
    if existing.is_none() && count >= 300 {
        return Err(invalid("you're tracking 300 bills already; remove some first"));
    }
    let id = existing.unwrap_or_else(new_id);
    let t = now();
    core.db.conn().execute(
        "INSERT INTO subscriptions(id, name, amount, currency, cycle, next_renewal, manage_url, warned_for, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, ?8)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, amount = excluded.amount, currency = excluded.currency, cycle = excluded.cycle,
         next_renewal = excluded.next_renewal, manage_url = excluded.manage_url, updated_at = excluded.updated_at,
         warned_for = CASE WHEN subscriptions.next_renewal = excluded.next_renewal THEN subscriptions.warned_for ELSE NULL END",
        rusqlite::params![
            id,
            i.name.trim(),
            (i.amount * 100.0).round() / 100.0,
            i.currency.trim().to_ascii_uppercase(),
            i.cycle,
            date.format("%Y-%m-%d").to_string(),
            i.manage_url,
            t
        ],
    )?;
    core.platform.broadcast("everyday-changed", serde_json::json!({"kind": "bills"}));
    get(core, &id)
}

pub fn delete(core: &Core, id: &str) -> Result<()> {
    let n = core.db.conn().execute("DELETE FROM subscriptions WHERE id = ?1", [id])?;
    if n == 0 {
        return Err(LumoError::NotFound("subscription".into()));
    }
    core.platform.broadcast("everyday-changed", serde_json::json!({"kind": "bills"}));
    Ok(())
}

/// Roll past renewals forward and warn once about each renewal within `WARN_DAYS`. Returns the
/// subscriptions warned about.
pub fn check_renewals(core: &Core, today: NaiveDate) -> Result<Vec<Subscription>> {
    let mut warned = Vec::new();
    for s in list(core)? {
        let Ok(mut next) = NaiveDate::parse_from_str(&s.next_renewal, "%Y-%m-%d") else { continue };
        let anchor = next.day();
        let mut rolled = false;
        while next < today {
            next = advance(next, &s.cycle, anchor);
            rolled = true;
        }
        if rolled {
            core.db.conn().execute(
                "UPDATE subscriptions SET next_renewal = ?2, warned_for = NULL, updated_at = ?3 WHERE id = ?1",
                rusqlite::params![s.id, next.format("%Y-%m-%d").to_string(), now()],
            )?;
        }
        let days = (next - today).num_days();
        let warned_for: Option<String> =
            core.db.conn().query_row("SELECT warned_for FROM subscriptions WHERE id = ?1", [&s.id], |r| r.get(0)).ok().flatten();
        let key = next.format("%Y-%m-%d").to_string();
        if days <= WARN_DAYS && warned_for.as_deref() != Some(key.as_str()) {
            core.db.conn().execute("UPDATE subscriptions SET warned_for = ?2 WHERE id = ?1", rusqlite::params![s.id, key])?;
            let s = Subscription { next_renewal: key, ..s };
            super::alert(core, "bill", &format!("{} renews {}", s.name, when_words(days)), &warning_body(&s, days), Some(&s.id));
            warned.push(s);
        }
    }
    if !warned.is_empty() {
        core.platform.broadcast("everyday-changed", serde_json::json!({"kind": "bills"}));
    }
    Ok(warned)
}

pub fn when_words(days: i64) -> String {
    match days {
        ..=0 => "today".into(),
        1 => "tomorrow".into(),
        n => format!("in {n} days"),
    }
}

fn warning_body(s: &Subscription, days: i64) -> String {
    let mut b = format!("{} will be charged {}.", money(s.amount, &s.currency), when_words(days));
    if s.manage_url.is_some() {
        b.push_str(" Open Lumo to manage or cancel it.");
    } else {
        b.push_str(" Cancel before then if you don't need it.");
    }
    b
}

// ---- Finding recurring charges in a statement ------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Recurring {
    pub name: String,
    pub amount: f64,
    pub cycle: String,
    pub times_seen: usize,
    pub last_charged: String,
    pub next_expected: String,
}

/// Split one CSV line, honoring quotes.
fn csv_fields(line: &str, delim: char) -> Vec<String> {
    let mut out = Vec::new();
    let (mut cur, mut quoted, mut chars) = (String::new(), false, line.chars().peekable());
    while let Some(c) = chars.next() {
        match c {
            '"' if quoted && chars.peek() == Some(&'"') => {
                cur.push('"');
                chars.next();
            }
            '"' => quoted = !quoted,
            c if c == delim && !quoted => out.push(std::mem::take(&mut cur).trim().to_string()),
            c => cur.push(c),
        }
    }
    out.push(cur.trim().to_string());
    out
}

fn parse_amount(s: &str) -> Option<f64> {
    let neg = s.contains('-') || (s.contains('(') && s.contains(')'));
    let digits: String = s.chars().filter(|c| c.is_ascii_digit() || *c == '.' || *c == ',').collect();
    if digits.is_empty() {
        return None;
    }
    // "1.234,56" (European) vs "1,234.56".
    let normalized = match (digits.rfind(','), digits.rfind('.')) {
        (Some(c), Some(d)) if c > d => digits.replace('.', "").replace(',', "."),
        (Some(c), None) if digits.len() - c == 3 => digits.replace(',', "."),
        _ => digits.replace(',', ""),
    };
    let v: f64 = normalized.parse().ok()?;
    Some(if neg { -v } else { v })
}

fn parse_date_any(s: &str, day_first: bool) -> Option<NaiveDate> {
    let s = s.trim().trim_matches('"');
    let s = s.split(['T', ' ']).next().filter(|p| p.len() >= 8).unwrap_or(s);
    for f in ["%Y-%m-%d", "%Y/%m/%d", "%Y%m%d"] {
        if let Ok(d) = NaiveDate::parse_from_str(s, f) {
            return Some(d);
        }
    }
    let order: &[&str] = if day_first { &["%d/%m/%Y", "%d/%m/%y", "%d.%m.%Y", "%d-%m-%Y"] } else { &["%m/%d/%Y", "%m/%d/%y", "%m-%d-%Y"] };
    for f in order {
        if let Ok(d) = NaiveDate::parse_from_str(s, f) {
            return Some(d);
        }
    }
    for f in ["%b %d, %Y", "%d %b %Y", "%B %d, %Y", "%d %B %Y"] {
        if let Ok(d) = NaiveDate::parse_from_str(s, f) {
            return Some(d);
        }
    }
    None
}

/// A merchant name without card numbers, dates and payment-processor noise, so "NETFLIX.COM 8443"
/// and "Netflix.com 1203" group together.
pub fn merchant_key(desc: &str) -> String {
    let lower = desc.to_lowercase();
    let mut s = lower.as_str();
    for p in [
        "pos purchase",
        "pos debit",
        "debit card purchase",
        "card purchase",
        "recurring payment",
        "purchase",
        "ach debit",
        "ach",
        "pos",
        "sq *",
        "sq*",
        "tst*",
        "paypal *",
        "pp*",
    ] {
        if let Some(rest) = s.trim_start().strip_prefix(p) {
            s = rest;
        }
    }
    let words: Vec<String> = s
        .split(|c: char| !c.is_alphanumeric() && c != '.' && c != '&')
        .map(|w| w.trim_matches('.'))
        .filter(|w| !w.is_empty() && !w.chars().any(|c| c.is_ascii_digit()))
        .take(3)
        .map(String::from)
        .collect();
    words.join(" ")
}

fn title_case(s: &str) -> String {
    s.split(' ')
        .map(|w| {
            let mut c = w.chars();
            c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Find charges that repeat weekly, monthly or yearly in a bank or card statement exported as CSV.
/// Only rows with a date, a description and an amount are used; everything else is ignored.
pub fn find_recurring_in_csv(text: &str) -> Result<Vec<Recurring>> {
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).take(50_001).collect();
    let header_at = lines
        .iter()
        .take(20)
        .position(|l| {
            let l = l.to_lowercase();
            l.contains("date") && (l.contains("amount") || l.contains("debit") || l.contains("withdrawal"))
        })
        .ok_or_else(|| invalid("this doesn't look like a statement: Lumo needs a header row with a date and an amount column"))?;
    let delim = if lines[header_at].matches(';').count() > lines[header_at].matches(',').count() { ';' } else { ',' };
    let header: Vec<String> = csv_fields(lines[header_at], delim).iter().map(|h| h.to_lowercase()).collect();
    let find = |keys: &[&str]| keys.iter().find_map(|k| header.iter().position(|h| h.contains(k)));
    let date_col = find(&["transaction date", "posted date", "posting date", "date"]).ok_or_else(|| invalid("no date column"))?;
    let desc_col = find(&["description", "payee", "merchant", "name", "details", "memo", "narrative"])
        .ok_or_else(|| invalid("no description column"))?;
    let amount_col = find(&["amount"]);
    let debit_col = find(&["debit", "withdrawal", "paid out"]);

    let rows: Vec<Vec<String>> = lines[header_at + 1..].iter().map(|l| csv_fields(l, delim)).collect();
    // Day-first dates (31/01/2026) if any first part is above 12.
    let day_first = rows.iter().filter_map(|r| r.get(date_col)).any(|d| {
        let p: Vec<&str> = d.split(['/', '.', '-']).collect();
        p.len() == 3 && p[0].len() <= 2 && p[0].parse::<u32>().map(|n| n > 12).unwrap_or(false)
    });
    let mut charges: Vec<(NaiveDate, String, f64)> = Vec::new();
    for r in &rows {
        let (Some(d), Some(desc)) = (r.get(date_col).and_then(|d| parse_date_any(d, day_first)), r.get(desc_col)) else { continue };
        let amt = match (
            debit_col.and_then(|c| r.get(c)).and_then(|v| parse_amount(v)),
            amount_col.and_then(|c| r.get(c)).and_then(|v| parse_amount(v)),
        ) {
            (Some(debit), _) if debit != 0.0 => -debit.abs(),
            (_, Some(a)) => a,
            _ => continue,
        };
        charges.push((d, desc.clone(), amt));
    }
    if charges.is_empty() {
        return Err(invalid("no transactions with a date and an amount were found in this file"));
    }
    // Money out is negative in most bank exports; card exports often list charges as positive.
    let negatives = charges.iter().filter(|c| c.2 < 0.0).count();
    let out_is_negative = negatives * 5 >= charges.len();
    let mut groups: HashMap<String, Vec<(NaiveDate, f64, String)>> = HashMap::new();
    for (d, desc, a) in charges {
        let spent = if out_is_negative { -a } else { a };
        if spent <= 0.0 {
            continue;
        }
        let key = merchant_key(&desc);
        if key.len() >= 3 {
            groups.entry(key).or_default().push((d, spent, desc));
        }
    }
    let mut found = Vec::new();
    for (key, mut items) in groups {
        items.sort_by_key(|i| i.0);
        // The charges that match the latest amount (within 10%): a price change starts a new run.
        let last_amount = items.last().map(|i| i.1).unwrap_or(0.0);
        let same: Vec<&(NaiveDate, f64, String)> = items.iter().filter(|i| (i.1 - last_amount).abs() <= last_amount * 0.1 + 0.01).collect();
        if same.len() < 2 {
            continue;
        }
        let mut gaps: Vec<i64> = same.windows(2).map(|w| (w[1].0 - w[0].0).num_days()).filter(|g| *g > 0).collect();
        if gaps.is_empty() {
            continue;
        }
        gaps.sort();
        let median = gaps[gaps.len() / 2];
        let consistent = gaps.iter().filter(|g| (**g - median).abs() <= 4).count() * 4 >= gaps.len() * 3;
        let cycle = match median {
            6..=8 if same.len() >= 3 => "weekly",
            26..=35 => "monthly",
            355..=375 => "yearly",
            _ => continue,
        };
        if !consistent {
            continue;
        }
        let last = same.last().unwrap();
        let next = advance(last.0, cycle, last.0.day());
        found.push(Recurring {
            name: title_case(&key),
            amount: (last.1 * 100.0).round() / 100.0,
            cycle: cycle.into(),
            times_seen: same.len(),
            last_charged: last.0.format("%Y-%m-%d").to_string(),
            next_expected: next.format("%Y-%m-%d").to_string(),
        });
    }
    found.sort_by(|a, b| b.amount.partial_cmp(&a.amount).unwrap_or(std::cmp::Ordering::Equal));
    Ok(found)
}

/// Local date of today.
pub fn today() -> NaiveDate {
    Local::now().date_naive()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::testing::{core_with, FakePlatform};
    use std::sync::Arc;

    fn d(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn statements_reveal_subscriptions_but_not_one_off_shopping() {
        let csv = "Bank export\n\
Date,Description,Amount,Balance\n\
08/03/2026,NETFLIX.COM 866-579-7172,-15.49,1000\n\
09/03/2026,NETFLIX.COM 866-579-7172,-15.49,900\n\
10/03/2026,NETFLIX.COM 866-579-7172,-15.49,800\n\
08/14/2026,\"Spotify USA, Inc\",-11.99,700\n\
09/14/2026,\"Spotify USA, Inc\",-11.99,600\n\
10/14/2026,\"Spotify USA, Inc\",-11.99,500\n\
09/20/2026,WHOLE FOODS #123,-84.20,400\n\
10/02/2026,WHOLE FOODS #123,-12.10,300\n\
10/01/2026,PAYROLL ACME,2500.00,2800\n\
09/01/2026,PAYROLL ACME,2500.00,2800\n";
        let found = find_recurring_in_csv(csv).unwrap();
        let names: Vec<&str> = found.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, vec!["Netflix.com", "Spotify Usa Inc"], "{found:?}");
        assert_eq!(found[0].amount, 15.49);
        assert_eq!(found[0].cycle, "monthly");
        assert_eq!(found[0].next_expected, "2026-11-03");
        assert_eq!(found[0].times_seen, 3);
    }

    #[test]
    fn card_exports_with_positive_charges_and_day_first_dates_work() {
        let csv = "Transaction Date;Merchant;Debit;Credit\n\
15/07/2025;ICLOUD STORAGE;2,99;\n\
15/07/2026;ICLOUD STORAGE;2,99;\n\
31/08/2026;GYM CLUB;30,00;\n\
30/09/2026;GYM CLUB;30,00;\n";
        let found = find_recurring_in_csv(csv).unwrap();
        let gym = found.iter().find(|f| f.name == "Gym Club").unwrap();
        assert_eq!((gym.cycle.as_str(), gym.amount, gym.next_expected.as_str()), ("monthly", 30.0, "2026-10-30"));
        let icloud = found.iter().find(|f| f.name == "Icloud Storage").unwrap();
        assert_eq!(icloud.cycle, "yearly");
        assert!(find_recurring_in_csv("just,some,text\n1,2,3").is_err());
    }

    #[test]
    fn renewals_roll_forward_and_warn_once() {
        let platform = Arc::new(FakePlatform::default());
        let (core, _d) = core_with(platform.clone());
        let input = |name: &str, date: &str| SubscriptionInput {
            name: name.into(),
            amount: 15.49,
            currency: "usd".into(),
            cycle: "monthly".into(),
            next_renewal: date.into(),
            manage_url: Some("https://www.netflix.com/cancelplan".into()),
        };
        let n = save(&core, None, &input("Netflix", "2026-10-18")).unwrap();
        assert_eq!(n.currency, "USD");
        // Same name (any case) updates instead of duplicating.
        assert_eq!(save(&core, None, &input("netflix", "2026-10-18")).unwrap().id, n.id);
        save(&core, None, &input("Netflix", "2026-10-18")).unwrap();
        save(&core, None, &input("Gym", "2026-01-31")).unwrap();
        assert_eq!(list(&core).unwrap().len(), 2);

        let warned = check_renewals(&core, d("2026-10-16")).unwrap();
        assert_eq!(warned.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), vec!["Netflix"]);
        let note = platform.notifications.lock().last().cloned().unwrap();
        assert_eq!(note.0, "Netflix renews in 2 days");
        assert!(note.1.starts_with("$15.49 will be charged in 2 days."), "{note:?}");
        // The gym's January date rolled forward to the next 31st-or-last-day after today.
        let gym = list(&core).unwrap().into_iter().find(|s| s.name == "Gym").unwrap();
        assert_eq!(gym.next_renewal, "2026-10-31");
        // No second warning for the same renewal.
        assert!(check_renewals(&core, d("2026-10-17")).unwrap().is_empty());
        // After it renews, the next one is a month later and warns again in time.
        assert!(check_renewals(&core, d("2026-10-19")).unwrap().is_empty());
        assert_eq!(get(&core, &n.id).unwrap().next_renewal, "2026-11-18");
        assert_eq!(check_renewals(&core, d("2026-11-15")).unwrap().len(), 1);

        for bad in [
            SubscriptionInput { amount: -1.0, ..input("x", "2026-10-18") },
            SubscriptionInput { currency: "dollars".into(), ..input("x", "2026-10-18") },
            SubscriptionInput { cycle: "daily".into(), ..input("x", "2026-10-18") },
            SubscriptionInput { manage_url: Some("javascript:alert(1)".into()), ..input("x", "2026-10-18") },
            input("x", "18/10/2026"),
        ] {
            assert!(save(&core, None, &bad).is_err());
        }
    }

    #[test]
    fn cycles_advance_and_costs_add_up() {
        assert_eq!(advance(d("2026-01-31"), "monthly", 31), d("2026-02-28"));
        assert_eq!(advance(d("2026-02-28"), "monthly", 31), d("2026-03-31"));
        assert_eq!(advance(d("2024-02-29"), "yearly", 29), d("2025-02-28"));
        assert_eq!(advance(d("2026-10-16"), "weekly", 16), d("2026-10-23"));
        assert_eq!(money(9.5, "USD"), "$9.50");
        assert_eq!(money(9.5, "CHF"), "9.50 CHF");
        assert_eq!(merchant_key("POS PURCHASE NETFLIX.COM 8443 CA"), "netflix.com ca");
        assert_eq!(parse_amount("(1,234.50)"), Some(-1234.5));
        assert_eq!(parse_amount("1.234,50"), Some(1234.5));
    }
}
