//! Everyday helpers: plain-word reminders, the morning brief, bills and subscriptions, and price
//! watch. They run from the scheduler loop as plain code, never through a model, so they work on
//! every plan, cost nothing in usage, and keep working while automations are paused.

pub mod bills;
pub mod brief;
pub mod calendar;
pub mod prices;
pub mod reminders;
pub mod weather;

use crate::core::Core;
use chrono::{Local, Utc};
use parking_lot::Mutex;
use std::collections::HashSet;
use std::sync::Arc;

/// Tell the user about something: a system notification, and an `everyday-alert` event so the app
/// can show it (and the mascot can pop out) if it's open.
pub fn alert(core: &Core, kind: &str, title: &str, body: &str, id: Option<&str>) {
    if let Err(e) = core.platform.notify(&crate::util::preview(title, 80), &crate::util::preview(body, 300)) {
        log::warn!("notification: {e}");
    }
    core.platform.broadcast("everyday-alert", serde_json::json!({"kind": kind, "title": title, "body": body, "id": id}));
}

/// Work started by `tick` that hasn't finished, so a slow fetch isn't started twice.
static IN_FLIGHT: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn claim(key: &str) -> bool {
    IN_FLIGHT.lock().get_or_insert_with(HashSet::new).insert(key.to_string())
}

fn release(key: &str) {
    if let Some(s) = IN_FLIGHT.lock().as_mut() {
        s.remove(key);
    }
}

/// One pass of the everyday helpers. Called from the scheduler loop every 30 seconds.
pub async fn tick(core: Arc<Core>) {
    if let Err(e) = reminders::fire_due(&core, Utc::now()) {
        log::warn!("reminders: {e}");
    }
    // Each renewal is warned about once (see `check_renewals`), so checking every pass is cheap.
    if let Err(e) = bills::check_renewals(&core, Local::now().date_naive()) {
        log::warn!("bills: {e}");
    }
    if brief::is_due(&core, Local::now()) && claim("brief") {
        let c = core.clone();
        tokio::spawn(async move {
            if let Err(e) = brief::make_and_save(&c).await {
                log::warn!("morning brief: {e}");
            }
            release("brief");
        });
    }
    match prices::due(&core, Utc::now()) {
        Ok(ids) => {
            for id in ids.into_iter().filter(|id| claim(id)) {
                let c = core.clone();
                tokio::spawn(async move {
                    if let Err(e) = prices::check(&c, &id).await {
                        log::warn!("price watch {id}: {e}");
                    }
                    release(&id);
                });
            }
        }
        Err(e) => log::warn!("price watch: {e}"),
    }
}
