# Phase 2: Architecture

Date: 2026-10-16. Status: accepted; decisions are revisited only through a new entry in section 10.

## 1. Shape of the system

```
┌──────────────────────────── Lumo desktop app (one process tree) ────────────────────────────┐
│                                                                                              │
│  Webviews (untrusted renderers)            Rust core (trusted)                               │
│  ┌──────────────┐ ┌──────────────┐        ┌───────────────────────────────────────────────┐ │
│  │ Main window  │ │ Compact      │  IPC   │ Commands  ─► Agent runtime (tokio)            │ │
│  │ React + R3F  │ │ floating     │◄──────►│              ├─ Model gateway (Anthropic,     │ │
│  │ mascot, chat │ │ assistant    │ typed  │              │   OpenAI-compatible)           │ │
│  │ workspace    │ │              │ events │              ├─ Tool registry + validators    │ │
│  └──────────────┘ └──────────────┘        │              ├─ Policy: grants, tiers, rate   │ │
│                                           │              │   limits, approvals            │ │
│                                           │              └─ Verifier                      │ │
│                                           │ Scheduler (automations, watchers)             │ │
│                                           │ Store: SQLCipher DB, OS keychain              │ │
│                                           │ Services: fs, web, screen, input, voice,      │ │
│                                           │   OAuth, projects (git), preview server       │ │
│                                           │ Shell: tray, global shortcut, notifications,  │ │
│                                           │   updater, single instance, logs, crash guard │ │
│                                           └───────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
        │ HTTPS (keys attached in Rust only)
        ▼
  Model providers · Google/GitHub/Netlify APIs · OpenStreetMap · merchant and delivery sites (handoff)

Marketing site (apps/web): static, prerendered pages + R3F islands; no backend.
```

There is no Lumo cloud backend in the first release. Everything runs on the user's machine; network calls go
straight from the Rust core to the provider the user configured. A backend is added only when a feature
cannot work without one (for example OAuth apps that require a confidential client, or sync), and would get
its own design entry.

## 2. Repository layout

```
apps/desktop/            Tauri 2 app
  src/                   React UI (main window, compact window, styleguide route)
  src-tauri/             Rust core (crate `lumo`)
apps/web/                Marketing site (Astro, static output, React islands)
packages/ui/             Design tokens (CSS) + React components
packages/mascot/         Lumo character (three.js), behavior machine, R3F host
docs/                    Audit, architecture, design system, security, release
.github/workflows/       CI (lint, typecheck, tests, audits) and release builds
```

## 3. Trust boundaries

| Zone | Trusted with | Never trusted with |
|---|---|---|
| Rust core | Secrets, the database, every OS and network capability, the final decision on every tool call. | Model output as code. Model output is data that is parsed into typed tool calls and validated. |
| Webview | Rendering and the user's typed input. | Secrets (it never receives one), direct filesystem or network access (CSP `connect-src` is limited to IPC), approving sensitive actions (only the native dialog can). |
| Model | Choosing among offered tools and writing text. | Permissions. A tool call is a request; policy in Rust decides. |
| Content from the web, files, email, screenshots | Nothing. | It is wrapped and labelled as untrusted data in the model context and cannot widen permissions, because permissions are not expressed in the context at all. |

### Risk tiers (enforced in Rust at the execution boundary)

| Tier | Examples | Gate |
|---|---|---|
| `read` | List or read files in a granted folder, web search, read clipboard (after grant), read calendar | Runs automatically once the capability is granted. Logged. |
| `write` | Create or edit files in a granted folder, create a project, write clipboard, draft an email, create a calendar event | In-app approval card (one click), or pre-approved per conversation. Reversible: file writes are journaled for undo, projects are versioned with git. |
| `sensitive` | Delete or move files out of place, send email, place an order or open a checkout, deploy, run a command, control mouse and keyboard, capture the screen | Native OS confirmation dialog shown by Rust with the exact action. The webview cannot create, alter, or answer it. Never pre-approvable, never allowed in background automations. |

Grants (folders, screen, clipboard, location, accounts) are explicit, listed in Settings → Permissions, and
revocable. Background automations run with a reduced set: `read` and UI tools, plus any `write` tools the user
explicitly allowed when saving that automation. A call needing anything else (a sensitive action, a question,
an unallowed write) is refused; the run is marked **needs attention** and Lumo sends a notification, so the
user can finish the task in the foreground. Implemented in `tools::authorize` and `automations.rs`.

A few tools change tier with context: `move_to_trash` is `write` for up to 20 items and `sensitive` above;
`read_clipboard`, `get_active_window` and `take_screenshot` are `read` once their capability is granted and
need approval (`write` or `sensitive` respectively) otherwise; `open_url` is `sensitive` for checkout and
sign-in pages.

## 4. Agent runtime

Each user message starts a **run** in a tokio task with a cancellation token. The loop:

1. **Understand.** The run builds the request: frozen system prompt and tool list for the conversation
   (see 4.2), the history, and the new user turn with a context block (time, active app if granted,
   attachments).
2. **Plan.** For multi-step work the model calls `update_plan` (a UI-only tool) with steps; the UI shows them
   and they are updated as work proceeds. `ask_user` lets the model ask a structured question with options
   when information is missing, instead of guessing.
3. **Select tools and execute.** Tool calls stream in. Each is deserialized into a typed Rust struct
   (serde, `deny_unknown_fields`); invalid input returns an error result to the model and is never executed.
   Policy checks grant, tier, rate limit; approvals are requested as needed; the tool runs; the result is
   recorded.
4. **Verify.** Tools return evidence (paths with hashes, HTTP status, created ids). Write tools re-read
   what they wrote. Project builds run their checks. The model is instructed to verify before claiming
   success, and the run cannot report "done" on a step whose tool failed.
5. **Report.** The final assistant text, plus a structured run summary (steps, tools used, outcome).

Runs persist every step, so the UI can reload mid-run and a crash leaves an accurate record (a run that was
interrupted is marked `interrupted` on next start, never `succeeded`).

### 4.1 Model gateway

`trait ModelProvider { async fn complete(&self, req, sink, cancel) -> Result<ModelResponse> }` streams
deltas to a sink and returns the complete, replayable content blocks. Implementations:

- **Anthropic** (native Messages API over HTTPS, SSE streaming). Default model `claude-opus-5-5`; users can
  pick `claude-sonnet-5-5` or `claude-haiku-5-5`. Adaptive thinking with `output_config.effort`; progress
  updates via `thinking.display: "updates"`; server tools `web_search_20260209` and `web_fetch_20260209`;
  client tools with `eager_input_streaming` and validation in Rust (a truncated or invalid tool input is
  flagged and answered with an error result, never executed); vision and PDF input; `refusal`, `pause_turn`
  and `max_tokens` stop reasons handled; server-side fallbacks on models that support them; retries with
  `retry-after` for 429/5xx before any output; optional beta features are dropped automatically if the API
  rejects them. Mouse and keyboard control (the computer-use toolset) is **not** wired up yet.
- **OpenAI-compatible** (`/v1/chat/completions` streaming with function tools) for local models (Ollama,
  LM Studio) and other vendors. Server tools are unavailable there, so web search uses the `search_web` tool
  (Brave Search, when the user adds a key) and the local `fetch_url` tool. Thinking blocks are dropped when
  converting history for these endpoints.

### 4.2 Conversation history is append-only

The Anthropic API binds thinking blocks to the exact conversation prefix. So, per conversation, the system
prompt and tool list are frozen at creation and stored with it; content blocks are stored verbatim and
replayed unchanged. Facts that change between turns (local time, granted folders, the project folder, saved
location, and memories when enabled) go in a `<context>` block at the start of each user turn, never in the
system prompt. A user turn that follows a failed run (no assistant reply) is merged into the previous user
message, since the model never saw it. The tests assert that each request's message list extends the
previous one and that system prompt and tools never change within a conversation.

### 4.3 Prompt-injection defenses

- Tool results from the web, files, the clipboard, place listings, attachments and command output are
  wrapped in `<untrusted_content>` (with any closing tag inside neutralized) and the system prompt says such
  content carries no authority.
- `fetch_url` refuses non-public addresses (loopback, private ranges, link-local, metadata endpoints) and
  checks every redirect hop.
- Authority never lives in the context: even if the model is convinced by injected text, a sensitive call
  still needs the user's native confirmation, and a call outside a grant fails in Rust.
- Purchases, sends and deletions show the exact parameters in the confirmation, so an injected change is
  visible to the user.
- Per-run limit on actions (Settings → Model, default 40) and a cap of 60 model turns; per-tool rate limits
  (30 per minute). A max-spend estimate is not implemented yet.

## 5. Tools (as implemented)

| Tool | Tier | Notes |
|---|---|---|
| `update_plan`, `ask_user`, `present_options` | UI | No side effects; drive plan, question and comparison cards. `ask_user` is unavailable in automations. |
| `list_files`, `search_files`, `read_file` | read | Granted folders only; symlinks resolved and rechecked; credential folders refused even inside a grant. |
| `write_file`, `create_folder`, `move_files` | write | Journaled for undo; overwrites are backed up first; moves never overwrite. |
| `move_to_trash` | write (≤20) / sensitive | System Trash only; Lumo cannot permanently delete. |
| `request_folder_access` | UI | Opens the native folder picker; the user's choice is the grant. |
| `fetch_url` | read | Public addresses only; content untrusted. |
| `web_search`, `web_fetch` (Anthropic server tools) / `search_web` (Brave) | read | Server tools on Anthropic; Brave for local models when a key is added. |
| `open_url` | write / sensitive for checkout and sign-in | Handoff to the user's browser. |
| `find_places` | read | OpenStreetMap (Nominatim + Overpass); no menus, prices or ratings. |
| `prepare_checkout_handoff` | sensitive | Shows merchant, items, quantities, address and total (or "unknown until checkout"); copies the list and opens the merchant's site. Never places an order. |
| `read_clipboard` / `write_clipboard` | read after grant, else write / write | |
| `notify` | UI | Desktop notification. |
| `take_screenshot` | read after grant, else sensitive | Primary display, downscaled; privacy event shown. |
| `get_active_window` | read after grant, else write | The window in front when Lumo was summoned with the shortcut; kept in memory only. |
| `remember`, `forget` | UI | Only when memory is enabled; refuses passwords and payment details; all visible in Settings → Memory. |
| `create_project` | write | A folder under Documents/Lumo Projects, a git repository, auto-granted. |
| `save_version`, `preview_project` | UI | Git commit inside the project; preview served by the `preview:` protocol. |
| `run_command` | sensitive | Allowlisted programs (node, npm, pnpm, yarn, python, pip, git, cargo, go, deno, bun), no shell, no inline code, secrets stripped from the environment, timeout. Not an OS sandbox; the dialog says so. |
| `publish_to_github` | sensitive | Creates a repository (private by default) and pushes the project with the user's token. |
| `deploy_to_netlify` | sensitive | Zips the project, deploys, waits for "ready", and checks the URL responds. |

## 6. IPC contract (webview ↔ Rust)

Commands are Tauri commands returning `Result<T, ApiError>` with `ApiError { code, message }`. The source of
truth is `apps/desktop/src-tauri/src/commands.rs`; types are mirrored in `apps/desktop/src/lib/ipc.ts`.
Agent events are emitted app-wide as `agent-event` `{ runId, conversationId, event }` so the main and
compact windows both follow a run.

- App and settings: `app_info`, `get_settings`, `save_settings`, `secrets_status` (presence only),
  `set_secret`, `delete_secret`, `test_model_connection` (lists models; spends no tokens), `open_logs`,
  `check_for_updates`, `install_update`.
- Conversations and runs: `list_conversations`, `get_conversation`, `rename_conversation`,
  `delete_conversation`, `export_conversation`, `start_run`, `cancel_run`, `stop_all_runs`,
  `resolve_approval` (deny / once / conversation; write tier only), `answer_question`, `list_active_runs`,
  `list_runs`, `attach_files` (native picker; returns tokens, never paths).
- Permissions and changes: `list_grants`, `list_capabilities`, `grant_folder` (native picker),
  `grant_capability`, `revoke_grant`, `list_changes`, `undo_run`, `list_audit`.
- Memory: `list_memories`, `add_memory`, `update_memory`, `delete_memory`, `delete_all_memories`,
  `export_memories`.
- Automations and agents: `list_automations`, `save_automation`, `delete_automation`, `run_automation`,
  `list_automation_runs`, `allowable_automation_tools`, `list_agents`, `save_agent`, `delete_agent`,
  `list_tools`.
- Projects: `list_projects`, `create_project`, `project_files`, `read_project_file`, `write_project_file`,
  `project_history`, `save_project_version`, `restore_project_version`, `reveal_project`.
- Integrations: `integrations_status`, `verify_integration`, `disconnect_integration`.
- Windows: `show_main_window`, `toggle_compact_window`.

`AgentEvent` (serde tag `type`): `run_started`, `phase` (`understanding | planning | executing | verifying |
reporting`), `text_delta`, `progress_note`, `plan`, `tool_started`, `tool_finished`, `approval_requested`,
`approval_resolved`, `question`, `options`, `open_preview`, `privacy`, `assistant_message`, `run_finished`
(`done | failed | cancelled | refused | stopped`, plus `needs_attention` for automations).
App events: `files-dropped` (attachment tokens from drag and drop), `runs-changed`, `settings-changed`,
`automations-changed`, `projects-changed`.

Not yet implemented: speech-to-text and text-to-speech commands, and computer-use input control.

## 7. Data

SQLite through rusqlite with SQLCipher, WAL mode, one file in the app data directory. The database key is a
random 256-bit key stored in the OS keychain. If no keychain is available, Lumo says so and does not fall
back to plaintext storage of secrets.

Tables: `settings`, `conversations`, `messages`, `runs`, `tool_calls`, `grants`, `memories`, `automations`,
`automation_runs`, `agents`, `integrations`, `projects`, `file_journal`, `audit_log`. The optional
retention setting deletes conversations (and their runs) older than the chosen age at startup.

## 8. Desktop shell

- Main window plus a compact floating window (always on top, toggled by a global shortcut, default
  `Alt+Space` on Windows/Linux and `Option+Space` on macOS, configurable).
- Tray/menu bar: open, new chat, pause automations, quit. Closing the main window keeps Lumo in the tray
  (configurable).
- Notifications for finished background tasks and automations.
- Single instance (a second launch focuses the running app).
- Updater: Tauri updater with signature verification. It is compiled in only when the release build is
  given `LUMO_UPDATER_PUBKEY` (see docs/release.md); otherwise Settings says updates aren't set up.
- Logs: rotating files (5 × 5 MB) in the app log directory, no message content at info level.
- Crash recovery: panics are caught and logged; runs left mid-flight are marked interrupted; window state
  restored.

## 9. Website

Astro static site with React islands for Three.js scenes; every page is fully readable with JavaScript or
WebGL off. The mascot is the same `@lumo/mascot` package the app uses. Privacy-respecting analytics are off
unless an endpoint is configured, honor Do Not Track and Global Privacy Control, and use no cookies.

## 10. Decision log

| # | Decision | Why |
|---|---|---|
| 1 | Agent runtime in Rust, not the webview | Background work survives closed windows; a compromised renderer cannot drive tools; plans stay separate from privileged execution. |
| 2 | Native dialog for `sensitive` tier | The renderer can be compromised; the OS dialog cannot be forged by it. |
| 3 | SQLCipher with keychain-held key | Conversations and memories are personal data at rest. |
| 4 | No cloud backend in v1 | Fewer places to leak data; nothing in v1 requires one. |
| 5 | Handoff, not scraping, for ordering and checkout | No consumer ordering APIs are available to Lumo yet; bypassing provider terms or payment confirmation is not acceptable. |
| 6 | Append-only conversation history | Required for thinking-block validity on current Claude models and keeps caching effective. |
| 7 | Astro for the website | Static HTML for SEO and no-JS readers, React islands for the 3D scenes. |
