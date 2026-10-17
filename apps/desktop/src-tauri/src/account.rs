//! Lumo accounts. People sign in before using Lumo: with Google, or with an email and password, on the
//! sign-in page WorkOS AuthKit hosts. That page also offers passkeys and asks for a two-step code when the
//! person turned it on; both are optional and recommended in Settings → Account.
//!
//! How sign-in works (OAuth 2 for native apps, RFC 8252, with PKCE): the core listens on a random port of
//! 127.0.0.1, opens the sign-in page in the default browser, and waits for the redirect. AuthKit only
//! redirects to https in production, so it lands on Lumo's account server, which passes the code on to the
//! port named in `state`. The code is useless without the PKCE verifier, which never leaves the core.
//!
//! The refresh token lives only in the OS keychain; the short-lived access token only in memory. The
//! webview never sees either. The plan comes from the account server, which links each Whop membership
//! to one account, so a plan follows the person to any computer.
//!
//! Build-time configuration (unset means accounts are off in this build, e.g. development builds):
//!   LUMO_WORKOS_CLIENT_ID   the AuthKit client id (public)
//!   LUMO_ACCOUNT_SERVER     e.g. https://lumo-license.vercel.app (defaults to LUMO_LICENSE_SERVER's origin)
//!   LUMO_AUTHKIT_BASE       defaults to https://api.workos.com

use crate::agent::events::ActionPreview;
use crate::core::Core;
use crate::error::{denied, invalid, LumoError, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

const REFRESH_SECRET: &str = "account_refresh_token";
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// How often a signed-in Lumo re-checks the account and its plan.
pub const RECHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);

static REFRESHING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Debug, Clone, PartialEq)]
pub struct AccountConfig {
    pub client_id: String,
    pub authkit_base: String,
    /// Origin of the account server, without a trailing slash.
    pub server: String,
}

impl AccountConfig {
    pub fn from_build() -> Option<Self> {
        let https =
            |v: Option<&'static str>| v.map(str::trim).filter(|s| s.starts_with("https://")).map(|s| s.trim_end_matches('/').to_string());
        let client_id = option_env!("LUMO_WORKOS_CLIENT_ID").map(str::trim).filter(|s| valid_id(s, "client_"))?.to_string();
        let server = https(option_env!("LUMO_ACCOUNT_SERVER"))
            .or_else(|| crate::license::server().and_then(|u| url::Url::parse(&u).ok()).map(|u| u.origin().ascii_serialization()))?;
        let authkit_base = https(option_env!("LUMO_AUTHKIT_BASE")).unwrap_or_else(|| "https://api.workos.com".into());
        Some(AccountConfig { client_id, authkit_base, server })
    }
    fn redirect_uri(&self) -> String {
        format!("{}/api/auth/callback", self.server)
    }
}

fn valid_id(s: &str, prefix: &str) -> bool {
    s.starts_with(prefix) && s.len() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Account state held by the core: the configuration and the in-memory access token.
#[derive(Default)]
pub struct AccountState {
    pub config: Option<AccountConfig>,
    access: Option<(String, i64)>,
    sign_in: Option<(u64, CancellationToken)>,
}

impl AccountState {
    pub fn new(config: Option<AccountConfig>) -> Self {
        AccountState { config, ..Default::default() }
    }
}

/// What the app remembers about the signed-in account (not secret; kept with the settings).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct AccountInfo {
    pub user_id: String,
    pub email: Option<String>,
    pub name: Option<String>,
    pub two_step: bool,
    pub license_linked: bool,
    /// How they last signed in, as AuthKit reports it (e.g. "GoogleOAuth", "Password", "Passkey").
    pub method: Option<String>,
    pub checked_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    /// False in builds without accounts (development); then sign-in isn't required.
    pub configured: bool,
    pub signed_in: bool,
    pub signing_in: bool,
    pub account: Option<AccountInfo>,
    /// Passkeys are recommended until they have signed in with one.
    pub recommend_passkey: bool,
    pub recommend_two_step: bool,
}

pub fn config(core: &Core) -> Option<AccountConfig> {
    core.account.lock().config.clone()
}

pub fn status(core: &Core) -> AccountStatus {
    let st = core.account.lock();
    let account = core.settings().account;
    let configured = st.config.is_some();
    AccountStatus {
        configured,
        signed_in: account.is_some(),
        signing_in: st.sign_in.is_some(),
        recommend_passkey: configured && account.as_ref().is_some_and(|a| a.method.as_deref() != Some("Passkey")),
        recommend_two_step: configured && account.as_ref().is_some_and(|a| !a.two_step && a.method.as_deref() != Some("Passkey")),
        account,
    }
}

/// Lumo works only for a signed-in person (in builds with accounts). Checked in the core, not the UI.
pub fn require_signed_in(core: &Core) -> Result<()> {
    if config(core).is_some() && core.settings().account.is_none() {
        return Err(denied("Sign in to Lumo to continue."));
    }
    Ok(())
}

// ---- Signing in ---------------------------------------------------------------------------------

/// Open the sign-in page and wait for the person to finish there. `mode` is "google", "email" (sign in
/// with an email, password or passkey) or "sign_up" (create an account).
pub async fn sign_in(core: &Arc<Core>, mode: &str) -> Result<AccountStatus> {
    let cfg = config(core).ok_or_else(|| LumoError::Unavailable("Accounts aren't available in this build.".into()))?;
    let provider_hint = match mode {
        "google" => ("GoogleOAuth", None),
        "email" => ("authkit", Some("sign-in")),
        "sign_up" => ("authkit", Some("sign-up")),
        _ => return Err(invalid("unknown sign-in method")),
    };
    // Starting again replaces a sign-in still waiting (say, a browser tab they closed).
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let id = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let cancel = CancellationToken::new();
    if let Some((_, old)) = core.account.lock().sign_in.replace((id, cancel.clone())) {
        old.cancel();
    }
    let out = sign_in_inner(core, &cfg, provider_hint, &cancel).await;
    {
        let mut st = core.account.lock();
        if st.sign_in.as_ref().is_some_and(|(i, _)| *i == id) {
            st.sign_in = None;
        }
    }
    match out {
        Ok(()) => Ok(status(core)),
        Err(e) => {
            crate::audit::record(&core.db, "user", "account_sign_in", Some(mode), None, "failed");
            Err(e)
        }
    }
}

pub fn cancel_sign_in(core: &Core) {
    if let Some((_, t)) = core.account.lock().sign_in.take() {
        t.cancel();
    }
}

async fn sign_in_inner(
    core: &Arc<Core>,
    cfg: &AccountConfig,
    (provider, hint): (&str, Option<&str>),
    cancel: &CancellationToken,
) -> Result<()> {
    let verifier = random_token(48);
    let challenge = B64.encode(Sha256::digest(verifier.as_bytes()));
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    let state = format!("{}.{port}", random_token(24));

    let mut url = url::Url::parse(&format!("{}/user_management/authorize", cfg.authkit_base)).map_err(|e| invalid(e.to_string()))?;
    url.query_pairs_mut()
        .append_pair("client_id", &cfg.client_id)
        .append_pair("redirect_uri", &cfg.redirect_uri())
        .append_pair("response_type", "code")
        .append_pair("provider", provider)
        .append_pair("state", &state)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256");
    if let Some(h) = hint {
        url.query_pairs_mut().append_pair("screen_hint", h);
    }
    core.platform.open_url(url.as_str())?;

    let code = tokio::select! {
        r = wait_for_code(&listener, &state) => r?,
        _ = cancel.cancelled() => return Err(LumoError::Cancelled),
        _ = tokio::time::sleep(SIGN_IN_TIMEOUT) => return Err(LumoError::Unavailable("Sign-in took too long. Try again.".into())),
    };
    drop(listener);

    let resp = core
        .http
        .post(format!("{}/user_management/authenticate", cfg.authkit_base))
        .json(&json!({ "client_id": cfg.client_id, "grant_type": "authorization_code", "code": code, "code_verifier": verifier }))
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| LumoError::Unavailable(format!("Could not reach the sign-in service: {e}")))?;
    if !resp.status().is_success() {
        return Err(denied("The sign-in didn't go through. Try again."));
    }
    let body: Value = resp.json().await.map_err(|_| LumoError::Unavailable("The sign-in service sent an unreadable answer.".into()))?;
    let tokens = Tokens::from(&body)?;
    let user = &body["user"];
    let user_id =
        user["id"].as_str().filter(|s| valid_id(s, "user_")).ok_or_else(|| denied("The sign-in service sent an unknown account."))?;

    core.secrets.set(REFRESH_SECRET, &tokens.refresh)?;
    core.account.lock().access = Some((tokens.access, tokens.expires));
    let mut s = core.settings();
    s.account = Some(AccountInfo {
        user_id: user_id.into(),
        email: user["email"].as_str().map(String::from),
        name: name_of(user),
        method: body["authentication_method"].as_str().map(|m| m.chars().take(40).collect()),
        ..Default::default()
    });
    crate::settings::save(&core.db, &s)?;
    crate::audit::record(&core.db, "user", "account_sign_in", s.account.as_ref().and_then(|a| a.email.as_deref()), None, "ok");

    // Bring the plan along. A license key activated on this computer before accounts existed is linked
    // to the account the first time, so nobody loses a plan they paid for.
    let st = refresh(core).await;
    if let (Ok(st), Ok(Some(key))) = (&st, core.secrets.get(crate::license::SECRET)) {
        if st.account.as_ref().is_some_and(|a| !a.license_linked) {
            if let Err(e) = call(core, "link", json!({ "licenseKey": key })).await.and_then(|v| apply(core, &v)) {
                log::warn!("could not link this computer's license to the account: {e}");
            }
        }
    }
    if let Err(e) = st {
        log::warn!("account check after sign-in: {e}");
    }
    Ok(())
}

/// Accept connections on the loopback port until the browser brings back a code for this sign-in.
/// Anything else (other paths, a wrong state) is answered and ignored.
async fn wait_for_code(listener: &TcpListener, state: &str) -> Result<String> {
    loop {
        let (mut sock, _) = listener.accept().await?;
        let mut buf = vec![0u8; 8192];
        let mut n = 0;
        let read = tokio::time::timeout(Duration::from_secs(10), async {
            while n < buf.len() {
                let k = sock.read(&mut buf[n..]).await?;
                if k == 0 {
                    break;
                }
                n += k;
                if buf[..n].windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            std::io::Result::Ok(())
        })
        .await;
        if !matches!(read, Ok(Ok(()))) {
            continue;
        }
        let head = String::from_utf8_lossy(&buf[..n]);
        let target = head.lines().next().and_then(|l| l.strip_prefix("GET ")).and_then(|l| l.split(' ').next()).unwrap_or("");
        let parsed = url::Url::parse(&format!("http://127.0.0.1{target}")).ok().filter(|u| u.path() == "/callback");
        let Some(u) = parsed else {
            let _ = respond(&mut sock, "404 Not Found", "Not found.").await;
            continue;
        };
        let q: std::collections::HashMap<_, _> = u.query_pairs().into_owned().collect();
        if !q.get("state").is_some_and(|s| constant_eq(s.as_bytes(), state.as_bytes())) {
            let _ = respond(&mut sock, "400 Bad Request", "This sign-in link is out of date. Go back to Lumo and try again.").await;
            continue;
        }
        if let Some(code) = q.get("code").filter(|c| !c.is_empty() && c.len() <= 512) {
            let _ = respond(&mut sock, "200 OK", "You’re signed in. You can close this tab and go back to Lumo.").await;
            return Ok(code.clone());
        }
        let _ = respond(&mut sock, "200 OK", "Sign-in was cancelled. You can close this tab and go back to Lumo.").await;
        return Err(LumoError::Cancelled);
    }
}

async fn respond(sock: &mut tokio::net::TcpStream, status: &str, message: &str) -> std::io::Result<()> {
    let body = format!(
        "<!doctype html><meta charset=utf-8><meta name=viewport content=\"width=device-width\"><title>Lumo</title>\
         <body style=\"font:16px system-ui,sans-serif;display:grid;place-items:center;height:90vh;margin:0;color:#1d2340;background:#f6f7fb\">\
         <p style=\"max-width:28em;text-align:center\">{message}</p>"
    );
    let resp = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\n\
         Referrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    sock.write_all(resp.as_bytes()).await?;
    sock.shutdown().await
}

fn constant_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn random_token(bytes: usize) -> String {
    let mut b = vec![0u8; bytes];
    rand::rng().fill_bytes(&mut b);
    B64.encode(b)
}

fn name_of(user: &Value) -> Option<String> {
    let n = [user["first_name"].as_str(), user["last_name"].as_str()].into_iter().flatten().collect::<Vec<_>>().join(" ");
    (!n.trim().is_empty()).then(|| n.trim().chars().take(100).collect())
}

struct Tokens {
    access: String,
    refresh: String,
    expires: i64,
}

impl Tokens {
    fn from(body: &Value) -> Result<Self> {
        let access =
            body["access_token"].as_str().filter(|t| t.len() < 8192).ok_or_else(|| denied("The sign-in service sent no access token."))?;
        let refresh = body["refresh_token"]
            .as_str()
            .filter(|t| t.len() < 4096)
            .ok_or_else(|| denied("The sign-in service sent no refresh token."))?;
        Ok(Tokens {
            access: access.into(),
            refresh: refresh.into(),
            expires: jwt_exp(access).unwrap_or_else(|| chrono::Utc::now().timestamp() + 120),
        })
    }
}

/// The expiry of a JWT, read without checking it (the server checks; this only decides when to refresh).
fn jwt_exp(token: &str) -> Option<i64> {
    let payload = token.split('.').nth(1)?;
    let v: Value = serde_json::from_slice(&B64.decode(payload.trim_end_matches('=')).ok()?).ok()?;
    v["exp"].as_i64()
}

// ---- Tokens and the account server ------------------------------------------------------------------

/// A valid access token, refreshed when it is close to expiring. A refresh token the service refuses
/// signs the person out on this computer; a network problem doesn't.
async fn access_token(core: &Core, force: bool) -> Result<String> {
    let fresh = |core: &Core| {
        let st = core.account.lock();
        st.access.as_ref().filter(|(_, exp)| !force && *exp > chrono::Utc::now().timestamp() + 60).map(|(t, _)| t.clone())
    };
    if let Some(t) = fresh(core) {
        return Ok(t);
    }
    let _guard = REFRESHING.lock().await;
    // Someone else may have refreshed while we waited (refresh tokens rotate, so never refresh twice).
    if let Some(t) = fresh(core).filter(|_| !force) {
        return Ok(t);
    }
    let cfg = config(core).ok_or_else(|| LumoError::Unavailable("Accounts aren't available in this build.".into()))?;
    let refresh = core.secrets.get(REFRESH_SECRET)?.ok_or_else(|| {
        forget(core);
        denied("Sign in to Lumo to continue.")
    })?;
    let resp = core
        .http
        .post(format!("{}/user_management/authenticate", cfg.authkit_base))
        .json(&json!({ "client_id": cfg.client_id, "grant_type": "refresh_token", "refresh_token": refresh }))
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| LumoError::Unavailable(format!("Could not reach the sign-in service: {e}")))?;
    let code = resp.status().as_u16();
    if code == 400 || code == 401 || code == 403 {
        forget(core);
        crate::audit::record(&core.db, "system", "account_session_expired", None, None, "ok");
        return Err(denied("Your sign-in has expired. Sign in again."));
    }
    if !resp.status().is_success() {
        return Err(LumoError::Unavailable(format!("The sign-in service answered with HTTP {code}.")));
    }
    let body: Value = resp.json().await.map_err(|_| LumoError::Unavailable("The sign-in service sent an unreadable answer.".into()))?;
    let t = Tokens::from(&body)?;
    core.secrets.set(REFRESH_SECRET, &t.refresh)?;
    core.account.lock().access = Some((t.access.clone(), t.expires));
    Ok(t.access)
}

/// The model gateway knows people by their account in builds with accounts, once they are signed in.
pub fn uses_account(core: &Core) -> bool {
    config(core).is_some() && core.settings().account.is_some()
}

/// An access token for Lumo's model gateway. `fresh` forces a refresh (after the gateway refused one).
pub async fn gateway_token(core: &Core, fresh: bool) -> Result<String> {
    access_token(core, fresh).await
}

/// Call the account server as the signed-in person.
async fn call(core: &Core, action: &str, extra: Value) -> Result<Value> {
    let cfg = config(core).ok_or_else(|| LumoError::Unavailable("Accounts aren't available in this build.".into()))?;
    let mut body = extra;
    body["action"] = json!(action);
    for attempt in 0..2 {
        let token = access_token(core, attempt > 0).await?;
        let resp = core
            .http
            .post(format!("{}/api/account", cfg.server))
            .bearer_auth(&token)
            .json(&body)
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|e| LumoError::Unavailable(format!("Could not reach Lumo's account server: {e}")))?;
        let code = resp.status().as_u16();
        let out: Value = resp.json().await.unwrap_or_default();
        if code == 401 && attempt == 0 {
            continue;
        }
        let err = out["error"].as_str().unwrap_or("The account server couldn't do that.").to_string();
        return match code {
            200..=299 => Ok(out),
            401 => Err(denied(err)),
            400..=499 => Err(LumoError::Denied(err)),
            _ => Err(LumoError::Unavailable(err)),
        };
    }
    unreachable!()
}

/// Apply an account answer from the server: who they are, two-step, and the plan.
fn apply(core: &Core, v: &Value) -> Result<AccountStatus> {
    let mut s = core.settings();
    let Some(acc) = s.account.as_mut() else { return Ok(status(core)) };
    if v["userId"].as_str().is_some_and(|id| id != acc.user_id) {
        return Err(denied("The account server answered for a different account."));
    }
    if let Some(e) = v["email"].as_str() {
        acc.email = Some(e.into());
    }
    if v.get("name").is_some() {
        acc.name = v["name"].as_str().map(String::from);
    }
    acc.two_step = v["twoStep"] == true;
    acc.license_linked = v["licenseLinked"] == true;
    acc.checked_at = Some(crate::util::now());
    // null means Whop couldn't be asked: keep the plan Lumo already knew.
    if let Some(p @ ("free" | "lite" | "pro")) = v["plan"].as_str() {
        if s.plan != p {
            crate::audit::record(&core.db, "system", "plan_changed", Some(p), None, "ok");
        }
        s.plan = p.into();
        s.plan_checked_at = Some(crate::util::now());
    }
    crate::settings::save(&core.db, &s)?;
    crate::plans::pause_excess_automations(core)?;
    Ok(status(core))
}

/// Ask the account server about the account and its plan.
pub async fn refresh(core: &Core) -> Result<AccountStatus> {
    if core.settings().account.is_none() {
        return Ok(status(core));
    }
    let v = call(core, "status", json!({})).await?;
    apply(core, &v)
}

/// Forget the account on this computer: tokens, the account and the plan that came with it.
fn forget(core: &Core) {
    core.account.lock().access = None;
    let _ = core.secrets.delete(REFRESH_SECRET);
    let _ = core.secrets.delete(crate::license::SECRET);
    let mut s = core.settings();
    s.account = None;
    s.plan = "free".into();
    s.plan_checked_at = None;
    let _ = crate::settings::save(&core.db, &s);
    let _ = crate::plans::pause_excess_automations(core);
}

pub async fn sign_out(core: &Core) -> Result<AccountStatus> {
    if core.settings().account.is_some() {
        // Ending the session on the server is best effort: signing out here must work offline too.
        if let Err(e) = call(core, "sign-out", json!({})).await {
            log::warn!("server sign-out: {e}");
        }
    }
    forget(core);
    crate::audit::record(&core.db, "user", "account_sign_out", None, None, "ok");
    Ok(status(core))
}

/// Delete the account everywhere, after the person confirms in a native dialog.
pub async fn delete(core: &Core) -> Result<AccountStatus> {
    let email = core.settings().account.and_then(|a| a.email).unwrap_or_default();
    let preview = ActionPreview {
        title: "Delete your Lumo account".into(),
        details: vec![("Account".into(), email)],
        warning: Some("This can't be undone. Your plan on Whop isn't cancelled; cancel it on Whop if you no longer want it.".into()),
    };
    if !core.platform.native_confirm(&preview).await {
        return Err(LumoError::Cancelled);
    }
    call(core, "delete", json!({})).await?;
    forget(core);
    crate::audit::record(&core.db, "user", "account_deleted", None, None, "ok");
    Ok(status(core))
}

// ---- Two-step verification and licenses -------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TwoStepSetup {
    /// A data: URL of the QR code to scan.
    pub qr_code: Option<String>,
    /// The same secret as text, for typing into an authenticator app.
    pub secret: String,
}

pub async fn two_step_start(core: &Core) -> Result<TwoStepSetup> {
    let v = call(core, "two-step-start", json!({})).await?;
    let secret =
        v["secret"].as_str().filter(|s| s.len() <= 128).ok_or_else(|| LumoError::Unavailable("Two-step setup didn't start.".into()))?;
    let qr_code = v["qrCode"].as_str().filter(|q| q.starts_with("data:image/") && q.len() < 200_000).map(String::from);
    Ok(TwoStepSetup { qr_code, secret: secret.into() })
}

fn six_digits(code: &str) -> Result<String> {
    let c: String = code.chars().filter(|c| !c.is_whitespace()).collect();
    if c.len() == 6 && c.chars().all(|c| c.is_ascii_digit()) {
        Ok(c)
    } else {
        Err(invalid("Enter the 6-digit code from your authenticator app."))
    }
}

pub async fn two_step_confirm(core: &Core, code: &str) -> Result<AccountStatus> {
    let v = call(core, "two-step-confirm", json!({ "code": six_digits(code)? })).await?;
    crate::audit::record(&core.db, "user", "two_step_on", None, None, "ok");
    apply(core, &v)
}

pub async fn two_step_cancel(core: &Core) -> Result<AccountStatus> {
    let v = call(core, "two-step-cancel", json!({})).await?;
    apply(core, &v)
}

pub async fn two_step_off(core: &Core, code: &str) -> Result<AccountStatus> {
    let v = call(core, "two-step-off", json!({ "code": six_digits(code)? })).await?;
    crate::audit::record(&core.db, "user", "two_step_off", None, None, "ok");
    apply(core, &v)
}

/// Link a Whop license key to the signed-in account.
pub async fn link_license(core: &Core, key: &str) -> Result<AccountStatus> {
    if core.settings().account.is_none() {
        return Err(denied("Sign in to Lumo to add a plan."));
    }
    let v = call(core, "link", json!({ "licenseKey": key })).await?;
    apply(core, &v)
}

pub async fn unlink_license(core: &Core) -> Result<AccountStatus> {
    let v = call(core, "unlink", json!({})).await?;
    apply(core, &v)
}

/// Re-check the account now and then while Lumo runs, so plan changes (renewals, cancellations, an
/// upgrade on another computer) arrive without signing in again.
pub async fn keep_checking(core: Arc<Core>) {
    tokio::time::sleep(Duration::from_secs(5)).await;
    loop {
        if config(&core).is_some() && core.settings().account.is_some() {
            match refresh(&core).await {
                Ok(_) => core.platform.broadcast("settings-changed", Value::Null),
                Err(e) => {
                    log::warn!("account check: {e}");
                    // A refused sign-in signs out here; the windows show the sign-in screen again.
                    if core.settings().account.is_none() {
                        core.platform.broadcast("settings-changed", Value::Null);
                    }
                }
            }
        }
        tokio::time::sleep(RECHECK_EVERY).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::testing::{core_with, FakePlatform};
    use wiremock::matchers::{body_partial_json, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn jwt(exp: i64) -> String {
        format!("h.{}.s", B64.encode(json!({ "sub": "user_01ABC", "exp": exp }).to_string()))
    }

    fn setup(server: &MockServer) -> (Arc<Core>, Arc<FakePlatform>, tempfile::TempDir) {
        let platform = Arc::new(FakePlatform::default());
        let (core, dir) = core_with(platform.clone());
        core.account.lock().config =
            Some(AccountConfig { client_id: "client_TEST".into(), authkit_base: server.uri(), server: server.uri() });
        (core, platform, dir)
    }

    async fn mock_tokens(server: &MockServer, access: &str) {
        Mock::given(method("POST"))
            .and(path("/user_management/authenticate"))
            .and(body_partial_json(json!({ "grant_type": "authorization_code", "code": "CODE123", "client_id": "client_TEST" })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "access_token": access, "refresh_token": "REFRESH1", "authentication_method": "GoogleOAuth",
                "user": { "id": "user_01ABC", "email": "ada@example.com", "first_name": "Ada" }
            })))
            .mount(server)
            .await;
    }

    async fn mock_account(server: &MockServer, action: &str, body: Value) {
        Mock::given(method("POST"))
            .and(path("/api/account"))
            .and(body_partial_json(json!({ "action": action })))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .mount(server)
            .await;
    }

    fn account_body(plan: &str, linked: bool) -> Value {
        json!({ "userId": "user_01ABC", "email": "ada@example.com", "name": "Ada", "twoStep": false, "licenseLinked": linked, "plan": plan })
    }

    /// Start a sign-in and play the browser: wait for the page to open, then come back to the loopback port.
    async fn browser_sign_in(core: &Arc<Core>, platform: &FakePlatform, mode: &str) -> Result<AccountStatus> {
        let c = core.clone();
        let mode = mode.to_string();
        let task = tokio::spawn(async move { sign_in(&c, &mode).await });
        let opened = loop {
            if let Some(u) = platform.opened.lock().last().cloned() {
                break u;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        };
        let url = url::Url::parse(&opened).unwrap();
        let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["code_challenge"].len(), 43);
        assert!(q["redirect_uri"].ends_with("/api/auth/callback"));
        let state = q["state"].clone();
        let port: u16 = state.rsplit('.').next().unwrap().parse().unwrap();
        let http = reqwest::Client::new();
        // Someone else knocking on the port, or a stale link, doesn't end the sign-in.
        let r = http.get(format!("http://127.0.0.1:{port}/callback?code=EVIL&state=wrong.{port}")).send().await.unwrap();
        assert_eq!(r.status(), 400);
        let r = http.get(format!("http://127.0.0.1:{port}/favicon.ico")).send().await.unwrap();
        assert_eq!(r.status(), 404);
        let r = http.get(format!("http://127.0.0.1:{port}/callback?code=CODE123&state={state}")).send().await.unwrap();
        assert_eq!(r.status(), 200);
        assert!(r.text().await.unwrap().contains("signed in"));
        platform.opened.lock().clear();
        task.await.unwrap()
    }

    #[tokio::test]
    async fn sign_in_brings_the_plan_and_sign_out_forgets_it() {
        let server = MockServer::start().await;
        let (core, platform, _dir) = setup(&server);
        let access = jwt(chrono::Utc::now().timestamp() + 3600);
        mock_tokens(&server, &access).await;
        Mock::given(method("POST"))
            .and(path("/api/account"))
            .and(header("authorization", format!("Bearer {access}").as_str()))
            .and(body_partial_json(json!({ "action": "status" })))
            .respond_with(ResponseTemplate::new(200).set_body_json(account_body("pro", true)))
            .mount(&server)
            .await;
        mock_account(&server, "sign-out", json!({ "signedOut": true })).await;

        let st = status(&core);
        assert!(st.configured && !st.signed_in);
        assert!(require_signed_in(&core).is_err(), "Lumo needs an account in builds with accounts");

        let st = browser_sign_in(&core, &platform, "google").await.unwrap();
        assert!(st.signed_in);
        let acc = st.account.unwrap();
        assert_eq!((acc.email.as_deref(), acc.method.as_deref(), acc.license_linked), (Some("ada@example.com"), Some("GoogleOAuth"), true));
        assert!(st.recommend_passkey && st.recommend_two_step);
        assert_eq!(core.settings().plan, "pro");
        assert_eq!(core.secrets.get(REFRESH_SECRET).unwrap().as_deref(), Some("REFRESH1"));
        require_signed_in(&core).unwrap();
        assert!(crate::license::status(&core).has_key);

        let st = sign_out(&core).await.unwrap();
        assert!(!st.signed_in);
        assert_eq!(core.settings().plan, "free");
        assert_eq!(core.secrets.get(REFRESH_SECRET).unwrap(), None);
        assert!(require_signed_in(&core).is_err());
    }

    #[tokio::test]
    async fn the_model_gateway_is_told_who_is_signed_in() {
        let server = MockServer::start().await;
        let (core, platform, _dir) = setup(&server);
        let access = jwt(chrono::Utc::now().timestamp() + 3600);
        mock_tokens(&server, &access).await;
        mock_account(&server, "status", account_body("pro", false)).await;
        Mock::given(method("GET"))
            .and(path("/api/usage"))
            .and(header("authorization", format!("Bearer {access}").as_str()))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({ "plan": "pro", "percentUsed": 5, "resetsAt": "2026-11-01T00:00:00Z" })),
            )
            .mount(&server)
            .await;
        core.endpoints.lock().lumo_api = Some(server.uri());
        assert!(!uses_account(&core));
        browser_sign_in(&core, &platform, "google").await.unwrap();
        assert!(uses_account(&core));
        assert_eq!(crate::models::usage(&core).await.unwrap().percent_used, 5);
        assert_eq!(core.provider().unwrap().name(), "lumo");
    }

    #[tokio::test]
    async fn an_old_license_on_this_computer_is_linked_to_the_account() {
        let server = MockServer::start().await;
        let (core, platform, _dir) = setup(&server);
        mock_tokens(&server, &jwt(chrono::Utc::now().timestamp() + 3600)).await;
        mock_account(&server, "status", account_body("free", false)).await;
        Mock::given(method("POST"))
            .and(path("/api/account"))
            .and(body_partial_json(json!({ "action": "link", "licenseKey": "mem_OLD_00001" })))
            .respond_with(ResponseTemplate::new(200).set_body_json(account_body("lite", true)))
            .expect(1)
            .mount(&server)
            .await;
        core.secrets.set(crate::license::SECRET, "mem_OLD_00001").unwrap();
        browser_sign_in(&core, &platform, "email").await.unwrap();
        assert_eq!(core.settings().plan, "lite");
        assert!(core.settings().account.unwrap().license_linked);
    }

    #[tokio::test]
    async fn a_refused_refresh_signs_out_but_being_offline_does_not() {
        let server = MockServer::start().await;
        let (core, platform, _dir) = setup(&server);
        // An access token that is about to expire, so the next call refreshes.
        mock_tokens(&server, &jwt(chrono::Utc::now().timestamp() + 10)).await;
        mock_account(&server, "status", account_body("pro", true)).await;
        Mock::given(method("POST"))
            .and(path("/user_management/authenticate"))
            .and(body_partial_json(json!({ "grant_type": "refresh_token", "refresh_token": "REFRESH1" })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "access_token": jwt(chrono::Utc::now().timestamp() + 3600), "refresh_token": "REFRESH2", "user": { "id": "user_01ABC" }
            })))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/user_management/authenticate"))
            .and(body_partial_json(json!({ "grant_type": "refresh_token" })))
            .respond_with(ResponseTemplate::new(400).set_body_json(json!({ "error": "invalid_grant" })))
            .mount(&server)
            .await;
        browser_sign_in(&core, &platform, "sign_up").await.unwrap();
        assert_eq!(core.secrets.get(REFRESH_SECRET).unwrap().as_deref(), Some("REFRESH2"), "refresh tokens rotate");
        assert_eq!(core.settings().plan, "pro");

        // Offline: the plan and the account stay.
        core.account.lock().access = None;
        core.account.lock().config.as_mut().unwrap().authkit_base = "http://127.0.0.1:9".into();
        assert!(matches!(refresh(&core).await, Err(LumoError::Unavailable(_))));
        assert!(core.settings().account.is_some());
        assert_eq!(core.settings().plan, "pro");

        // The service refuses the refresh token (revoked, or the account was deleted): signed out here.
        core.account.lock().config.as_mut().unwrap().authkit_base = server.uri();
        assert!(matches!(refresh(&core).await, Err(LumoError::Denied(_))));
        assert!(core.settings().account.is_none());
        assert_eq!(core.settings().plan, "free");
    }

    #[tokio::test]
    async fn two_step_and_license_calls_go_to_the_account_server() {
        let server = MockServer::start().await;
        let (core, platform, _dir) = setup(&server);
        mock_tokens(&server, &jwt(chrono::Utc::now().timestamp() + 3600)).await;
        mock_account(&server, "status", account_body("free", false)).await;
        mock_account(
            &server,
            "two-step-start",
            json!({ "secret": "JBSWY3DP", "qrCode": "data:image/png;base64,AA", "uri": "otpauth://x" }),
        )
        .await;
        Mock::given(method("POST"))
            .and(path("/api/account"))
            .and(body_partial_json(json!({ "action": "two-step-confirm", "code": "123456" })))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({ "userId": "user_01ABC", "twoStep": true, "licenseLinked": false, "plan": "free" })),
            )
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/api/account"))
            .and(body_partial_json(json!({ "action": "link" })))
            .respond_with(
                ResponseTemplate::new(409).set_body_json(json!({ "error": "This license is already linked to another Lumo account." })),
            )
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/api/account"))
            .and(body_partial_json(json!({ "action": "delete" })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "deleted": true })))
            .mount(&server)
            .await;

        // Without an account, plans can't be added.
        assert!(crate::license::activate(&core, None, "mem_PRO_00001").await.is_err());
        browser_sign_in(&core, &platform, "google").await.unwrap();

        let setup = two_step_start(&core).await.unwrap();
        assert_eq!((setup.secret.as_str(), setup.qr_code.is_some()), ("JBSWY3DP", true));
        assert!(two_step_confirm(&core, "12345").await.is_err());
        let st = two_step_confirm(&core, "123 456").await.unwrap();
        assert!(st.account.unwrap().two_step);
        assert!(!status(&core).recommend_two_step);

        let err = crate::license::activate(&core, None, "mem_PRO_00001").await.unwrap_err().to_string();
        assert!(err.contains("another Lumo account"), "{err}");

        // Deleting needs the native confirmation.
        *platform.confirm.lock() = false;
        assert!(matches!(delete(&core).await, Err(LumoError::Cancelled)));
        assert!(core.settings().account.is_some());
        *platform.confirm.lock() = true;
        assert!(!delete(&core).await.unwrap().signed_in);
    }

    #[tokio::test]
    async fn a_new_sign_in_or_cancel_ends_the_waiting_one() {
        let server = MockServer::start().await;
        let (core, platform, _dir) = setup(&server);
        let c = core.clone();
        let first = tokio::spawn(async move { sign_in(&c, "google").await });
        while platform.opened.lock().is_empty() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(status(&core).signing_in);
        cancel_sign_in(&core);
        assert!(matches!(first.await.unwrap(), Err(LumoError::Cancelled)));
        assert!(!status(&core).signing_in);
        assert!(sign_in(&core, "facebook").await.is_err());
    }

    #[test]
    fn reads_token_expiry_and_checks_ids() {
        assert_eq!(jwt_exp(&jwt(1234)), Some(1234));
        assert_eq!(jwt_exp("not-a-jwt"), None);
        assert!(valid_id("client_01ABC", "client_") && !valid_id("client_../x", "client_") && !valid_id("user_1", "client_"));
        assert!(constant_eq(b"abc", b"abc") && !constant_eq(b"abc", b"abd") && !constant_eq(b"ab", b"abc"));
    }
}
