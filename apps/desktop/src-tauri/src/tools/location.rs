//! Where the user is right now, from the operating system's location service.
//!
//! Sensitive tier: the user confirms in a native dialog every time, and automations can never use
//! it. The position is rounded to about 100 m (see `crate::location`); the model sees only the
//! neighborhood label. The detected location is kept for this conversation so `find_places` can search
//! around it, and saved as the default location when none is set yet.

use super::{object_schema, ToolCtx, ToolOutput, TypedTool};
use crate::agent::events::{ActionPreview, AgentEvent};
use crate::error::Result;
use crate::policy::Risk;
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};

pub struct GetCurrentLocation;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LocationInput {}

#[async_trait]
impl TypedTool for GetCurrentLocation {
    type Input = LocationInput;
    const NAME: &'static str = "get_current_location";
    const DESCRIPTION: &'static str = "Find out roughly where the user is right now (neighborhood and city, about 100 m) from their computer's location service. The user confirms in a system dialog each time. Use it when the user asks for something near them and no location is known; afterwards find_places searches around it when you omit near. Don't call it again in the same conversation unless the user says they moved.";
    fn schema(&self) -> Value {
        object_schema(json!({}), &[])
    }
    fn risk(&self, _ctx: &ToolCtx, _: &LocationInput) -> Risk {
        Risk::Sensitive
    }
    fn label(&self, _: &LocationInput) -> String {
        "Checking your location".into()
    }
    fn preview(&self, _ctx: &ToolCtx, _: &LocationInput) -> Result<ActionPreview> {
        Ok(crate::location::confirm_preview())
    }
    async fn run(&self, ctx: &ToolCtx, _: LocationInput) -> Result<ToolOutput> {
        ctx.sink.emit(AgentEvent::Privacy { kind: "location".into(), detail: "Lumo checked your location".into() });
        let loc = crate::location::detect(&ctx.core).await?;
        ctx.core.pending.current_locations.lock().insert(ctx.conversation_id.clone(), loc.clone());
        let mut s = ctx.core.settings();
        let saved = s.location.is_none();
        if saved {
            s.location = Some(loc.clone());
            crate::settings::save(&ctx.core.db, &s)?;
            ctx.core.platform.broadcast("settings-changed", json!(null));
        }
        let mut text = "Found the user's current location (rounded to about 100 m). Its name from OpenStreetMap is below. find_places now searches around it when you omit near.".to_string();
        if saved {
            text.push_str(" It was also saved as their default location (Settings → General).");
        }
        Ok(ToolOutput {
            text,
            // The label comes from OpenStreetMap, which the public edits.
            untrusted: Some(format!("Current location: {}", loc.label)),
            summary: format!("You're near {}", crate::util::preview(&loc.label, 50)),
            data: Some(json!({"location": loc, "savedAsDefault": saved})),
            ..Default::default()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::ctx;
    use super::super::{execute, Origin, Registry};
    use crate::agent::events::AgentEvent;
    use crate::core::testing::{core_with, FakePlatform};
    use crate::location::{Fix, FixError};
    use serde_json::json;
    use std::sync::Arc;
    use wiremock::matchers::{method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn call(id: &str) -> serde_json::Value {
        json!({"type": "tool_use", "id": id, "name": "get_current_location", "input": {}})
    }

    async fn nominatim() -> MockServer {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/reverse"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"address": {
                "road": "Valencia Street", "neighbourhood": "Mission District", "city": "San Francisco"
            }})))
            .mount(&server)
            .await;
        server
    }

    #[tokio::test]
    async fn needs_native_confirmation_then_saves_a_rounded_default() {
        let server = nominatim().await;
        let platform = Arc::new(FakePlatform::default());
        *platform.position.lock() = Some(Ok(Fix { lat: 37.759_94, lon: -122.414_83, accuracy_m: Some(20.0) }));
        let (core, _d) = core_with(platform.clone());
        core.endpoints.lock().nominatim = server.uri();
        let (ctx, events) = ctx(core.clone(), Origin::User);
        let r = Registry::standard();
        let names: Vec<String> = r.names().into_iter().map(String::from).collect();

        // Declined: the OS location service is never asked.
        *platform.confirm.lock() = false;
        assert!(!execute(&r, &ctx, &call("l1"), &names).await.ok);
        assert_eq!(*platform.position_requests.lock(), 0);
        assert_eq!(platform.confirms.lock()[0].title, "Let Lumo use your current location?");

        *platform.confirm.lock() = true;
        let res = execute(&r, &ctx, &call("l2"), &names).await;
        assert!(res.ok, "{}", res.block);
        let text = res.block.to_string();
        assert!(text.contains("Mission District, San Francisco"));
        assert!(text.contains("saved as their default"));
        // Only the rounded position is kept, and never the street.
        let saved = core.settings().location.unwrap();
        assert_eq!((saved.lat, saved.lon), (37.76, -122.415));
        assert!(!saved.label.contains("Valencia"));
        assert!(!text.contains("37.759") && !text.contains("Valencia"));
        assert!(core.pending.current_locations.lock().contains_key(&ctx.conversation_id));
        assert!(events.0.lock().iter().any(|e| matches!(e, AgentEvent::Privacy { kind, .. } if kind == "location")));

        // An existing default is left alone.
        let mut s = core.settings();
        s.location = Some(crate::settings::Location { label: "Home".into(), lat: 1.0, lon: 2.0 });
        crate::settings::save(&core.db, &s).unwrap();
        let res = execute(&r, &ctx, &call("l3"), &names).await;
        assert!(res.ok);
        assert!(!res.block.to_string().contains("saved as their default"));
        assert_eq!(core.settings().location.unwrap().label, "Home");
    }

    #[tokio::test]
    async fn is_refused_in_automations_and_reports_os_errors_plainly() {
        let platform = Arc::new(FakePlatform::default());
        *platform.confirm.lock() = true;
        *platform.position.lock() = Some(Err(FixError::Denied));
        let (core, _d) = core_with(platform.clone());
        let r = Registry::standard();
        let names: Vec<String> = r.names().into_iter().map(String::from).collect();

        let (auto, _) = ctx(core.clone(), Origin::Automation);
        let res = execute(&r, &auto, &call("a1"), &names).await;
        assert!(!res.ok && res.needs_attention);
        assert_eq!(*platform.position_requests.lock(), 0);

        let (user, _) = ctx(core.clone(), Origin::User);
        let res = execute(&r, &user, &call("u1"), &names).await;
        assert!(!res.ok);
        assert!(res.block.to_string().contains("isn't allowed to use your location"));
        assert!(core.settings().location.is_none());

        *platform.position.lock() = None;
        let res = execute(&r, &user, &call("u2"), &names).await;
        assert!(res.block.to_string().contains("Location services aren't available on this computer"));
    }

    #[tokio::test]
    async fn find_places_searches_around_the_detected_location() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/reverse"))
            .and(query_param("lat", "51.501"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"address": {"suburb": "Westminster", "city": "London"}})))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/overpass"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"elements": [
                {"type": "node", "id": 1, "lat": 51.5012, "lon": -0.1415, "tags": {"name": "Corner Cafe", "amenity": "cafe"}}
            ]})))
            .mount(&server)
            .await;
        let platform = Arc::new(FakePlatform::default());
        *platform.confirm.lock() = true;
        *platform.position.lock() = Some(Ok(Fix { lat: 51.501_2, lon: -0.141_9, accuracy_m: None }));
        let (core, _d) = core_with(platform);
        *core.endpoints.lock() =
            crate::core::Endpoints { nominatim: server.uri(), overpass: format!("{}/overpass", server.uri()), ..Default::default() };
        let (ctx, _) = ctx(core.clone(), Origin::User);
        let r = Registry::standard();
        let names: Vec<String> = r.names().into_iter().map(String::from).collect();
        let find = json!({"type": "tool_use", "id": "f", "name": "find_places", "input": {"query": "cafe"}});

        // Without a location, find_places points the model at get_current_location.
        let res = execute(&r, &ctx, &find, &names).await;
        assert!(!res.ok);
        assert!(res.block.to_string().contains("get_current_location"));

        assert!(execute(&r, &ctx, &call("g"), &names).await.ok);
        let res = execute(&r, &ctx, &find, &names).await;
        assert!(res.ok, "{}", res.block);
        assert!(res.block.to_string().contains("Corner Cafe"));
        assert!(res.block.to_string().contains("Westminster, London"));
    }
}
