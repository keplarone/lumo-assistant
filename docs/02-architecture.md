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
revocable. Background automations run with a reduced set: `read` tools plus notifications; anything else is
queued for the user to approve in the foreground.

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

`trait ModelProvider { async fn stream(&self, req: ModelRequest) -> Result<EventStream> }` with:

- **Anthropic** (native Messages API over HTTPS, SSE streaming). Default model `claude-opus-5-5`; users can
  pick `claude-sonnet-5-5` or `claude-haiku-5-5`. Adaptive thinking with `output_config.effort`; progress
  updates via `thinking.display: "updates"`; server tools `web_search_20260209` and `web_fetch_20260209`;
  client tools with `eager_input_streaming` and validation in Rust; vision input for screenshots and images;
  the `computer_toolset_20260801` toolset for computer use; `refusal` stop reason handled before content is
  used; server-side fallbacks enabled on Opus.
- **OpenAI-compatible** (`/v1/chat/completions` streaming with function tools) for local models (Ollama,
  LM Studio) and other vendors. Server tools are unavailable there, so web search falls back to the local
  `fetch_url` tool and an optional search API key.

### 4.2 Conversation history is append-only

The Anthropic API binds thinking blocks to the exact conversation prefix. So, per conversation, the system
prompt and tool list are frozen at creation and stored with it; content blocks are stored verbatim and
replayed unchanged; changes such as a newly saved memory are appended as `role: "system"` messages rather
than editing the original prompt. This also keeps the prompt cache warm.

### 4.3 Prompt-injection defenses

- Tool results from the web, files, email and screenshots are wrapped in `<untrusted_content source="…">`
  and the system prompt says such content carries no authority.
- Authority never lives in the context: even if the model is convinced by injected text, a sensitive call
  still needs the user's native confirmation, and a call outside a grant fails in Rust.
- Purchases, sends and deletions show the exact parameters in the confirmation, so an injected change is
  visible to the user.
- Per-run limits: max tool calls, max wall time, max spend estimate; per-tool rate limits.

## 5. Tools (first release)

| Tool | Tier | Notes |
|---|---|---|
| `update_plan`, `ask_user`, `present_options` | UI | No side effects; drive plan, question and comparison cards. |
| `list_directory`, `search_files`, `read_file`, `file_info` | read | Granted folders only, symlinks resolved and rechecked. |
| `write_file`, `create_folder`, `rename`, `organize_files` | write | Journaled; `organize_files` previews a move plan first. |
| `move_to_trash` | sensitive | Uses the OS trash, never permanent delete. |
| `web_search`, `web_fetch` (server) / `fetch_url` (local) | read | Content returned as untrusted. |
| `open_url` | sensitive for checkout or ordering links, write otherwise | Handoff to the user's browser. |
| `find_places` | read | OpenStreetMap; needs a saved location the user entered. |
| `clipboard_read` / `clipboard_write` | read (after grant) / write | |
| `notify` | write | Desktop notification. |
| `remember`, `forget` | write | Only when memory is enabled; every save is visible and undoable. |
| `create_project`, `project_write_file`, `project_read_file`, `project_list`, `project_preview` | write / read | Projects live in a granted workspace folder, each a git repository; every agent turn commits. |
| `run_command` | sensitive | Allowlisted programs only, in the project folder, scrubbed environment, timeout, output captured. |
| `screenshot`, computer toolset | sensitive | Screen capture and input control with a visible indicator and a global stop shortcut. |
| `calendar_*`, `gmail_*`, `drive_*`, `github_*`, `netlify_deploy` | per action | Only after the account is connected. |

## 6. IPC contract (webview ↔ Rust)

Commands are Tauri commands returning `Result<T, ApiError>` with `ApiError { code, message }`. Streaming
uses a Tauri `Channel<AgentEvent>` per run; app-wide changes use events. Types are mirrored in
`apps/desktop/src/lib/ipc.ts`.

- App: `app_info`, `settings_get`, `settings_update`, `secret_set`, `secret_clear`, `secrets_status`
  (presence only, never values), `open_logs_folder`.
- Conversations: `conversations_list`, `conversation_get`, `conversation_create`, `conversation_rename`,
  `conversation_delete`, `conversation_search`.
- Runs: `run_start(conversation_id, text, attachments, channel) -> run_id`, `run_cancel`, `runs_active`,
  `approval_respond(approval_id, approve)` (write tier only), `question_answer(question_id, answer)`.
- Permissions: `grants_list`, `grant_folder` (Rust opens the native picker), `grant_capability`,
  `grant_revoke`.
- Memory: `memories_list`, `memory_update`, `memory_delete`, `memories_export`, `memories_clear`.
- Automations: `automations_list`, `automation_save`, `automation_set_paused`, `automation_delete`,
  `automation_run_now`, `automation_history`.
- Agents: `agents_list`, `agent_save`, `agent_delete`.
- Integrations: `integrations_list`, `integration_connect`, `integration_disconnect`.
- Projects: `projects_list`, `project_files`, `project_read`, `project_write`, `project_history`,
  `project_restore`, `project_preview_url`.
- Audit: `audit_list`.
- Voice and screen: `stt_transcribe`, `tts_speak`, `tts_stop`, `screen_capture`.
- Windows: `window_show_main`, `window_toggle_compact`.

`AgentEvent` variants: `run_started`, `phase` (`understanding | planning | executing | verifying |
reporting`), `text_delta`, `progress_note`, `plan`, `tool_started`, `tool_finished`, `approval_requested`,
`approval_resolved`, `question`, `options`, `run_finished { status, summary }`, `error`.
App events: `runs_changed`, `privacy_indicators { mic, screen, control }`, `automation_finished`,
`memories_changed`.

## 7. Data

SQLite through rusqlite with SQLCipher, WAL mode, one file in the app data directory. The database key is a
random 256-bit key stored in the OS keychain. If no keychain is available, Lumo says so and does not fall
back to plaintext storage of secrets.

Tables: `settings`, `conversations`, `messages`, `runs`, `tool_calls`, `approvals`, `grants`, `memories`,
`automations`, `automation_runs`, `agents`, `integrations`, `projects`, `file_journal`, `audit_log`.
Retention settings delete conversations, runs and audit entries older than the chosen age.

## 8. Desktop shell

- Main window plus a compact floating window (always on top, toggled by a global shortcut, default
  `Alt+Space` on Windows/Linux and `Option+Space` on macOS, configurable).
- Tray/menu bar: open, new chat, pause automations, quit. Closing the main window keeps Lumo in the tray
  (configurable).
- Notifications for finished background tasks and automations.
- Single instance; deep link `lumo://` reserved for OAuth return.
- Updater: Tauri updater with signature verification (minisign public key in the app; private key in CI
  secrets).
- Logs: rotating files in the app log directory, no message content at info level.
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
