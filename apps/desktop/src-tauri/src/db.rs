//! The local database: SQLite encrypted with SQLCipher. The 256-bit key is generated on first run and
//! kept in the OS keychain.

use crate::error::{LumoError, Result};
use crate::secrets::{SecretStore, DB_KEY};
use parking_lot::{Mutex, MutexGuard};
use rand::RngCore;
use rusqlite::Connection;
use std::path::Path;
use std::sync::Arc;

#[derive(Clone)]
pub struct Db(Arc<Mutex<Connection>>);

impl Db {
    /// Open (creating if needed) the encrypted database at `path`.
    pub fn open(path: &Path, secrets: &dyn SecretStore) -> Result<Db> {
        let key = match secrets.get(DB_KEY)? {
            Some(k) => k,
            None => {
                if path.exists() {
                    return Err(LumoError::Unavailable(
                        "Lumo's database exists but its key is missing from the system keychain, so it cannot be opened. If you reset your keychain, move the database aside to start fresh.".into(),
                    ));
                }
                let mut bytes = [0u8; 32];
                rand::rng().fill_bytes(&mut bytes);
                let k = hex::encode(bytes);
                secrets.set(DB_KEY, &k)?;
                k
            }
        };
        let conn = Connection::open(path)?;
        Self::init(conn, Some(&key))
    }

    /// An unencrypted in-memory database for tests.
    pub fn memory() -> Result<Db> {
        Self::init(Connection::open_in_memory()?, None)
    }

    fn init(conn: Connection, key: Option<&str>) -> Result<Db> {
        if let Some(k) = key {
            // Raw key form avoids PBKDF2 on every open; the key is already random.
            conn.execute_batch(&format!("PRAGMA key = \"x'{k}'\";"))?;
        }
        conn.execute_batch(
            "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;",
        )?;
        // Fails here (not later) if the key is wrong.
        conn.query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get::<_, i64>(0))
            .map_err(|e| LumoError::Unavailable(format!("Could not open Lumo's database: {e}")))?;
        migrate(&conn)?;
        Ok(Db(Arc::new(Mutex::new(conn))))
    }

    pub fn conn(&self) -> MutexGuard<'_, Connection> {
        self.0.lock()
    }
}

const MIGRATIONS: &[&str] = &[
    include_str!("../migrations/001_init.sql"),
    include_str!("../migrations/002_plan_usage.sql"),
    include_str!("../migrations/003_recent_orders.sql"),
];

fn migrate(conn: &Connection) -> Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate() {
        let v = i as i64 + 1;
        if v > version {
            conn.execute_batch(&format!("BEGIN; {sql}\nPRAGMA user_version = {v}; COMMIT;"))?;
            log::info!("database migrated to version {v}");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::MemoryStore;

    #[test]
    fn encrypted_database_round_trips_and_rejects_wrong_key() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("lumo.db");
        let secrets = MemoryStore::default();
        {
            let db = Db::open(&path, &secrets).unwrap();
            db.conn().execute("INSERT INTO settings(key, value) VALUES ('a', '1')", []).unwrap();
        }
        // The file is not plaintext SQLite.
        let head = std::fs::read(&path).unwrap();
        assert_ne!(&head[..15], b"SQLite format 3");
        // Reopen with the same key works.
        let db = Db::open(&path, &secrets).unwrap();
        let v: String = db.conn().query_row("SELECT value FROM settings WHERE key='a'", [], |r| r.get(0)).unwrap();
        assert_eq!(v, "1");
        drop(db);
        // A different key fails loudly.
        secrets.set(DB_KEY, &"00".repeat(32)).unwrap();
        assert!(Db::open(&path, &secrets).is_err());
        // A missing key with an existing file refuses to silently create a new database.
        secrets.delete(DB_KEY).unwrap();
        assert!(matches!(Db::open(&path, &secrets), Err(LumoError::Unavailable(_))));
    }
}
