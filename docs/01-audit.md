# Lumo Assistant: Phase 1 architecture and implementation audit

Date: 2026-10-16 · Repository: github.com/keplarone/lumo-assistant · Branch: `claude/lumo-foundation-uj82xg`

## 1. What exists today

| Item | Finding | Evidence |
|---|---|---|
| Repository | **Empty.** No commits, no branches, no files. Nothing can be overwritten, and no prior architecture constrains us. | `git ls-remote origin` returns nothing; local clone reports "No commits yet". |
| Space Studio | **Not found.** It is not in this repository, not in the project's shared files, and not in project memory. No Space Studio code, tokens, screenshots or components were available to inspect. | Searched repo, `/mnt/project-files/`, project memory. |
| Mascot reference | **Found:** `Lumo Mascot.html` (47.9 KB) uploaded by Keder. Committed verbatim as `docs/reference/lumo-mascot.html` so it is versioned with the code. | See section 2. |
| Build environment | Node 22, pnpm 10, Rust 1.97, WebKitGTK 4.1 (installed), Xvfb and Chromium/Playwright available. Linux desktop builds and headless UI testing are possible here. macOS and Windows installers need CI runners on those OSes (planned via GitHub Actions). | Tool version checks. |

**Open question for Keder:** where does Space Studio live (repo, folder, or exported design)? Until it is available, the Lumo design system (Phase 3) is built on its own merits from the brief: neutral surfaces, restrained blue accent, Linear/Raycast-level discipline. When Space Studio turns up, I will audit it and fold its strongest ideas into the tokens rather than starting over.

## 2. Mascot audit (the established identity to preserve)

**What it is:** a fully procedural three.js "celestial owl": no models or textures to load. `createLumoFactory(THREE)` returns a `Lumo` class that extends `THREE.Group`.

**Identity elements that must not change:** night-blue body (#2c3184 → #0b0d2a) with cyan rim light (#7ff3ff); gold chest scallops and star flecks on the back; large pale facial discs with gold rings; amber irises with the slowly turning cyan "circuit" ring (the AI tell); gold beak with an animated jaw; crystal ear-tufts and a floating crown gem; layered glowing feathers (8 primaries + 6 coverts per wing, 5 tail feathers); the halo (gold orbit ring, ticked cyan ring, 9 motes); warm and cool aura, ground glow, drifting particles.

**Animation system (well designed, reused as is):**
- Six moods (`idle, think, speak, happy, majestic, sleep`), each a full set of 18 rig targets.
- Every frame, parameters ease toward targets with frame-rate-independent exponential damping (`damp`), with per-channel rates (lids fast, wings slow). This is already "animation blending": any number of target sets can be layered by writing targets.
- Autonomous blinking, wandering gaze, `gaze(x, y)` for look-at, `react()` for timed moods that return to the previous one, `pulse()` burst, `speakLevel` to drive the beak from real TTS audio, `statechange` events.
- `calm` option already damps motion amplitude for reduced motion.
- `dispose()` releases every geometry, material and texture it created.

**Technical findings:**
1. Written against three r149 (2022, global build from a CDN). Current three is r186. Custom `ShaderMaterial`s still compile in r186 (three maps `gl_FragColor` for GLSL3). Color management changed in r152: to keep colors pixel-identical the port renders with linear output and legacy color management, verified by a side-by-side screenshot test.
2. Draw calls: ~70 (33 feather meshes each with its own geometry, 9 mote sprites each with its own material, rings, sprites, body parts). Fine for one mascot; the 33 feather geometries can be merged or instanced later if profiling on low-end hardware shows a need. Shared 96×64 sphere (~12k triangles) is reused for body, discs and eyeballs.
3. The demo's render loop already pauses when off-screen (`IntersectionObserver`), but it never stops the loop or throttles frame rate when idle; the product version adds on-demand rendering, frame-rate caps while idle or sleeping, and `visibilitychange` pausing.
4. No product states yet for listening, searching, working, walking, turning, uncertainty, error recovery or greeting. These are added as new **target presets and scripted gaze/motion layered on the same rig**, never as a new character.

**Port plan:** keep the `Lumo` class as a framework-agnostic TypeScript module (`packages/mascot/src/core`) translated line for line, wrap it in a React Three Fiber component, and drive it from a typed, unit-tested behavior state machine that maps real agent status to mascot behavior.

## 3. Proposed architecture

```
lumo-assistant/
  apps/desktop/        Tauri 2 app: React + TS UI (webview) + Rust core (src-tauri)
  apps/web/            Marketing site (static generation, R3F islands)    [Phase 8]
  packages/mascot/     Lumo core (three.js), R3F component, behavior state machine
  packages/ui/         Design tokens + shared components
  packages/agent/      Provider-agnostic agent engine (plan → act → verify), tool schemas
  docs/                Architecture decisions, design system, reference mascot
```

**Security boundaries (the core decision).**
- The webview is treated as untrusted. It renders UI and runs the orchestration loop, but **holds no secrets and cannot perform privileged actions on its own**.
- The Rust core owns: API keys (OS keychain via `keyring`), all model HTTP calls (the key is attached in Rust, responses streamed back), the SQLite database, and every tool that touches the OS.
- Tool calls cross the boundary as **typed, schema-validated requests** (`serde` enums in Rust, `zod` in TS). Rust re-validates arguments, checks the permission policy (e.g. a path must be inside a folder the user granted), and for sensitive or destructive actions shows a **native OS confirmation dialog** that the webview cannot forge or auto-approve. Every execution is written to an audit log.
- Model output is never executed as a shell command. There is no generic "run command" tool; code execution, when added, runs in a sandbox (Phase 5+).
- Content from web pages, files and tool results is wrapped and labelled as untrusted data in the model context (prompt-injection defense), and cannot widen permissions, since permissions live in Rust.

**Agent engine.** `Understand → Plan → Select tools → Execute → Verify → Report`, implemented as a loop over a model with tool use. Each run is a persisted Task with visible steps (plan, tool calls, results, verification). Tools declare a risk tier (`read`, `write`, `sensitive`), which drives confirmation. Provider-agnostic gateway with Anthropic as the first provider; OpenAI-compatible endpoints (including local models) behind the same interface.

**Desktop shell.** Main window, compact floating assistant window (always-on-top, opened by global shortcut), tray/menu bar, notifications, single-instance, autostart off by default, structured logging, crash-safe SQLite (WAL), updater plugin with signed releases (needs a signing key from Keder).

## 4. Integration reality check (affects Phase 7)

| Provider | What is actually available | Plan |
|---|---|---|
| DoorDash | Public "Drive" APIs are for merchants dispatching deliveries, not consumer ordering. In July 2026 DoorDash announced `dd-cli`, a limited beta for US/Canada macOS developers by preregistration, that can place orders through an AI agent. | Ship a legitimate deep-link/browser handoff now. Apply to the dd-cli beta (needs Keder). |
| Uber Eats | "Consumer Delivery" APIs (browse stores, carts, orders, tracking, with the user linking their Uber account) are in early access, case by case, and may require written approval from Uber. | Handoff now; submit Uber's interest form (needs Keder). |
| Google (Calendar, Gmail, Drive) | Standard OAuth; sensitive/restricted scopes require Google app verification before public release. | Implement with PKCE loopback OAuth; needs a Google Cloud OAuth client from Keder. |
| GitHub | OAuth/device flow, freely available. | Good first real integration. |
| Shopping | No universal checkout API. Product search can use web search; checkout is a handoff to the merchant with explicit approval. | Research + compare + handoff; never auto-purchase. |

Sources: [DoorDash dd-cli beta](https://mezha.net/eng/bukvy/588bb4d0_doordash_launches_dd-cli/), [Uber Consumer Delivery APIs](https://developer.uber.com/docs/consumer-delivery/introduction), [Uber Eats Marketplace APIs](https://developer.uber.com/docs/eats/introduction).

## 5. Build order and what "done" means for the first slice

The first vertical slice is a complete, secure, working desktop assistant rather than many partial features:
1. Design system tokens and core components (Phase 3).
2. Tauri shell: windows, tray, global shortcut, notifications, keychain, SQLite (Phase 4).
3. Agent engine with real model calls and a small set of real tools: authorized-folder file tools (list, search, read, organize with confirmation), clipboard, notifications, web fetch (read-only, untrusted), open-URL handoff (Phase 5).
4. Mascot port + state machine wired to real agent status (Phase 6).
Then integrations (7), website (8), QA (9), release (10).

## 6. Requires Keder (third-party approval or credentials)

- Location of Space Studio.
- An Anthropic API key (entered in the app's settings; stored in the OS keychain, never in the repo).
- Apple Developer ID + notarization credentials (macOS installers), a Windows code-signing certificate, and an updater signing key.
- Google Cloud OAuth client; GitHub OAuth app.
- DoorDash dd-cli beta and Uber Consumer Delivery early-access applications.
