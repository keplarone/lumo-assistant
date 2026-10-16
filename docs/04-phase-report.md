# Lumo 0.1.0 phase report

Status: **pre-release (preview)**. The builds are unsigned, and live calls to Claude have not been run from the
build environment because it has no Anthropic API key. Nothing here should be read as production-ready until the
items under "Needs the owner" and "Not done" are closed.

## Implemented and tested

| Area          | What exists                                                                                                                                                                                                                                                                                                                                          | Evidence                                                                         |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Rust core     | Agent loop (understand, plan, act, verify, report), append-only history, typed tools with risk tiers, approvals at the execution boundary, native dialogs for sensitive actions, SQLCipher database with the key in the OS keychain, audit log, undo journal                                                                                         | 62 unit and end-to-end tests (`cargo test --lib`), clippy `-D warnings`, rustfmt |
| Tools         | Files (granted folders only), web fetch with SSRF and DNS-rebinding defenses, places (OpenStreetMap), checkout handoff (never places orders), clipboard, notifications, screenshots, computer control with Alt+Shift+Escape stop, memory, projects with git history and sandboxed preview, allowlisted commands, GitHub and Netlify publishing, mood | Same suite; publishing tested against mock servers and a local bare repo         |
| Models        | Anthropic Messages API (Claude Opus 5.5 default), OpenAI-compatible endpoints, and free on-device models Orbit 3.8, Nebula 4.2, Solar 5.4 and Nova 5.5 (Apache-2.0 open models through Ollama)                                                                                                                                                       | Mocked in tests; on-device runtime calls tested against a mock Ollama            |
| Plans         | Free, Lumo Lite $19.99/month, Lumo Pro $49.99/month, Lumo Unlimited $124.99/month; Whop checkout pages for each paid plan; license activation through `services/license`; limits enforced in the Rust core (see "Plan limits" below)                                                                                                                 | Rust and Node tests with mocked Whop; Rust tests per limit                       |
| Companion     | Warm, playful owl personality with fixed limits: says it is an AI and not a therapist, gives crisis lines (988, Samaritans, local emergency numbers), encourages real-world support, keeps feelings out of memory unless asked                                                                                                                       | System prompt (`agent/prompt.rs`); behavior with a live model not yet evaluated  |
| Desktop UI    | Chat with live plan, approvals and timeline; projects with editor and preview; automations; settings for models, plans, help, privacy, about; computer-control Stop banner; voice input; compact window                                                                                                                                              | 46 unit tests, 11 Playwright screen tests, typecheck, ESLint, Prettier           |
| Mascot        | The established Lumo owl, ported exactly, with product states and reduced-motion support                                                                                                                                                                                                                                                             | 21 unit tests, 39 visual parity tests                                            |
| Website       | One download page for lumo.keplar.one with OS detection (no download links until a version is published), privacy, terms, licenses; old routes redirect                                                                                                                                                                                              | 9 unit tests, 53 Playwright tests, astro check                                   |
| Security      | Threat model (`docs/05-threat-model.md`); strict CSP and least-privilege Tauri capabilities; key-destination changes need native confirmation; startup scripts and credential files refused; secret scanning, `cargo audit` and `pnpm audit` in CI                                                                                                   | Regression test per fix                                                          |
| App smoke run | Debug build starts under Xvfb, migrates the encrypted database, writes its log                                                                                                                                                                                                                                                                       | Local run                                                                        |

## Plan limits

All limits live in one table, `PLANS` in `apps/desktop/src-tauri/src/plans.rs`, and are enforced in the Rust core.
The webview only displays them (`plan_usage`).

| Plan           | Model usage per month (input + output tokens) | On-device models                 | Cloud providers | Active automations | Computer control |
| -------------- | --------------------------------------------- | -------------------------------- | --------------- | ------------------ | ---------------- |
| Free           | 1,000,000                                     | Orbit 3.8, Nebula 4.2            | No              | 1                  | No               |
| Lumo Lite      | 30,000,000 (30× Free)                         | All (Orbit, Nebula, Solar, Nova) | Yes             | 10                 | Yes              |
| Lumo Pro       | 150,000,000 (150× Free)                       | All                              | Yes             | No limit           | Yes              |
| Lumo Unlimited | No limit (usage is still counted and shown)   | All                              | Yes             | No limit           | Yes              |

- **Usage** is counted after every model call from the provider's reported tokens (an estimate of about four
  characters per token when none are reported) and stored per local calendar month in the encrypted database
  (`migrations/002_plan_usage.sql`). It resets at local midnight on the 1st. A new run, and every model call within
  a run, is refused once the month's allowance is used up; a call already streaming always finishes. The refusal
  says when usage resets and what upgrading gives; chat shows it with an Upgrade button (Whop checkout), and a nudge
  appears from 80%.
- **Models:** choosing a model or provider the plan doesn't include is refused (`select_local_model`,
  `save_settings`), and so is running with one (`agent::prepare`, `Core::provider`), so an old setting or an old
  conversation can't bypass it after a downgrade.
- **Automations:** turning on more than the plan allows is refused. After a downgrade (and at startup, and on each
  scheduler tick) the newest automations beyond the limit are turned off, never deleted.
- **Computer control:** `control_computer` is refused on Free before any permission dialog appears.
- **Limits of on-device enforcement:** all of this runs on the user's computer, so a modified build (or a changed
  database or system clock) could bypass it. That is acceptable while the user pays for every model call (their own
  API key or hardware). If Lumo ever pays for cloud usage itself, usage must be metered on a server.

## Needs the owner

- **Licensing:** the license server is deployed at `https://lumo-license.vercel.app/api/validate` with the owner's
  `WHOP_API_KEY` set as a sensitive production variable, and release builds point at it. A real purchase and
  activation has not been tried yet. The key that was pasted in chat earlier must be revoked in Whop.
- **Signing:** Apple Developer ID and notarization, a Windows code-signing certificate, and an updater key pair
  (`docs/release.md`). Without them macOS and Windows warn on install and auto-update is off.
- **DNS** for lumo.keplar.one pointing at the hosted download page.
- **An Anthropic API key** to run live end-to-end checks of the agent with Claude.

## Not done or not verified

- Live runs against Claude and against real Ollama models; the companion behavior with a live model.
- Whop checkout URL form `whop.com/checkout/<plan>` could not be fetched from the build environment; the
  store-specific URL can be set at build time.
- Computer control and screen capture on Wayland, macOS and Windows have not been run on real machines.
- Webview IPC under the stricter capabilities is covered by mocked UI tests and a smoke start, not a full
  driven end-to-end run.
- Open risks listed in `docs/05-threat-model.md` (read-tier exfiltration through URLs, standing per-conversation
  approvals, computer-control calls after the first approval, no external penetration test).
- Mascot "cuteness" motion additions (hops, head tilts) were deferred to keep the established model unchanged.
- Google integrations (Calendar, Gmail, Drive) are not built.
