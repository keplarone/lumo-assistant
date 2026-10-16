//! Secret storage. Secrets (API keys, OAuth tokens, the database key) live only in the operating
//! system's credential store: macOS Keychain, Windows Credential Manager, or the Secret Service on
//! Linux. There is deliberately no plaintext fallback: if no store is available, saving a secret fails
//! with a message that says so.
//!
//! The webview never receives a secret. It can ask whether one is set (`secrets_status`).

use crate::error::{LumoError, Result};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;

pub const SERVICE: &str = "one.keplar.lumo";

pub trait SecretStore: Send + Sync {
    fn get(&self, name: &str) -> Result<Option<String>>;
    fn set(&self, name: &str, value: &str) -> Result<()>;
    fn delete(&self, name: &str) -> Result<()>;
}

pub type Secrets = Arc<dyn SecretStore>;

/// The OS credential store, via the `keyring` crate.
pub struct OsKeychain;

impl OsKeychain {
    pub fn available() -> std::result::Result<(), String> {
        keyring::Entry::store_status().as_ref().map(|_| ()).map_err(|e| e.to_string())
    }
    fn entry(name: &str) -> Result<keyring::Entry> {
        keyring::Entry::new(SERVICE, name).map_err(|e| {
            LumoError::Unavailable(format!(
                "No system keychain is available, so Lumo cannot store secrets safely ({e}). On Linux, install and unlock a Secret Service provider such as GNOME Keyring or KWallet."
            ))
        })
    }
}

impl SecretStore for OsKeychain {
    fn get(&self, name: &str) -> Result<Option<String>> {
        match Self::entry(name)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(LumoError::Unavailable(format!("Could not read from the system keychain: {e}"))),
        }
    }
    fn set(&self, name: &str, value: &str) -> Result<()> {
        Self::entry(name)?.set_password(value).map_err(|e| LumoError::Unavailable(format!("Could not save to the system keychain: {e}")))
    }
    fn delete(&self, name: &str) -> Result<()> {
        match Self::entry(name)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(LumoError::Unavailable(format!("Could not delete from the system keychain: {e}"))),
        }
    }
}

/// In-memory store for tests.
#[derive(Default)]
pub struct MemoryStore(Mutex<HashMap<String, String>>);

impl SecretStore for MemoryStore {
    fn get(&self, name: &str) -> Result<Option<String>> {
        Ok(self.0.lock().get(name).cloned())
    }
    fn set(&self, name: &str, value: &str) -> Result<()> {
        self.0.lock().insert(name.into(), value.into());
        Ok(())
    }
    fn delete(&self, name: &str) -> Result<()> {
        self.0.lock().remove(name);
        Ok(())
    }
}

/// Names of the secrets Lumo knows about. Anything else is rejected, so the webview cannot use the
/// keychain as general storage or probe for unrelated entries.
pub const KNOWN: &[(&str, &str)] = &[
    ("brave_search_api_key", "Brave Search API key"),
    ("github_token", "GitHub token"),
    ("netlify_token", "Netlify token"),
    ("google_client_secret", "Google OAuth client secret"),
    ("google_tokens", "Google account tokens"),
    ("stt_api_key", "Speech-to-text API key"),
];

pub fn check_known(name: &str) -> Result<()> {
    if KNOWN.iter().any(|(n, _)| *n == name) {
        Ok(())
    } else {
        Err(LumoError::Invalid(format!("unknown secret '{name}'")))
    }
}

/// Internal-only secret names (never settable from the webview).
pub const DB_KEY: &str = "database_key";
