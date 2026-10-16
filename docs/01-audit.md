# Phase 1: Repository and implementation audit

Date: 2026-10-16 · Repository: github.com/keplarone/lumo-assistant · Branch: `claude/lumo-foundation-high-xepcvo`

This audit restarts the build at high effort. It reviews everything that existed before this branch: the
repository, an earlier attempt's audit and work-in-progress commit, the mascot reference, and the build
environment.

## 1. What exists

| Item | Finding | Evidence |
|---|---|---|
| Repository | Two commits from an earlier attempt: the mascot reference plus an audit (`0e0213c`), and a WIP pnpm monorepo with `packages/mascot` (`adb311b`). No desktop app, website, backend, or CI. Nothing unrelated to overwrite. | `git log origin/claude/lumo-foundation-uj82xg` |
| Space Studio | **Not available.** Not in this repository, the project's shared files, or project memory. No code, tokens, screenshots or components to inspect. | Searched repo, `/mnt/project-files/`, project memory. |
| Mascot reference | `docs/reference/lumo-mascot.html` (47,900 bytes), byte-identical to Keder's upload "Lumo Mascot.html". | `diff` against the upload. |
| Build environment | Linux x86-64, 4 cores, 15 GB RAM. Node 22.22, pnpm 10.28, Rust 1.97. WebKitGTK 4.1 + `webkit2gtk-driver` installed from apt, so the Tauri app builds, runs under Xvfb, and can be driven end to end with `tauri-driver`. Chromium for Playwright is preinstalled. macOS and Windows builds need CI runners on those OSes. | Tool version checks. |

## 2. The mascot: what must be preserved

The reference is a single procedural three.js r149 file; there are no models or textures to load.
`createLumoFactory(THREE)` returns a `Lumo` class (a `THREE.Group`).

**Identity (do not change):** night-blue body (#2c3184 to #0b0d2a) with a cyan rim light (#7ff3ff); gold
chest scallops and twinkling star flecks on the back; pale facial discs with gold rings; amber irises with a
slowly turning cyan "circuit" ring (the AI tell); gold beak with an animated jaw; crystal ear tufts and a
floating crown gem; layered glowing feathers (8 primaries and 6 coverts per wing, 5 tail feathers); a halo
of a gold orbit ring, a ticked cyan ring and 9 motes; warm and cool aura sprites, ground glow, 150 drifting
particles.

**Animation system:** six moods (`idle, think, speak, happy, majestic, sleep`), each a complete set of 18 rig
targets. Every frame the live parameters ease toward the targets with frame-rate-independent exponential
damping and per-channel rates. Blinking, wandering gaze, `gaze(x, y)`, `react()` for timed moods, `pulse()`,
`speakLevel` for audio-driven beak motion, `statechange` events, a `calm` option for reduced motion, and a
`dispose()` that frees every GPU resource. This design is sound and is kept as is; new product states are
new presets and motion layers on the same rig.

## 3. Review of the earlier work-in-progress

The earlier attempt's audit and `packages/mascot` were reviewed line by line against the reference.

| Part | Verdict | Notes |
|---|---|---|
| Phase 1 audit (`docs/01-audit.md` at `0e0213c`) | Mostly sound; superseded by this document. | Its integration research (section 6 below) holds up and is kept. |
| `core/lumo.ts`, `core/shaders.ts` | **Keep.** Faithful line-for-line port; geometry, shaders, palette, targets and easing match. | One real defect: on three r152+ with color management on, `SpriteMaterial`/`MeshBasicMaterial` colors given as hex are converted from sRGB to linear, so the aura, motes, ground glow and pulse render darker than the reference. Fixed in Phase 6 by building those colors as raw linear values and rendering with linear output and no tone mapping, then proving parity with a screenshot diff against the r149 reference. |
| `core/companion.ts` (product moods, walk, turn) | **Keep, extend.** | Covers listen, process, search, work, unsure, recover, greet. Missing: distinct typing/coding motion, a one-wing greeting wave, celebrating beyond `happy`, look-at-element helper. |
| `behavior/machine.ts` + 8 tests | **Keep.** Pure, deterministic, tested. | Extended in Phase 6 with typing, attention-to-element and locomotion outputs. |
| `react/LumoMascot.tsx` | **Rework.** Never run in a browser. | The frame driver ignores its `fps` prop; the pointer listener runs on every move even when hidden; color management not set for parity; no test that GPU memory returns to zero after unmount. |
| Root tooling | **Keep, extend.** | No lint config, no CI, no formatting check yet. |

## 4. Decisions carried into Phase 2

1. **Monorepo** (pnpm): `apps/desktop` (Tauri 2), `apps/web` (marketing site), `packages/mascot`, `packages/ui`.
2. **The Rust core is the agent runtime.** The earlier plan ran orchestration in the webview. That is moved
   into Rust: the agent loop, model gateway, tool registry, permission policy, approvals, scheduler,
   database and secrets all live in the native process. The webview only renders state and sends user
   intents. Reasons: background tasks and automations must keep running with every window closed; a
   compromised webview (for example through rendered model output) must not be able to drive tools; and
   model-generated plans stay separated from privileged execution.
3. **Anthropic Messages API first, provider-agnostic interface.** Native Messages API adapter (streaming,
   tools, web search and fetch server tools, vision, computer use toolset) plus an OpenAI-compatible adapter
   for local or other models (Ollama, LM Studio, other vendors).
4. **Three risk tiers enforced in Rust:** `read` runs automatically; `write` (reversible, inside a folder the
   user granted) needs an in-app approval; `sensitive` (money, deletion, sending messages, controlling the
   computer, running commands) needs a native OS dialog the webview cannot forge.

## 5. What "done" means for the first slice

A complete, secure, working assistant rather than many partial features: shell (windows, tray, shortcut,
notifications), conversations with a real model, file tools on granted folders, web research, honest
handoffs for ordering and shopping, the mascot wired to real agent state, memory, automations, a project
workspace that can build and preview static websites, and the marketing site. Computer use, voice, and
OAuth integrations follow, each behind explicit permissions.

## 6. Integration reality check (feeds Phase 7)

| Provider | What is actually available | Plan |
|---|---|---|
| DoorDash | Public "Drive" APIs dispatch deliveries for merchants; they are not consumer ordering. DoorDash announced `dd-cli` in July 2026, a limited preregistration beta for US/Canada developers that lets an AI agent place orders. | Legitimate handoff now (restaurant found from real map data, deep link to DoorDash search). Adapter slot for dd-cli once Keder is accepted. |
| Uber Eats | Consumer Delivery APIs (browse, cart, order, tracking with the user's linked account) are early access, case by case, with written approval. | Handoff now; adapter slot after approval. |
| Restaurants | No universal ordering API. OpenStreetMap (Nominatim geocoding, Overpass search) gives real nearby restaurants with websites and phone numbers, free with a fair-use policy. | Real nearby search; order on the restaurant's own site or by phone. |
| Shopping | No universal checkout API. | Real research and comparison via web search; checkout is a handoff to the merchant after explicit approval of merchant, item, quantity and price. Never auto-purchase. |
| Google Calendar, Gmail, Drive | Standard OAuth 2 for installed apps (PKCE + loopback). Restricted scopes need Google verification before public release. | Implement; needs Keder's Google Cloud OAuth client. |
| GitHub | Personal access tokens work today; OAuth device flow needs an OAuth app. | Implement with a token now, device flow when an app exists. |
| Deployment | Netlify and Vercel deploy APIs accept a personal token. | Implement deploy-to-Netlify with confirmation; needs the user's token. |

Sources: [DoorDash dd-cli](https://mezha.net/eng/bukvy/588bb4d0_doordash_launches_dd-cli/),
[Uber Consumer Delivery](https://developer.uber.com/docs/consumer-delivery/introduction),
[Uber Eats Marketplace](https://developer.uber.com/docs/eats/introduction),
[Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/).

## 7. Needs Keder (approvals and credentials)

- Where Space Studio lives.
- An Anthropic API key (entered in Lumo's settings, stored in the OS keychain, never in the repository).
- Apple Developer ID and notarization credentials, a Windows code-signing certificate, and a Tauri updater
  signing key (for signed installers and verified updates).
- A Google Cloud OAuth client; a GitHub OAuth app (optional, tokens work meanwhile).
- DoorDash dd-cli beta and Uber Consumer Delivery early-access applications.
