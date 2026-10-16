//! Secret storage. Secrets (API keys, OAuth tokens, the database key) live only in the operating
//! system's credential store: macOS Keychain, Windows Credential Manager, or the Secret Service on
//! Linux; on phones, the iOS Keychain (this device only, never synced) or storage encrypted with an
//! Android Keystore key. There is deliberately no plaintext fallback: if no store is available,
//! saving a secret fails with a message that says so.
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

/// The OS credential store, via the `keyring` crate (computers) or `keyring-core` with the phone's
/// native store (iOS, Android). Both expose the same entry type and errors.
pub struct OsKeychain;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use keyring::{Entry as KeyEntry, Error as KeyError};
#[cfg(any(target_os = "android", target_os = "ios"))]
use keyring_core::{Entry as KeyEntry, Error as KeyError};

/// Phones: choose the native store once. Tauri sets up the Android context it needs before Lumo starts.
#[cfg(any(target_os = "android", target_os = "ios"))]
fn phone_store_status() -> &'static std::result::Result<(), String> {
    static STATUS: std::sync::LazyLock<std::result::Result<(), String>> = std::sync::LazyLock::new(|| {
        #[cfg(target_os = "ios")]
        let store = apple_native_keyring_store::protected::Store::new();
        #[cfg(target_os = "android")]
        let store = android_native_keyring_store::Store::new();
        store.map(|s| keyring_core::set_default_store(s)).map_err(|e| e.to_string())
    });
    &STATUS
}

impl OsKeychain {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    pub fn available() -> std::result::Result<(), String> {
        KeyEntry::store_status().as_ref().map(|_| ()).map_err(|e| e.to_string())
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    pub fn available() -> std::result::Result<(), String> {
        phone_store_status().clone()
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    fn new_entry(name: &str) -> std::result::Result<KeyEntry, KeyError> {
        KeyEntry::new(SERVICE, name)
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    fn new_entry(name: &str) -> std::result::Result<KeyEntry, KeyError> {
        if phone_store_status().is_err() {
            return Err(KeyError::NoDefaultStore);
        }
        // iOS: readable after the first unlock (so automations can run), never synced or restored
        // to another device. Android's store encrypts every item with its own Keystore key.
        let mods = std::collections::HashMap::from([("access-policy", "after-first-unlock-this-device-only")]);
        if cfg!(target_os = "ios") {
            KeyEntry::new_with_modifiers(SERVICE, name, &mods)
        } else {
            KeyEntry::new(SERVICE, name)
        }
    }
    fn entry(name: &str) -> Result<KeyEntry> {
        Self::new_entry(name).map_err(|e| {
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
            Err(KeyError::NoEntry) => Ok(None),
            Err(e) => Err(LumoError::Unavailable(format!("Could not read from the system keychain: {e}"))),
        }
    }
    fn set(&self, name: &str, value: &str) -> Result<()> {
        Self::entry(name)?.set_password(value).map_err(|e| LumoError::Unavailable(format!("Could not save to the system keychain: {e}")))
    }
    fn delete(&self, name: &str) -> Result<()> {
        match Self::entry(name)?.delete_credential() {
            Ok(()) | Err(KeyError::NoEntry) => Ok(()),
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
    ("anthropic_api_key", "Anthropic API key"),
    ("openai_compatible_api_key", "OpenAI-compatible API key"),
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
