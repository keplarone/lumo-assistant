# Lumo 0.1.0 phase report

Status: **pre-release (preview)**. The builds are unsigned, and live calls to Claude have not been run from the
build environment because it has no Anthropic API key. Nothing here should be read as production-ready until the
items under "Needs the owner" and "Not done" are closed.

## Implemented and tested

| Area          | What exists                                                                                                                                                                                                                                                                                                                                          | Evidence                                                                         |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Rust core     | Agent loop (understand, plan, act, verify, report), append-only history, typed tools with risk tiers, approvals at the execution boundary, native dialogs for sensitive actions, SQLCipher database with the key in the OS keychain, audit log, undo journal                                                                                         | 50 unit and end-to-end tests (`cargo test --lib`), clippy `-D warnings`, rustfmt |
| Tools         | Files (granted folders only), web fetch with SSRF and DNS-rebinding defenses, places (OpenStreetMap), checkout handoff (never places orders), clipboard, notifications, screenshots, computer control with Alt+Shift+Escape stop, memory, projects with git history and sandboxed preview, allowlisted commands, GitHub and Netlify publishing, mood | Same suite; publishing tested against mock servers and a local bare repo         |
| Models        | Anthropic Messages API (Claude Opus 5.5 default), OpenAI-compatible endpoints, and free on-device models Orbit 3.8, Nebula 4.2, Solar 5.4 and Nova 5.5 (Apache-2.0 open models through Ollama)                                                                                                                                                       | Mocked in tests; on-device runtime calls tested against a mock Ollama            |
| Plans         | Free, Lumo Lite $19.99/month, Lumo Pro $49.99/month; Whop checkout pages for Lite and Pro; license activation through `services/license`                                                                                                                                                                                                             | Rust and Node tests with mocked Whop                                             |
| Companion     | Warm, playful owl personality with fixed limits: says it is an AI and not a therapist, gives crisis lines (988, Samaritans, local emergency numbers), encourages real-world support, keeps feelings out of memory unless asked                                                                                                                       | System prompt (`agent/prompt.rs`); behavior with a live model not yet evaluated  |
| Desktop UI    | Chat with live plan, approvals and timeline; projects with editor and preview; automations; settings for models, plans, help, privacy, about; computer-control Stop banner; voice input; compact window                                                                                                                                              | 40 unit tests, 9 Playwright screen tests, typecheck, ESLint, Prettier            |
| Mascot        | The established Lumo owl, ported exactly, with product states and reduced-motion support                                                                                                                                                                                                                                                             | 21 unit tests, 39 visual parity tests                                            |
| Website       | One download page for lumo.keplar.one with OS detection (no download links until a version is published), privacy, terms, licenses; old routes redirect                                                                                                                                                                                              | 9 unit tests, 53 Playwright tests, astro check                                   |
| Security      | Threat model (`docs/05-threat-model.md`); strict CSP and least-privilege Tauri capabilities; key-destination changes need native confirmation; startup scripts and credential files refused; secret scanning, `cargo audit` and `pnpm audit` in CI                                                                                                   | Regression test per fix                                                          |
| App smoke run | Debug build starts under Xvfb, migrates the encrypted database, writes its log                                                                                                                                                                                                                                                                       | Local run                                                                        |

## Needs the owner

- **Whop API key** set as `WHOP_API_KEY` on the deployed license server (rotate the key that was pasted in chat), and the
  `LUMO_LICENSE_SERVER` repository variable. Until then, Upgrade opens Whop checkout but license activation says it
  is not available in this build.
- **Signing:** Apple Developer ID and notarization, a Windows code-signing certificate, and an updater key pair
  (`docs/release.md`). Without them macOS and Windows warn on install and auto-update is off.
- **DNS** for lumo.keplar.one pointing at the hosted download page.
- **An Anthropic API key** to run live end-to-end checks of the agent with Claude.

## Not done or not verified

- Live runs against Claude and against real Ollama models; the companion behavior with a live model.
- Plan limits (Free task limits, Lite/Pro gating) are not enforced yet; the owner has not set the numbers.
- Whop checkout URL form `whop.com/checkout/<plan>` could not be fetched from the build environment; the
  store-specific URL can be set at build time.
- Computer control and screen capture on Wayland, macOS and Windows have not been run on real machines.
- Webview IPC under the stricter capabilities is covered by mocked UI tests and a smoke start, not a full
  driven end-to-end run.
- Open risks listed in `docs/05-threat-model.md` (read-tier exfiltration through URLs, standing per-conversation
  approvals, computer-control calls after the first approval, no external penetration test).
- Mascot "cuteness" motion additions (hops, head tilts) were deferred to keep the established model unchanged.
- Google integrations (Calendar, Gmail, Drive) are not built.
