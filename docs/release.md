# Releasing Lumo

Pushing a tag like `v0.1.0` runs `.github/workflows/release.yml`. It builds installers on macOS (universal),
Windows and Linux and attaches them to a **draft pre-release**. Nothing is published until a person reviews
the draft and publishes it.

## Secrets

Set these under the repository's Settings → Secrets and variables → Actions. Every one is optional for a
build to succeed; what you lose without each is listed.

| Secret | Used for | Without it |
| --- | --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Signing update bundles | No update artifacts; the app's "Check for updates" says updates are not configured |
| `LUMO_UPDATER_PUBKEY` | Public half of the key above, compiled into the app | Same as above (both must be set) |
| `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` | Developer ID code signing | macOS build is unsigned; Gatekeeper blocks it by default |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | Notarization | Signed build is not notarized; Gatekeeper still warns |

Windows builds are unsigned until a code-signing certificate is added (SmartScreen will warn).

Generate the updater key pair once with `pnpm --filter @lumo/desktop tauri signer generate -w lumo.key`. Keep
the private key out of the repository. The updater endpoint is the `latest.json` attached to the newest
GitHub release (`tauri.conf.json` → `plugins.updater.endpoints`).

## Checklist before publishing a draft

1. CI is green on the tagged commit (web, Rust on all three platforms, audit).
2. Version numbers match in `apps/desktop/src-tauri/tauri.conf.json`, `apps/desktop/src-tauri/Cargo.toml`
   and `apps/desktop/package.json`.
3. Install each installer on a clean machine and walk the first-run journey: onboarding, add a model key,
   send a message, grant a folder, organize files and undo, approve and deny a sensitive action, stop a run.
4. macOS: confirm the Screen Recording, Accessibility and Microphone prompts appear when the matching feature
   is first used, and that denying them gives a clear message rather than a crash.
5. Computer use: start a task that uses the mouse, press Alt+Shift+Escape and confirm control stops at once.
6. Check that the website's capability statuses (`apps/web/src/data/capabilities.ts`) match this build. Only
   mark something available once it is in a published release.
7. Pricing: plans must stay marked "At launch" until accounts and billing exist (they do not yet; see
   `docs/04-phase-report.md`).
8. Write release notes, then publish the draft. Untick "pre-release" only for a stable release.

## Building locally

```sh
pnpm install
pnpm --filter @lumo/desktop tauri build          # installers for the current OS
```

Linux needs: `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev
libpipewire-0.3-dev libgbm-dev libxcb1-dev libxrandr-dev libdbus-1-dev`.
