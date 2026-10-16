//! Append-only audit log of everything Lumo does on the user's behalf: tool executions, approvals,
//! permission changes, connections, secret changes (names only, never values).

use crate::db::Db;
use crate::util::now;
use serde::Serialize;
use serde_json::Value;

pub fn record(db: &Db, actor: &str, action: &str, target: Option<&str>, detail: Option<&Value>, outcome: &str) {
    let res = db.conn().execute(
        "INSERT INTO audit_log(ts, actor, action, target, detail_json, outcome) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![now(), actor, action, target, detail.map(|d| d.to_string()), outcome],
    );
    if let Err(e) = res {
        log::error!("audit write failed: {e}");
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub id: i64,
    pub ts: String,
    pub actor: String,
    pub action: String,
    pub target: Option<String>,
    pub detail: Option<Value>,
    pub outcome: String,
}

pub fn list(db: &Db, limit: u32, before_id: Option<i64>) -> crate::error::Result<Vec<AuditEntry>> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT id, ts, actor, action, target, detail_json, outcome FROM audit_log WHERE (?1 IS NULL OR id < ?1) ORDER BY id DESC LIMIT ?2",
    )?;
    let rows = stmt
        .query_map(rusqlite::params![before_id, limit], |r| {
            Ok(AuditEntry {
                id: r.get(0)?,
                ts: r.get(1)?,
                actor: r.get(2)?,
                action: r.get(3)?,
                target: r.get(4)?,
                detail: r.get::<_, Option<String>>(5)?.and_then(|s| serde_json::from_str(&s).ok()),
                outcome: r.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}
