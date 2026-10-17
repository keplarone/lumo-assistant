//! Today's weather for the saved location, from MET Norway's free forecast API (api.met.no). Its data
//! is CC BY 4.0, which allows commercial use with attribution, and it needs no key. Only the
//! location's coordinates (rounded to about 100 m) are sent.

use crate::core::Core;
use crate::error::{LumoError, Result};
use chrono::{DateTime, Local, NaiveDate, Utc};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

pub const ATTRIBUTION: &str = "Weather data from MET Norway";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Weather {
    pub place: String,
    pub unit: String,
    pub now_temp: Option<i32>,
    pub now_sky: Option<String>,
    pub high: Option<i32>,
    pub low: Option<i32>,
    /// The day's main conditions, e.g. "light rain".
    pub day_sky: Option<String>,
    /// Total expected precipitation in mm for the rest of the day.
    pub rain_mm: f64,
    /// When rain is expected, the local hour it starts ("3 PM").
    pub rain_from: Option<String>,
}

/// Fahrenheit inside rough boxes around the United States, Celsius elsewhere. A rough guess for the
/// "auto" setting; the user can pick either unit in Settings.
pub fn default_unit(lat: f64, lon: f64) -> &'static str {
    let in_box = |la: (f64, f64), lo: (f64, f64)| (la.0..=la.1).contains(&lat) && (lo.0..=lo.1).contains(&lon);
    if in_box((24.0, 49.5), (-125.0, -66.5)) || in_box((51.0, 71.5), (-170.0, -129.0)) || in_box((18.5, 22.5), (-161.0, -154.0)) {
        "fahrenheit"
    } else {
        "celsius"
    }
}

/// "partlycloudy_day" → "partly cloudy", "lightrainshowersandthunder" → "light rain showers and thunder".
pub fn sky_words(symbol: &str) -> String {
    let base = symbol.split('_').next().unwrap_or(symbol);
    match base {
        "clearsky" => return "clear".into(),
        "fair" => return "mostly clear".into(),
        "partlycloudy" => return "partly cloudy".into(),
        "fog" => return "foggy".into(),
        _ => {}
    }
    let mut s = base.to_string();
    for (from, to) in [
        ("andthunder", " and thunder"),
        ("showers", " showers"),
        ("lightssleet", "light sleet"),
        ("lightssnow", "light snow"),
        ("light", "light "),
        ("heavy", "heavy "),
    ] {
        s = s.replace(from, to);
    }
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn severity(symbol: &str) -> u8 {
    let s = symbol.split('_').next().unwrap_or(symbol);
    if s.contains("thunder") {
        6
    } else if s.contains("snow") || s.contains("sleet") {
        5
    } else if s.contains("rain") {
        if s.starts_with("heavy") {
            4
        } else if s.starts_with("light") {
            2
        } else {
            3
        }
    } else if s == "fog" || s == "cloudy" {
        1
    } else {
        0
    }
}

fn convert(c: f64, unit: &str) -> i32 {
    if unit == "fahrenheit" {
        (c * 9.0 / 5.0 + 32.0).round() as i32
    } else {
        c.round() as i32
    }
}

/// Summarize a MET Norway "compact" forecast for one local day, from `now` on.
pub fn summarize(v: &Value, place: &str, unit: &str, day: NaiveDate, now: DateTime<Utc>) -> Result<Weather> {
    let series =
        v["properties"]["timeseries"].as_array().ok_or_else(|| LumoError::Unavailable("the weather service sent no forecast".into()))?;
    let mut w = Weather {
        place: place.to_string(),
        unit: unit.to_string(),
        now_temp: None,
        now_sky: None,
        high: None,
        low: None,
        day_sky: None,
        rain_mm: 0.0,
        rain_from: None,
    };
    let (mut hi, mut lo) = (f64::MIN, f64::MAX);
    let mut worst: Option<(u8, String)> = None;
    for entry in series {
        let Some(t) = entry["time"].as_str().and_then(|t| DateTime::parse_from_rfc3339(t).ok()) else { continue };
        let t = t.with_timezone(&Utc);
        let local = t.with_timezone(&Local);
        let data = &entry["data"];
        let temp = data["instant"]["details"]["air_temperature"].as_f64();
        if w.now_temp.is_none() && t + chrono::Duration::minutes(59) >= now {
            w.now_temp = temp.map(|c| convert(c, unit));
            w.now_sky = data["next_1_hours"]["summary"]["symbol_code"].as_str().map(sky_words);
        }
        if local.date_naive() != day {
            continue;
        }
        if let Some(c) = temp {
            hi = hi.max(c);
            lo = lo.min(c);
        }
        if t + chrono::Duration::minutes(59) < now {
            continue;
        }
        if let Some(rain) = data["next_1_hours"]["details"]["precipitation_amount"].as_f64() {
            w.rain_mm += rain;
            if rain >= 0.2 && w.rain_from.is_none() {
                w.rain_from = Some(local.format("%-I %p").to_string());
            }
        }
        let hour = local.format("%H").to_string().parse::<u32>().unwrap_or(12);
        if (7..=21).contains(&hour) {
            if let Some(sym) = data["next_1_hours"]["summary"]["symbol_code"].as_str() {
                let sev = severity(sym);
                if worst.as_ref().map(|(s, _)| sev > *s).unwrap_or(true) {
                    worst = Some((sev, sky_words(sym)));
                }
            }
        }
    }
    if hi > f64::MIN {
        w.high = Some(convert(hi, unit));
        w.low = Some(convert(lo, unit));
    }
    w.day_sky = worst.map(|(_, s)| s);
    w.rain_mm = (w.rain_mm * 10.0).round() / 10.0;
    Ok(w)
}

/// Forecasts are cached for 30 minutes per location, as MET Norway asks clients to.
type Cache = HashMap<String, (DateTime<Utc>, Value)>;
static CACHE: Mutex<Option<Cache>> = Mutex::new(None);

/// Today's weather at the saved location.
pub async fn today(core: &Core) -> Result<Weather> {
    let loc = core.settings().location.ok_or_else(|| {
        LumoError::Unavailable("No location is set, so Lumo can't check the weather. Set one in Settings → General.".into())
    })?;
    // MET Norway asks for at most four decimals; three is ~100 m and plenty for a forecast.
    let (lat, lon) = ((loc.lat * 1000.0).round() / 1000.0, (loc.lon * 1000.0).round() / 1000.0);
    let base = core.endpoints.lock().met_no.clone();
    let key = format!("{base}|{lat}|{lon}");
    let cached = CACHE
        .lock()
        .as_ref()
        .and_then(|c| c.get(&key))
        .filter(|(at, _)| Utc::now() - *at < chrono::Duration::minutes(30))
        .map(|(_, v)| v.clone());
    let v = match cached {
        Some(v) => v,
        None => {
            let v: Value = core
                .http
                .get(format!("{base}/weatherapi/locationforecast/2.0/compact"))
                .query(&[("lat", lat.to_string()), ("lon", lon.to_string())])
                .timeout(std::time::Duration::from_secs(20))
                .send()
                .await
                .map_err(|e| LumoError::Unavailable(format!("The weather service is unreachable right now ({e})")))?
                .error_for_status()
                .map_err(|e| LumoError::Unavailable(format!("The weather service is unavailable right now ({e})")))?
                .json()
                .await?;
            CACHE.lock().get_or_insert_with(HashMap::new).insert(key, (Utc::now(), v.clone()));
            v
        }
    };
    let unit = match core.settings().temperature_unit.as_str() {
        "celsius" => "celsius",
        "fahrenheit" => "fahrenheit",
        _ => default_unit(loc.lat, loc.lon),
    };
    summarize(&v, &loc.label, unit, Local::now().date_naive(), Utc::now())
}

/// One friendly sentence: "It's 54°F and partly cloudy in Brooklyn, with a high of 61° and a low of
/// 49°. Light rain from about 3 PM, so take an umbrella."
pub fn sentence(w: &Weather) -> String {
    let deg = if w.unit == "fahrenheit" { "°F" } else { "°C" };
    let place = w.place.split(',').next().unwrap_or(&w.place).trim();
    let mut s = match (w.now_temp, &w.now_sky) {
        (Some(t), Some(sky)) => format!("It's {t}{deg} and {sky} in {place}"),
        (Some(t), None) => format!("It's {t}{deg} in {place}"),
        _ => format!("Here's the weather in {place}"),
    };
    if let (Some(h), Some(l)) = (w.high, w.low) {
        s.push_str(&format!(", with a high of {h}° and a low of {l}°"));
    }
    s.push('.');
    if let Some(from) = &w.rain_from {
        let what =
            w.day_sky.as_deref().filter(|d| d.contains("rain") || d.contains("snow") || d.contains("sleet") || d.contains("thunder"));
        s.push_str(&format!(" {} from about {from}, so take an umbrella.", capitalize(what.unwrap_or("rain"))));
    } else if let Some(d) = &w.day_sky {
        if Some(d) != w.now_sky.as_ref() {
            s.push_str(&format!(" Later it turns {d}."));
        }
    }
    s
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use serde_json::json;

    fn entry(t: DateTime<Utc>, c: f64, sym: &str, rain: f64) -> Value {
        json!({"time": t.to_rfc3339(), "data": {
            "instant": {"details": {"air_temperature": c}},
            "next_1_hours": {"summary": {"symbol_code": sym}, "details": {"precipitation_amount": rain}}
        }})
    }

    #[test]
    fn a_forecast_becomes_a_friendly_sentence() {
        let day = Local::now().date_naive();
        let start = Local.from_local_datetime(&day.and_hms_opt(8, 0, 0).unwrap()).earliest().unwrap().with_timezone(&Utc);
        let series: Vec<Value> = (0..12)
            .map(|h| {
                let t = start + chrono::Duration::hours(h);
                let (sym, rain) = if h >= 7 { ("lightrain", 0.4) } else { ("partlycloudy_day", 0.0) };
                entry(t, 10.0 + h as f64 * 0.5, sym, rain)
            })
            .collect();
        let v = json!({"properties": {"timeseries": series}});
        let w = summarize(&v, "Brooklyn, New York", "celsius", day, start).unwrap();
        assert_eq!(w.now_temp, Some(10));
        assert_eq!(w.now_sky.as_deref(), Some("partly cloudy"));
        assert_eq!((w.high, w.low), (Some(16), Some(10)));
        assert_eq!(w.day_sky.as_deref(), Some("light rain"));
        assert!(w.rain_mm > 1.9 && w.rain_from.is_some());
        let s = sentence(&w);
        assert!(s.starts_with("It's 10°C and partly cloudy in Brooklyn, with a high of 16° and a low of 10°."), "{s}");
        assert!(s.contains("Light rain from about"), "{s}");
        let f = summarize(&v, "Brooklyn", "fahrenheit", day, start).unwrap();
        assert_eq!(f.now_temp, Some(50));
    }

    #[test]
    fn symbols_and_units_read_naturally() {
        assert_eq!(sky_words("clearsky_night"), "clear");
        assert_eq!(sky_words("lightrainshowers_day"), "light rain showers");
        assert_eq!(sky_words("heavyrainandthunder"), "heavy rain and thunder");
        assert_eq!(sky_words("cloudy"), "cloudy");
        assert_eq!(default_unit(40.68, -73.94), "fahrenheit");
        assert_eq!(default_unit(51.5, -0.12), "celsius");
        assert_eq!(default_unit(-33.87, 151.2), "celsius");
    }
}
