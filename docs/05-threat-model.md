# Threat model

Date: 2026-10-16. Scope: the Lumo desktop app (`apps/desktop`) and the license service
(`services/license`). The marketing site (`apps/web`) is static and out of scope. This is an internal
review. No external penetration test has been done yet.

Paths are relative to `apps/desktop/src-tauri/src` unless they say otherwise.

## 1. Assets

| Asset                                                                                           | Where it lives                                                   | Why it matters                                                          |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Provider keys and tokens (Anthropic, OpenAI-compatible, speech-to-text, Brave, GitHub, Netlify) | OS keychain, `secrets.rs`                                        | Can be used to spend money or to act as the user on GitHub or Netlify.  |
| Whop license key                                                                                | OS keychain (`whop_license_key`, `license.rs`)                   | Unlocks a paid plan.                                                    |
| Database key                                                                                    | OS keychain (`database_key`, `db.rs`)                            | Decrypts every conversation, memory and audit entry.                    |
| Conversations, memories, audit log, file journal                                                | SQLCipher database in the app data folder (`db.rs`)              | Personal data.                                                          |
| The user's files                                                                                | Folders the user granted (`policy.rs`)                           | Can be read, changed, moved to the Trash, or uploaded.                  |
| The user's session (screen, mouse and keyboard, clipboard)                                      | `tools/system.rs`, `tools/computer.rs`, `tools/clipboard.rs`     | Full control of the desktop while computer control is on.               |
| Ability to run programs                                                                         | `tools/shell.rs`                                                 | Allowlisted programs run with the user's own permissions.               |
| Whop API key                                                                                    | License server environment only (`services/license/validate.js`) | Can read Whop memberships and member emails. It never ships in the app. |

## 2. Trust boundaries

1. **Webview ↔ Rust core (IPC).** The React UI is untrusted. It reaches Rust only through the commands
   listed in `lib.rs` (`generate_handler!`) and the core permissions in `capabilities/default.json`.
   Plugins (dialog, opener, clipboard, notification, global shortcut, updater) are driven from Rust only.
2. **Model output ↔ tool execution.** A tool call from the model is a request. `tools::execute`
   (`tools/mod.rs`) parses it into a typed struct (`deny_unknown_fields`), runs `authorize`, and only then
   runs the tool.
3. **External content ↔ model context.** Web pages, files, clipboard text, command output, place listings
   and attachments are wrapped by `tools::wrap_untrusted` before they reach the model.
4. **Project preview ↔ app.** Project files are served by the `preview:` protocol (`desktop.rs`
   `preview_response`) into a sandboxed iframe.
5. **App ↔ network.** Model providers, integrations, OpenStreetMap and `fetch_url`. Keys are attached in
   Rust only.
6. **App ↔ license server ↔ Whop.**
7. **Lumo ↔ other local software.** Same user account, same machine.

## 3. Attackers and what stops them

### 3.1 A malicious web page, document or file (prompt injection)

The attacker controls text that Lumo reads: a page from `fetch_url` or web search, a file in a granted
folder, an attachment, clipboard text, command output, or text on the screen during computer control. Their
goal is to make Lumo act against the user.

Mitigations as implemented:

- Tool results are wrapped in `<untrusted_content>` and a closing tag inside the content is neutralized
  (`tools/mod.rs` `wrap_untrusted`, test `untrusted_content_cannot_close_its_wrapper`). The system prompt
  says such content has no authority (`agent/prompt.rs`).
- Permissions are never expressed in the context. `authorize` (`tools/mod.rs`) decides from the tool's tier:
  - Write calls wait for an in-app approval. "Allow for this conversation" applies to write tools only.
  - Sensitive calls (run a command, publish, deploy, checkout or sign-in pages, more than 20 items to the
    Trash, screen capture without a grant, the first computer-control call) show a native OS dialog with
    the exact parameters (`desktop.rs` `TauriPlatform::native_confirm`). The webview cannot draw, change
    or answer this dialog.
- Automations (`automations.rs`) get read and UI tools, plus the write tools the user listed when saving
  the automation (`ALLOWABLE_WRITE_TOOLS`). Sensitive calls are refused and the run is marked needs
  attention. `ask_user` and `request_folder_access` are refused too.
- File access is limited to granted folders. `policy::resolve_in_grants` canonicalizes the longest
  existing prefix, so `..` and symlinks cannot escape a grant (tests `paths_must_stay_inside_grants` and
  `symlinks_cannot_escape_a_grant`). Credential and system locations are refused even inside a grant
  (`policy::is_protected`). Since this review, startup scripts, git hooks, autostart entries and
  credential files are refused too (`policy::runs_automatically`, see section 4).
- Per-run action limit (default 40), a 60-turn cap, and 30 calls per minute per tool (`agent/mod.rs`,
  `tools/mod.rs`).
- `run_command` allows only listed programs, passes arguments without a shell, refuses inline code
  (`-e`, `-c` and similar), removes secret-looking variables from the environment, and has a timeout
  (`tools/shell.rs`).

### 3.2 Compromised model output

This covers a malicious or broken provider, a man-in-the-middle on a custom gateway, or a model that has
been successfully injected. Mitigations are the same as in 3.1. Model output is only parsed into typed
tool calls, and a truncated or invalid tool input is answered with an error and never run
(`tools/mod.rs`, `__lumo_invalid_input`; test `invalid_and_unknown_calls_never_run`). Only tools frozen
into the conversation can be called.

### 3.3 A compromised webview

This covers an XSS bug in the UI, a malicious dependency in the frontend bundle, or a preview page that
escapes its sandbox.

- The CSP (`tauri.conf.json`) allows scripts only from the app itself. `connect-src` allows only IPC.
  Frames are allowed only from `preview:`. The prototype is frozen.
- No secret is ever returned over IPC: there are `secrets_status` (presence only), `set_secret` and
  `delete_secret`, and nothing else (`commands.rs`). `set_secret` and `delete_secret` accept only known
  names (`secrets::check_known`).
- Attachments are opaque tokens for files the user picked or dropped (`commands.rs`
  `register_attachment`, `core.rs` `Pending::attachments`). The webview cannot name an arbitrary path.
- The project editor (`read_project_file` and `write_project_file`) resolves paths inside the project and
  refuses `..` and `.git` (`commands.rs` `project_path`).
- The webview cannot change the plan: `save_settings` keeps the stored plan (`commands.rs`).
- Since this review, `save_settings` asks for native confirmation before a saved key would be sent to a
  new origin (`settings.rs` `confirm_key_destinations`). The webview can also no longer use the Tauri
  core defaults for trays, menus, image reads or window listing (`capabilities/default.json`).
- Sensitive actions still need the native dialog.

What a compromised webview **can** still do (by design, or not yet addressed): answer write-tier approval
cards; request the `screen`, `clipboard_read` and `active_window` capabilities (`grant_capability`, which now
needs the native dialog); start runs with any text; create automations with the allowable write tools; write
any content into Lumo project files (`write_project_file`); undo runs; open any https URL in the browser
(`open_external_url`); replace a stored key with one of its own (`set_secret`); and capture any key the
user types into it.

### 3.4 Local malware running as the same user

Out of scope as an adversary we can stop: it can read the keychain items the app can read, attach a
debugger, send synthetic input, or replace the app binary. What Lumo does provide:

- Secrets and the database key are kept in the OS keychain. There is no plaintext fallback (`secrets.rs`).
- The database is encrypted at rest with SQLCipher (`db.rs`).
- Lumo's own data folder (`one.keplar.lumo`) is refused as a grant target (`policy::is_protected`), so
  the agent cannot read its own database or backups through file tools.

### 3.5 A network attacker

- All provider and integration traffic uses HTTPS (rustls). `settings::check_endpoint` refuses plain HTTP
  except to localhost. The on-device runtime must be local.
- `fetch_url` refuses non-public addresses on every redirect hop (`tools/web.rs`). Since this review,
  it connects only to the addresses it checked (no second DNS lookup) and also refuses IPv6 forms that
  carry an internal IPv4 address (see section 4).
- Updates are signature-checked by the Tauri updater. The updater is compiled in only when the release
  build has `LUMO_UPDATER_PUBKEY` (`lib.rs`, `docs/release.md`).

### 3.6 A stolen or shared license key

The license server checks that the key maps to an active Whop membership on a Lumo plan
(`services/license/validate.js`). The app stores the key in the keychain and the resulting plan in the
encrypted settings.

In builds with accounts, a key is linked to exactly one Lumo account on the server (`services/license/accounts.js`),
so a shared key can't be used by a second account. The link index is named by the key's SHA-256 and kept in a
private Blob store; keys never appear in file names or responses.

### 3.7 Account takeover and the sign-in flow

- Sign-in runs in the system browser on WorkOS AuthKit's hosted page (passwords, Google, passkeys, two-step codes);
  Lumo never sees a password. The core uses PKCE (RFC 8252); the code that passes through the https callback
  (`api/auth/callback.js`) is useless without the verifier, which never leaves the core. The callback only ever
  redirects to `127.0.0.1` on a port from 1024 to 65535 named in `state`, and the core checks `state` in constant time.
- The refresh token lives only in the OS keychain and the access token only in memory; the webview gets neither.
  Refresh tokens rotate, and refreshes are serialized so two calls never spend the same one.
- The account server verifies every access token's signature against the client's WorkOS keys before any lookup.
- Two-step: a factor counts only after it is proven with a code; an unconfirmed one is deleted on cancel or after
  15 minutes, so an abandoned setup can't lock anyone out. Turning it off needs a current code, so a stolen access
  token alone can't remove it. Account deletion needs a native confirmation dialog.
- Signing in is enforced in the core (`agent::prepare`), not only by the sign-in screen.
- Residual: passkeys and two-step are optional. Passkeys are bound to the AuthKit domain; moving to a custom domain
  later means re-enrolling them.

## 4. Fixed in this review

| Issue                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Severity                  | Fix                                                                                                                                                                                                      | Regression test                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| A compromised webview could point `anthropic_base_url`, `openai_base_url` or `stt_base_url` at any https host. The saved key would then be sent there on the next request or connection test.                                                                                                                                                                                                                                                                                                               | High                      | `save_settings` validates first. It then asks for native confirmation when an endpoint's origin changes and its key is stored (`settings.rs` `confirm_key_destinations`, `commands.rs` `save_settings`). | `settings::tests::sending_a_saved_key_to_a_new_address_needs_native_confirmation` |
| Writing to files that run automatically (`~/.zshrc`, `.bashrc`, `.profile`, `.git/hooks/*`, `~/.config/autostart`, systemd user units, `~/Library/LaunchAgents`, the Windows Startup folder) needed only a write-tier approval, or none after "allow for this conversation". That turns a file write into code execution without the native dialog that `run_command` needs. Credential files (`.netrc`, `.git-credentials`, `.npmrc`, `.pypirc`, `.gitconfig`) were readable inside a granted home folder. | High                      | `policy::runs_automatically` refuses them inside any grant, comparing path components and ignoring case.                                                                                                 | `policy::tests::startup_scripts_hooks_and_credentials_are_refused_inside_a_grant` |
| DNS rebinding in `fetch_url`: the host was resolved for the check, then resolved again by reqwest to connect.                                                                                                                                                                                                                                                                                                                                                                                               | Medium                    | `web::resolve_public` returns the checked addresses, and each hop pins them with `resolve_to_addrs`.                                                                                                     | `tools::web::tests::resolved_addresses_are_returned_for_pinning`                  |
| `is_public` accepted NAT64 (`64:ff9b::/96`), 6to4 (`2002::/16`) and IPv4-compatible IPv6 forms of internal addresses, plus site-local, documentation and `192.0.0.0/24` addresses.                                                                                                                                                                                                                                                                                                                          | Medium                    | Embedded IPv4 addresses are checked, and the extra ranges are refused.                                                                                                                                   | `tools::web::tests::ipv6_forms_of_internal_ipv4_addresses_are_not_public`         |
| `preview:` is a protocol Lumo registers itself, so Tauri treats it as a local origin with full IPC. Only the webview's iframe `sandbox` attribute stopped a preview page from navigating the top window into `preview:` and getting the IPC bridge.                                                                                                                                                                                                                                                         | Medium (defense in depth) | Every preview response now carries `sandbox allow-scripts allow-forms` in its CSP, set from Rust (`desktop.rs` `PREVIEW_CSP`).                                                                           | `desktop::tests::previews_are_sandboxed_without_top_navigation_or_same_origin`    |
| `core:default` gave the webview tray creation and removal (so it could spoof or hide the "Lumo is using your mouse and keyboard" indicator), menu creation, `image:from_path` (reads image files by path) and window or webview listing.                                                                                                                                                                                                                                                                    | Low                       | `capabilities/default.json` lists only the event and window permissions the UI uses.                                                                                                                     | Checked by `tauri-build` at compile time.                                         |

## 5. Residual risks and known gaps

Stated plainly, highest first.

1. **Read-tier exfiltration.** `fetch_url` (and the Anthropic `web_fetch` and `web_search` server tools)
   runs without approval. An injected instruction can make the model put file contents or memories into a
   URL query string and send it to an attacker's server. Defenses today are the untrusted wrapping and the
   model following the system prompt. Options: approve `fetch_url` when the URL did not come from the user
   or a search result, cap query-string length, or ask before the first fetch to a new domain in a run
   that has read local files.
2. **"Allow for this conversation" stays open.** After one approval, every later call to that write tool
   in the conversation runs without asking, including calls triggered by content read afterwards. The
   protected-path list limits the worst outcomes, but files in granted folders can still be overwritten
   (backups exist, and the change can be undone).
3. **Computer control after the first approval.** Later `control_computer` calls in the run are UI tier
   (`tools/computer.rs` `risk`). They are not confirmed or audited one by one, and screenshots are not
   marked untrusted. Text on screen can steer what Lumo types: it could open a terminal and type commands.
   The stop shortcut and the banner are the user's control.
4. **Wayland.** Synthetic input and screen capture may fail or behave differently on Wayland compositors.
   The stop shortcut depends on global-shortcut support. Computer control is only tested on X11.
5. **Memory poisoning.** `remember` is UI tier in conversations, so injected content the user is looking at
   could still store a "memory" that appears in later turns. In automations it is now write tier and
   therefore refused (`tools/memory.rs`). Memory is off by default, and every item is visible and deletable
   in Settings.
6. **What a compromised webview can still do.** See 3.3: approve write cards, plant code in project files that a later approved `run_command` (for example
   `npm install`) runs, replace keys, and capture keys as the user types them. A tighter CSP and
   dependency hygiene are the main defense. Moving capability grants behind the native dialog is a small
   follow-up.
7. **`run_command` is not a sandbox.** Approved commands run with the user's permissions. Allowlisted
   tools can still run code through arguments the inline-code check misses (`npm exec`, `npx`-style
   flags, `node script.js` that the model just wrote, `pip install` of a malicious package, `git -c`
   options). The native dialog shows the exact command, and that is the real control.
8. **Undo is not change-aware.** `journal::undo_run` restores an `overwrite_file` backup, or trashes a
   created file, even if the user edited it after Lumo did. `std::fs::copy` follows a symlink placed at
   the path afterwards (`tools/journal.rs`). The code comment says "never overwrites anything that
   changed since", which is not true yet. Suggested: store a hash in the journal and skip entries whose
   file changed.
9. **`fetch_url` behind a system proxy.** When `HTTPS_PROXY` is set, reqwest connects through the proxy
   by host name, so pinning does not apply and the proxy's own resolution decides.
10. **Unsigned builds.** Until code-signing certificates exist (Apple Developer ID with notarization,
    Windows Authenticode), users cannot verify downloads, and OS protections such as Gatekeeper or
    SmartScreen will warn. The updater stays off unless a signing key is configured.
11. **License service.**
    - No rate limiting, so keys can be brute-forced against the endpoint. Add Vercel firewall or edge rate
      limits per IP.
    - No hardware ID binding or activation count, so one key works on any number of machines.
    - The plan is checked only at activation and never re-validated. A refunded or cancelled membership
      keeps its plan offline indefinitely.
    - Plan limits (usage, models, automations, computer control) are enforced in the Rust core
      (`plans.rs`), so a compromised webview cannot bypass them, but a modified build or an edited local
      database can; server-side metering is needed if Lumo ever pays for cloud usage itself.
    - A non-JSON answer from Whop returns a clean 502. Whop's status is echoed back as `membershipStatus`.
    - The service never logs the license key or the Whop key. Its error messages contain no secrets.
12. **Audit log content.** Write and sensitive tool inputs are stored in full in the encrypted audit log.
    This includes file contents for `write_file` and clipboard text for `write_clipboard`. It is not a
    secret leak, but anyone with the database key can read it.
13. **No external penetration test** and no fuzzing of the tool input parsers yet.
14. **Capability grants.** A grant turns `take_screenshot` from sensitive into read (and therefore allowed
    in automations), and `read_clipboard` into read. `grant_capability` now requires the native dialog, so
    a compromised webview cannot grant one silently.

## 6. Checks to keep

- `cargo test --lib` covers grant escapes, symlinks, protected and autorun paths, approvals, automation
  refusals, the untrusted wrapper, SSRF ranges, preview sandboxing and confirmation of key endpoints.
- CI runs `cargo audit` and a gitleaks secret scan (`.github/workflows/ci.yml`). A manual scan of the
  working tree and the full git history on 2026-10-16 found no committed keys or tokens.
- Logs: `log::` calls record error messages and counts, never keys or message content
  (`error.rs`, `model/anthropic.rs`, `automations.rs`). The `Anthropic` struct holding the key does not
  derive `Debug`.
