# Lumo Assistant

Tell Lumo what you want. Lumo figures out how to make it happen.

Lumo is a desktop AI agent for Windows, macOS and Linux. It plans a task, uses typed tools on your computer
with your permission, checks its own work and reports back. It is **pre-release software**: see
[docs/04-phase-report.md](docs/04-phase-report.md) for exactly what is built, tested, and still missing.

## Repository

| Path | What it is |
| --- | --- |
| `apps/desktop` | The Tauri 2 app. `src/` is the React UI; `src-tauri/` is the Rust core (agent loop, tools, policy, encrypted storage) |
| `apps/web` | The download page at lumo.keplar.one (Astro, static), plus privacy, terms and licenses |
| `services/license` | Whop license check (serverless; holds the Whop API key) |
| `packages/ui` | Design system: tokens and React components |
| `packages/mascot` | The Lumo mascot (three.js, with a React wrapper) |
| `docs/` | Audit, architecture, design system, release process and phase report |

## How it is put together

The webview is treated as untrusted. Rust owns model API keys (in the OS keychain), all model HTTP, the
SQLCipher database and every tool. The model can only call typed, validated tools; each tool has a risk tier,
and writes ask in the app while sensitive actions (screen control, deploys, purchases handoff) ask through a
native OS dialog. Content from web pages and files is wrapped as untrusted and cannot change your
instructions. Details are in [docs/02-architecture.md](docs/02-architecture.md).

## Develop

Requirements: Node 22+, pnpm 10, a stable Rust toolchain, and on Linux the packages listed in
[docs/release.md](docs/release.md).

```sh
pnpm install
pnpm dev            # desktop app (Tauri + Vite)
pnpm dev:web        # website
```

## Check

```sh
pnpm lint && pnpm typecheck && pnpm test
pnpm --filter @lumo/web test:e2e
pnpm --filter @lumo/desktop test:ui
cd apps/desktop/src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
```

## Release

See [docs/release.md](docs/release.md). Tagging `v*` builds draft installers; nothing is published
automatically.
