//! Apps Lumo can order with for the user: food delivery, groceries, shopping, rides and tables.
//!
//! None of these services offers an ordering API Lumo can use today (Uber's and DoorDash's are
//! invite-only partner programs), so Lumo works in the user's own browser, where the user is
//! signed in: it opens the app, fills the cart on screen, and stops at checkout so the user places
//! the order and pays. "Connected" means the user told Lumo they are signed in there. Lumo never
//! sees or stores their password or card.
//!
//! Payment: cards stay in each app's own wallet (or Apple Pay / Google Pay in the browser). The user
//! can tell Lumo which saved method to pick at checkout ("Visa ending 4242", "Apple Pay"); that
//! label is all Lumo keeps, and it refuses anything that looks like a card number.

use crate::core::Core;
use crate::error::{invalid, Result};
use serde::Serialize;
use serde_json::{json, Value};

pub struct OrderingApp {
    pub id: &'static str,
    pub name: &'static str,
    /// "food", "groceries", "shopping", "rides" or "tables".
    pub category: &'static str,
    /// Where the user signs in and starts. Always https.
    pub home: &'static str,
    /// A search page with `{q}` for the url-encoded search, when the site has one.
    pub search: Option<&'static str>,
    /// Hosts that belong to the app. Lumo only opens pages on these.
    pub hosts: &'static [&'static str],
    pub regions: &'static str,
}

pub const APPS: &[OrderingApp] = &[
    OrderingApp {
        id: "ubereats",
        name: "Uber Eats",
        category: "food",
        home: "https://www.ubereats.com/",
        search: Some("https://www.ubereats.com/search?q={q}"),
        hosts: &["ubereats.com"],
        regions: "US, Canada, UK, Australia and more",
    },
    OrderingApp {
        id: "doordash",
        name: "DoorDash",
        category: "food",
        home: "https://www.doordash.com/",
        search: Some("https://www.doordash.com/search/store/{q}/"),
        hosts: &["doordash.com"],
        regions: "US, Canada, Australia, New Zealand",
    },
    OrderingApp {
        id: "grubhub",
        name: "Grubhub",
        category: "food",
        home: "https://www.grubhub.com/",
        search: Some("https://www.grubhub.com/search?queryText={q}"),
        hosts: &["grubhub.com"],
        regions: "US",
    },
    OrderingApp {
        id: "deliveroo",
        name: "Deliveroo",
        category: "food",
        home: "https://deliveroo.co.uk/",
        search: None,
        hosts: &["deliveroo.co.uk", "deliveroo.com"],
        regions: "UK, Ireland, France, Italy and more",
    },
    OrderingApp {
        id: "justeat",
        name: "Just Eat",
        category: "food",
        home: "https://www.just-eat.co.uk/",
        search: None,
        hosts: &["just-eat.co.uk"],
        regions: "UK",
    },
    OrderingApp {
        id: "dominos",
        name: "Domino's",
        category: "food",
        home: "https://www.dominos.com/",
        search: None,
        hosts: &["dominos.com"],
        regions: "US",
    },
    OrderingApp {
        id: "starbucks",
        name: "Starbucks",
        category: "food",
        home: "https://app.starbucks.com/",
        search: None,
        hosts: &["starbucks.com"],
        regions: "US",
    },
    OrderingApp {
        id: "instacart",
        name: "Instacart",
        category: "groceries",
        home: "https://www.instacart.com/",
        search: Some("https://www.instacart.com/store/s?k={q}"),
        hosts: &["instacart.com"],
        regions: "US, Canada",
    },
    OrderingApp {
        id: "walmart",
        name: "Walmart",
        category: "groceries",
        home: "https://www.walmart.com/",
        search: Some("https://www.walmart.com/search?q={q}"),
        hosts: &["walmart.com"],
        regions: "US",
    },
    OrderingApp {
        id: "target",
        name: "Target",
        category: "groceries",
        home: "https://www.target.com/",
        search: Some("https://www.target.com/s?searchTerm={q}"),
        hosts: &["target.com"],
        regions: "US",
    },
    OrderingApp {
        id: "kroger",
        name: "Kroger",
        category: "groceries",
        home: "https://www.kroger.com/",
        search: Some("https://www.kroger.com/search?query={q}"),
        hosts: &["kroger.com"],
        regions: "US",
    },
    OrderingApp {
        id: "costco",
        name: "Costco",
        category: "groceries",
        home: "https://www.costco.com/",
        search: Some("https://www.costco.com/CatalogSearch?keyword={q}"),
        hosts: &["costco.com"],
        regions: "US",
    },
    OrderingApp {
        id: "amazon",
        name: "Amazon",
        category: "shopping",
        home: "https://www.amazon.com/",
        search: Some("https://www.amazon.com/s?k={q}"),
        hosts: &["amazon.com"],
        regions: "US",
    },
    OrderingApp {
        id: "bestbuy",
        name: "Best Buy",
        category: "shopping",
        home: "https://www.bestbuy.com/",
        search: Some("https://www.bestbuy.com/site/searchpage.jsp?st={q}"),
        hosts: &["bestbuy.com"],
        regions: "US",
    },
    OrderingApp {
        id: "ebay",
        name: "eBay",
        category: "shopping",
        home: "https://www.ebay.com/",
        search: Some("https://www.ebay.com/sch/i.html?_nkw={q}"),
        hosts: &["ebay.com"],
        regions: "Worldwide",
    },
    OrderingApp {
        id: "etsy",
        name: "Etsy",
        category: "shopping",
        home: "https://www.etsy.com/",
        search: Some("https://www.etsy.com/search?q={q}"),
        hosts: &["etsy.com"],
        regions: "Worldwide",
    },
    OrderingApp {
        id: "uber",
        name: "Uber rides",
        category: "rides",
        home: "https://m.uber.com/",
        search: None,
        hosts: &["uber.com"],
        regions: "Worldwide",
    },
    OrderingApp {
        id: "lyft",
        name: "Lyft",
        category: "rides",
        home: "https://ride.lyft.com/",
        search: None,
        hosts: &["lyft.com"],
        regions: "US, Canada",
    },
    OrderingApp {
        id: "opentable",
        name: "OpenTable",
        category: "tables",
        home: "https://www.opentable.com/",
        search: Some("https://www.opentable.com/s?term={q}"),
        hosts: &["opentable.com"],
        regions: "Worldwide",
    },
    OrderingApp {
        id: "resy",
        name: "Resy",
        category: "tables",
        home: "https://resy.com/",
        search: None,
        hosts: &["resy.com"],
        regions: "US and more",
    },
];

pub fn find(id: &str) -> Result<&'static OrderingApp> {
    APPS.iter().find(|a| a.id == id).ok_or_else(|| invalid(format!("'{id}' is not an app Lumo can order with")))
}

/// The page to open for a search, or the app's home page.
pub fn start_url(app: &OrderingApp, query: Option<&str>) -> String {
    match (app.search, query.map(str::trim).filter(|q| !q.is_empty())) {
        (Some(t), Some(q)) => {
            let q: String = url::form_urlencoded::byte_serialize(q.as_bytes()).collect();
            t.replace("{q}", &q)
        }
        _ => app.home.to_string(),
    }
}

/// Whether a link belongs to the app (https, and its host or a subdomain of it).
pub fn owns(app: &OrderingApp, link: &str) -> bool {
    let Ok(u) = url::Url::parse(link) else { return false };
    let Some(host) = u.host_str() else { return false };
    u.scheme() == "https" && app.hosts.iter().any(|h| host == *h || host.ends_with(&format!(".{h}")))
}

fn key(id: &str) -> String {
    format!("app:{id}")
}

fn meta(core: &Core, id: &str) -> Value {
    core.db
        .conn()
        .query_row("SELECT meta_json FROM integrations WHERE id = ?1", [key(id)], |r| r.get::<_, String>(0))
        .ok()
        .and_then(|m| serde_json::from_str(&m).ok())
        .unwrap_or(Value::Null)
}

/// The saved payment method the user wants picked at checkout, e.g. "Apple Pay".
pub fn payment_label(core: &Core, id: &str) -> Option<String> {
    meta(core, id)["payment"].as_str().map(String::from)
}

/// Save (or clear, with an empty label) which saved payment method Lumo picks in this app.
pub fn set_payment_label(core: &Core, id: &str, label: &str) -> Result<()> {
    let app = find(id)?;
    let label = label.trim();
    if label.chars().count() > 40 {
        return Err(invalid("keep it short, like \"Visa ending 4242\" or \"Apple Pay\""));
    }
    // Only a label. More than four digits could be part of a card number, so it is never kept.
    if label.chars().filter(char::is_ascii_digit).count() > 4 {
        return Err(invalid("don't enter card numbers. Lumo only needs a name like \"Visa ending 4242\"; your card stays in the app"));
    }
    let mut m = meta(core, id);
    if !m.is_object() {
        m = json!({"kind": "browser"});
    }
    if label.is_empty() {
        m.as_object_mut().map(|o| o.remove("payment"));
    } else {
        m["payment"] = json!(label);
    }
    let status = if is_connected(core, id) { "connected" } else { "not_connected" };
    super::record(core, &key(id), status, None, &m)?;
    crate::audit::record(&core.db, "user", "set_app_payment", Some(app.name), None, "ok");
    Ok(())
}

pub fn is_connected(core: &Core, id: &str) -> bool {
    core.db.conn().query_row("SELECT 1 FROM integrations WHERE id = ?1 AND status = 'connected'", [key(id)], |_| Ok(())).is_ok()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStatus {
    pub id: &'static str,
    pub name: &'static str,
    pub category: &'static str,
    pub home: &'static str,
    pub regions: &'static str,
    pub connected: bool,
    pub payment: Option<String>,
}

pub fn list(core: &Core) -> Vec<AppStatus> {
    APPS.iter()
        .map(|a| AppStatus {
            id: a.id,
            name: a.name,
            category: a.category,
            home: a.home,
            regions: a.regions,
            connected: is_connected(core, a.id),
            payment: payment_label(core, a.id),
        })
        .collect()
}

/// Open the app's page in the user's browser so they can sign in there.
pub fn open_sign_in(core: &Core, id: &str) -> Result<()> {
    let app = find(id)?;
    core.platform.open_url(app.home)
}

/// The user says they are signed in (or signed out) in their browser.
pub fn set_connected(core: &Core, id: &str, connected: bool) -> Result<()> {
    let app = find(id)?;
    if connected {
        let mut m = meta(core, id);
        if !m.is_object() {
            m = json!({"kind": "browser"});
        }
        super::record(core, &key(id), "connected", None, &m)?;
        crate::audit::record(&core.db, "user", "connect_app", Some(app.name), None, "ok");
    } else {
        core.db.conn().execute("DELETE FROM integrations WHERE id = ?1", [key(id)])?;
        crate::audit::record(&core.db, "user", "disconnect_app", Some(app.name), None, "ok");
    }
    Ok(())
}

/// One line for the turn context: every app id, and which ones the user is signed in to.
pub fn context_line(core: &Core) -> String {
    let signed_in: Vec<String> = APPS
        .iter()
        .filter(|a| is_connected(core, a.id))
        .map(|a| match payment_label(core, a.id) {
            Some(p) => format!("{} (pay with {p})", a.id),
            None => a.id.to_string(),
        })
        .collect();
    format!(
        "Ordering apps for start_order: {}. Signed in: {}.",
        APPS.iter().map(|a| a.id).collect::<Vec<_>>().join(", "),
        if signed_in.is_empty() { "none yet".into() } else { signed_in.join(", ") }
    )
}

#[derive(Debug, Serialize, serde::Deserialize, Clone, PartialEq)]
pub struct RecentItem {
    pub name: String,
    pub quantity: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentOrder {
    pub id: String,
    pub app: String,
    pub app_name: String,
    pub store: Option<String>,
    pub items: Vec<RecentItem>,
    pub created_at: String,
}

const KEEP_RECENT: i64 = 20;

/// Remember an order the user confirmed, for "order again". The same app and store replaces the
/// older entry.
pub fn remember_order(core: &Core, app: &str, store: Option<&str>, items: &[RecentItem]) -> Result<()> {
    find(app)?;
    let store = store.map(str::trim).filter(|s| !s.is_empty());
    let conn = core.db.conn();
    conn.execute(
        "DELETE FROM recent_orders WHERE app = ?1 AND IFNULL(lower(store), '') = IFNULL(lower(?2), '')",
        rusqlite::params![app, store],
    )?;
    conn.execute(
        "INSERT INTO recent_orders(id, app, store, items_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![crate::util::new_id(), app, store, serde_json::to_string(items)?, crate::util::now()],
    )?;
    conn.execute(
        "DELETE FROM recent_orders WHERE id NOT IN (SELECT id FROM recent_orders ORDER BY created_at DESC, rowid DESC LIMIT ?1)",
        [KEEP_RECENT],
    )?;
    Ok(())
}

pub fn recent_orders(core: &Core, limit: usize) -> Result<Vec<RecentOrder>> {
    let conn = core.db.conn();
    let mut st =
        conn.prepare("SELECT id, app, store, items_json, created_at FROM recent_orders ORDER BY created_at DESC, rowid DESC LIMIT ?1")?;
    let rows = st.query_map([limit as i64], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, String>(3)?, r.get::<_, String>(4)?))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (id, app, store, items, created_at) = row?;
        let Ok(a) = find(&app) else { continue };
        out.push(RecentOrder {
            id,
            app,
            app_name: a.name.into(),
            store,
            items: serde_json::from_str(&items).unwrap_or_default(),
            created_at,
        });
    }
    Ok(out)
}

pub fn forget_order(core: &Core, id: &str) -> Result<()> {
    core.db.conn().execute("DELETE FROM recent_orders WHERE id = ?1", [id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::testing::{core_with, FakePlatform};

    #[test]
    fn payment_is_a_label_only_and_orders_are_remembered_once_per_store() {
        let (core, _d) = core_with(std::sync::Arc::new(FakePlatform::default()));
        set_connected(&core, "ubereats", true).unwrap();
        set_payment_label(&core, "ubereats", "Visa ending 4242").unwrap();
        assert_eq!(payment_label(&core, "ubereats").as_deref(), Some("Visa ending 4242"));
        assert!(is_connected(&core, "ubereats"));
        assert!(set_payment_label(&core, "ubereats", "4242 4242 4242 4242").is_err());
        assert!(set_payment_label(&core, "ubereats", "card 424242").is_err());
        // Signing in again keeps the choice; clearing removes it.
        set_connected(&core, "ubereats", true).unwrap();
        assert_eq!(payment_label(&core, "ubereats").as_deref(), Some("Visa ending 4242"));
        set_payment_label(&core, "ubereats", "").unwrap();
        assert_eq!(payment_label(&core, "ubereats"), None);
        assert!(is_connected(&core, "ubereats"));
        assert!(set_payment_label(&core, "nope", "Apple Pay").is_err());

        let one = |n: &str| vec![RecentItem { name: n.into(), quantity: 1 }];
        remember_order(&core, "ubereats", Some("McDonald's"), &one("Big Mac")).unwrap();
        remember_order(&core, "doordash", Some("Starbucks"), &one("Latte")).unwrap();
        remember_order(&core, "ubereats", Some("mcdonald's"), &one("McFlurry")).unwrap();
        let r = recent_orders(&core, 10).unwrap();
        assert_eq!(r.len(), 2);
        assert_eq!((r[0].app_name.as_str(), r[0].items[0].name.as_str()), ("Uber Eats", "McFlurry"));
        forget_order(&core, &r[0].id).unwrap();
        assert_eq!(recent_orders(&core, 10).unwrap().len(), 1);
        for i in 0..30 {
            remember_order(&core, "amazon", Some(&format!("thing {i}")), &one("x")).unwrap();
        }
        assert_eq!(recent_orders(&core, 100).unwrap().len(), KEEP_RECENT as usize);
    }

    #[test]
    fn every_app_is_https_and_owns_its_own_pages() {
        for a in APPS {
            assert!(owns(a, a.home), "{} home", a.id);
            assert!(owns(a, &start_url(a, Some("pad thai & spring rolls"))), "{} search", a.id);
            assert!(!owns(a, "https://evil.example/"), "{}", a.id);
        }
        let ue = find("ubereats").unwrap();
        assert_eq!(start_url(ue, Some("pad thai & rolls")), "https://www.ubereats.com/search?q=pad+thai+%26+rolls");
        assert_eq!(start_url(ue, Some("  ")), "https://www.ubereats.com/");
        assert!(!owns(ue, "http://www.ubereats.com/"), "https only");
        assert!(!owns(ue, "https://ubereats.com.evil.example/"));
        assert!(find("nope").is_err());
        let ids: std::collections::HashSet<_> = APPS.iter().map(|a| a.id).collect();
        assert_eq!(ids.len(), APPS.len(), "ids are unique");
    }
}
