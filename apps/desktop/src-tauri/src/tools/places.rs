//! Real places from OpenStreetMap, and the checkout handoff for food and shopping.
//!
//! Lumo has no ordering or payment integration with any merchant (see docs/01-audit.md). What it can
//! do honestly: find real nearby places, compare them, and hand the user off to the merchant's own
//! site after they confirm exactly what they intend to order. It never claims an order was placed.

use super::{object_schema, ToolCtx, ToolOutput, TypedTool};
use crate::agent::events::ActionPreview;
use crate::error::{invalid, LumoError, Result};
use crate::policy::Risk;
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};

pub struct FindPlaces;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlacesInput {
    /// What to look for: a cuisine or kind of place ("pizza", "pharmacy") or a name.
    pub query: String,
    /// A place name or address to search around. Defaults to the user's saved location.
    #[serde(default)]
    pub near: Option<String>,
    #[serde(default)]
    pub radius_m: Option<u32>,
}

fn sanitize(q: &str) -> String {
    q.chars().filter(|c| c.is_alphanumeric() || *c == ' ' || *c == '-').collect::<String>().trim().to_string()
}

fn haversine_m(a: (f64, f64), b: (f64, f64)) -> f64 {
    let r = 6_371_000.0f64;
    let (la1, la2) = (a.0.to_radians(), b.0.to_radians());
    let dlat = la2 - la1;
    let dlon = (b.1 - a.1).to_radians();
    let h = (dlat / 2.0).sin().powi(2) + la1.cos() * la2.cos() * (dlon / 2.0).sin().powi(2);
    2.0 * r * h.sqrt().asin()
}

const KINDS: &str = "restaurant|fast_food|cafe|bar|pub|ice_cream|food_court|pharmacy|bakery";

#[async_trait]
impl TypedTool for FindPlaces {
    type Input = PlacesInput;
    const NAME: &'static str = "find_places";
    const DESCRIPTION: &'static str = "Find real restaurants, cafés, shops and other places near a location using OpenStreetMap. Returns names, cuisine, address, opening hours, website and distance where OpenStreetMap has them. It has no menus, prices, ratings, delivery times or availability, so never present those as known.";
    fn schema(&self) -> Value {
        object_schema(
            json!({"query": {"type": "string"}, "near": {"type": "string", "description": "City, neighborhood or address. Omit to use the user's saved location."},
                   "radius_m": {"type": "integer", "minimum": 200, "maximum": 20000}}),
            &["query"],
        )
    }
    fn risk(&self, _ctx: &ToolCtx, _: &PlacesInput) -> Risk {
        Risk::Read
    }
    fn label(&self, i: &PlacesInput) -> String {
        format!("Finding {} nearby", crate::util::preview(&i.query, 40))
    }
    async fn run(&self, ctx: &ToolCtx, i: PlacesInput) -> Result<ToolOutput> {
        let q = sanitize(&i.query);
        if q.is_empty() {
            return Err(invalid("say what kind of place to look for"));
        }
        let eps = ctx.core.endpoints.lock().clone();
        // Where to search.
        let (lat, lon, where_label) = match &i.near {
            Some(near) if !near.trim().is_empty() => {
                polite_wait(ctx).await;
                let r: Value = ctx
                    .core
                    .http
                    .get(format!("{}/search", eps.nominatim))
                    .query(&[("q", near.as_str()), ("format", "jsonv2"), ("limit", "1")])
                    .timeout(std::time::Duration::from_secs(15))
                    .send()
                    .await?
                    .error_for_status()?
                    .json()
                    .await?;
                let first = r.get(0).ok_or_else(|| LumoError::NotFound(format!("a place called {near}")))?;
                let lat: f64 = first["lat"].as_str().and_then(|s| s.parse().ok()).ok_or_else(|| invalid("bad geocoder response"))?;
                let lon: f64 = first["lon"].as_str().and_then(|s| s.parse().ok()).ok_or_else(|| invalid("bad geocoder response"))?;
                (lat, lon, first["display_name"].as_str().unwrap_or(near).to_string())
            }
            _ => match ctx.core.settings().location {
                Some(l) => (l.lat, l.lon, l.label),
                None => {
                    return Err(LumoError::Unavailable(
                        "No location is set. Ask the user where to search, or they can set a default location in Settings → General."
                            .into(),
                    ))
                }
            },
        };
        let radius = i.radius_m.unwrap_or(2500).clamp(200, 20_000);
        let query = format!(
            "[out:json][timeout:20];(nwr[\"amenity\"~\"{KINDS}\"][\"cuisine\"~\"{q}\",i](around:{radius},{lat},{lon});nwr[\"amenity\"~\"{KINDS}\"][\"name\"~\"{q}\",i](around:{radius},{lat},{lon});nwr[\"shop\"~\"{q}\",i](around:{radius},{lat},{lon});nwr[\"amenity\"~\"^{q}$\",i](around:{radius},{lat},{lon}););out center tags 60;"
        );
        let r: Value = ctx
            .core
            .http
            .post(&eps.overpass)
            .form(&[("data", query)])
            .timeout(std::time::Duration::from_secs(30))
            .send()
            .await?
            .error_for_status()
            .map_err(|e| LumoError::Unavailable(format!("OpenStreetMap search is unavailable right now ({e})")))?
            .json()
            .await?;
        let mut places: Vec<Value> = r["elements"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|e| {
                let t = &e["tags"];
                let name = t["name"].as_str()?.to_string();
                let plat = e["lat"].as_f64().or_else(|| e["center"]["lat"].as_f64())?;
                let plon = e["lon"].as_f64().or_else(|| e["center"]["lon"].as_f64())?;
                let addr = [t["addr:housenumber"].as_str(), t["addr:street"].as_str(), t["addr:city"].as_str()]
                    .iter()
                    .flatten()
                    .copied()
                    .collect::<Vec<_>>()
                    .join(" ");
                let kind = t["amenity"].as_str().or(t["shop"].as_str()).unwrap_or("place").replace('_', " ");
                Some(json!({
                    "name": name,
                    "kind": kind,
                    "cuisine": t["cuisine"].as_str().map(|c| c.replace(';', ", ").replace('_', " ")),
                    "address": if addr.is_empty() { Value::Null } else { json!(addr) },
                    "openingHours": t["opening_hours"],
                    "website": t["website"].as_str().or(t["contact:website"].as_str()),
                    "phone": t["phone"].as_str().or(t["contact:phone"].as_str()),
                    "delivery": t["delivery"].as_str(),
                    "takeaway": t["takeaway"].as_str(),
                    "distanceM": haversine_m((lat, lon), (plat, plon)).round(),
                    "osm": format!("https://www.openstreetmap.org/{}/{}", e["type"].as_str().unwrap_or("node"), e["id"]),
                }))
            })
            .collect();
        places.sort_by(|a, b| a["distanceM"].as_f64().partial_cmp(&b["distanceM"].as_f64()).unwrap_or(std::cmp::Ordering::Equal));
        places.dedup_by(|a, b| a["name"] == b["name"] && a["address"] == b["address"]);
        places.truncate(15);
        let n = places.len();
        let lines: Vec<String> = places
            .iter()
            .map(|p| {
                let mut s = format!("- {} ({}", p["name"].as_str().unwrap_or(""), p["kind"].as_str().unwrap_or(""));
                if let Some(c) = p["cuisine"].as_str() {
                    s.push_str(&format!(", {c}"));
                }
                s.push_str(&format!(", {} m away)", p["distanceM"]));
                if let Some(a) = p["address"].as_str() {
                    s.push_str(&format!(" {a}."));
                }
                if let Some(h) = p["openingHours"].as_str() {
                    s.push_str(&format!(" Hours: {h}."));
                }
                if let Some(w) = p["website"].as_str() {
                    s.push_str(&format!(" Website: {w}"));
                }
                s
            })
            .collect();
        let text = if n == 0 {
            format!("OpenStreetMap lists no matching places within {radius} m of {where_label}.")
        } else {
            format!("{n} places from OpenStreetMap within {radius} m of {where_label} (nearest first). OpenStreetMap does not have menus, prices, ratings or delivery times.\n{}", lines.join("\n"))
        };
        Ok(ToolOutput {
            // Place names and tags are written by the public, so they are untrusted.
            text: String::new(),
            untrusted: Some(text),
            summary: format!("Found {n} places near {}", crate::util::preview(&where_label, 40)),
            data: Some(json!({"places": places, "center": {"lat": lat, "lon": lon, "label": where_label}})),
            ..Default::default()
        })
    }
}

/// Nominatim's usage policy allows at most one request per second.
async fn polite_wait(ctx: &ToolCtx) {
    while ctx.core.rate.check("nominatim", 1, std::time::Duration::from_millis(1100)).is_err() {
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
}

pub struct PrepareCheckoutHandoff;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HandoffInput {
    pub merchant: String,
    /// The merchant's own https page where the user can order (from a tool result).
    pub merchant_url: String,
    pub items: Vec<HandoffItem>,
    #[serde(default)]
    pub delivery_address: Option<String>,
    /// The total exactly as the merchant stated it, if a tool result showed one.
    #[serde(default)]
    pub total: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HandoffItem {
    pub name: String,
    pub quantity: u32,
    #[serde(default)]
    pub price: Option<String>,
}

fn order_text(i: &HandoffInput) -> String {
    let mut s = format!("Order for {}\n", i.merchant);
    for it in &i.items {
        s.push_str(&format!("{} × {}{}\n", it.quantity, it.name, it.price.as_ref().map(|p| format!(" ({p})")).unwrap_or_default()));
    }
    if let Some(a) = &i.delivery_address {
        s.push_str(&format!("Deliver to: {a}\n"));
    }
    if let Some(n) = &i.notes {
        s.push_str(&format!("Notes: {n}\n"));
    }
    s
}

#[async_trait]
impl TypedTool for PrepareCheckoutHandoff {
    type Input = HandoffInput;
    const NAME: &'static str = "prepare_checkout_handoff";
    const DESCRIPTION: &'static str = "When the user wants to order food or buy something, show them exactly what they intend to order (merchant, items, quantities, delivery address and the total if the merchant stated one) in a system confirmation. If they confirm, Lumo copies the order list to the clipboard and opens the merchant's page so they can order and pay there themselves. Lumo cannot place orders or pay, and must say so; never claim an order was placed.";
    fn schema(&self) -> Value {
        object_schema(
            json!({
                "merchant": {"type": "string"},
                "merchant_url": {"type": "string"},
                "items": {"type": "array", "minItems": 1, "maxItems": 30, "items": object_schema(json!({
                    "name": {"type": "string"}, "quantity": {"type": "integer", "minimum": 1, "maximum": 99}, "price": {"type": "string"}
                }), &["name", "quantity"])},
                "delivery_address": {"type": "string"},
                "total": {"type": "string"},
                "notes": {"type": "string"}
            }),
            &["merchant", "merchant_url", "items"],
        )
    }
    fn risk(&self, _ctx: &ToolCtx, _: &HandoffInput) -> Risk {
        Risk::Sensitive
    }
    fn label(&self, i: &HandoffInput) -> String {
        format!("Preparing your order at {}", i.merchant)
    }
    fn preview(&self, _ctx: &ToolCtx, i: &HandoffInput) -> Result<ActionPreview> {
        let u = url::Url::parse(&i.merchant_url).map_err(|_| invalid("the merchant link is not valid"))?;
        if u.scheme() != "https" {
            return Err(invalid("the merchant link must use https"));
        }
        if i.items.is_empty() || i.items.iter().any(|it| it.quantity == 0 || it.quantity > 99) {
            return Err(invalid("each item needs a quantity from 1 to 99"));
        }
        let mut details = vec![("Merchant".to_string(), format!("{} ({})", i.merchant, u.host_str().unwrap_or("")))];
        for it in &i.items {
            details.push((
                format!("{} ×", it.quantity),
                format!("{}{}", it.name, it.price.as_ref().map(|p| format!(" — {p}")).unwrap_or_default()),
            ));
        }
        details.push((
            "Deliver to".into(),
            i.delivery_address.clone().unwrap_or_else(|| "Not set. You'll enter it on the merchant's site.".into()),
        ));
        details.push((
            "Total".into(),
            i.total.clone().unwrap_or_else(|| "Unknown until checkout. The merchant shows the final total, fees and tax.".into()),
        ));
        Ok(ActionPreview {
            title: format!("Continue to {} to place this order", i.merchant),
            details,
            warning: Some(
                "Lumo does not place orders or pay. If you continue, the list is copied to your clipboard and the merchant's site opens so you can order and pay there.".into(),
            ),
        })
    }
    async fn run(&self, ctx: &ToolCtx, i: HandoffInput) -> Result<ToolOutput> {
        let u = url::Url::parse(&i.merchant_url).map_err(|_| invalid("invalid link"))?;
        let text = order_text(&i);
        ctx.core.platform.clipboard_write(&text)?;
        ctx.core.platform.open_url(u.as_str())?;
        Ok(ToolOutput {
            text: format!(
                "The user confirmed. The order list was copied to their clipboard and {} opened in their browser. The order is NOT placed: the user must complete it and pay on the merchant's site. Lumo cannot see whether they did.",
                u.host_str().unwrap_or("the merchant's site")
            ),
            summary: format!("Opened {} to finish the order", i.merchant),
            data: Some(json!({"merchant": i.merchant, "url": u.as_str(), "status": "handed_off"})),
            ..Default::default()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::ctx;
    use super::super::{execute, Origin, Registry};
    use crate::core::testing::{core_with, FakePlatform};
    use serde_json::json;
    use std::sync::Arc;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn finds_places_from_openstreetmap_sorted_by_distance() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/search"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([
                {"lat": "40.7128", "lon": "-74.0060", "display_name": "Lower Manhattan, New York"}
            ])))
            .mount(&server)
            .await;
        Mock::given(method("POST")).and(path("/overpass")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"elements": [
            {"type": "node", "id": 2, "lat": 40.7228, "lon": -74.0060, "tags": {"name": "Far Pizza", "amenity": "restaurant", "cuisine": "pizza"}},
            {"type": "node", "id": 1, "lat": 40.7130, "lon": -74.0061, "tags": {"name": "Near Slice", "amenity": "fast_food", "cuisine": "pizza;italian", "opening_hours": "Mo-Su 11:00-23:00", "website": "https://nearslice.example"}},
            {"type": "node", "id": 3, "lat": 40.7, "lon": -74.0, "tags": {"amenity": "restaurant"}}
        ]}))).mount(&server).await;
        let (core, _d) = core_with(Arc::new(FakePlatform::default()));
        *core.endpoints.lock() = crate::core::Endpoints { nominatim: server.uri(), overpass: format!("{}/overpass", server.uri()) };
        let (ctx, _) = ctx(core, Origin::User);
        let r = Registry::standard();
        let names: Vec<String> = r.names().into_iter().map(String::from).collect();
        let res = execute(
            &r,
            &ctx,
            &json!({"type": "tool_use", "id": "p", "name": "find_places", "input": {"query": "pizza", "near": "Lower Manhattan"}}),
            &names,
        )
        .await;
        assert!(res.ok, "{}", res.block);
        let text = res.block.to_string();
        let near = text.find("Near Slice").unwrap();
        let far = text.find("Far Pizza").unwrap();
        assert!(near < far, "nearest first");
        assert!(text.contains("does not have menus, prices"));
    }

    #[tokio::test]
    async fn checkout_handoff_requires_confirmation_and_never_claims_an_order() {
        let platform = Arc::new(FakePlatform::default());
        let (core, _d) = core_with(platform.clone());
        let (ctx, _) = ctx(core, Origin::User);
        let r = Registry::standard();
        let names: Vec<String> = r.names().into_iter().map(String::from).collect();
        let call = json!({"type": "tool_use", "id": "h", "name": "prepare_checkout_handoff", "input": {
            "merchant": "Near Slice", "merchant_url": "https://nearslice.example/order",
            "items": [{"name": "Margherita pizza", "quantity": 2}], "delivery_address": "1 Main St"
        }});
        *platform.confirm.lock() = false;
        assert!(!execute(&r, &ctx, &call, &names).await.ok);
        assert!(platform.opened.lock().is_empty());
        let shown = platform.confirms.lock()[0].clone();
        assert!(shown.details.iter().any(|(k, v)| k == "2 ×" && v.contains("Margherita")));
        assert!(shown.details.iter().any(|(k, v)| k == "Total" && v.starts_with("Unknown")));
        *platform.confirm.lock() = true;
        let res = execute(&r, &ctx, &call, &names).await;
        assert!(res.ok);
        assert!(res.block.to_string().contains("NOT placed"));
        assert!(platform.clipboard.lock().contains("2 × Margherita pizza"));
    }
}
