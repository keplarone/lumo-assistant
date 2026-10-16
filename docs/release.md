# Releasing Lumo

Pushing a tag like `v0.1.0` runs `.github/workflows/release.yml`. It builds installers on macOS (universal),
Windows and Linux and attaches them to a **draft pre-release**. Nothing is published until a person reviews
the draft and publishes it.

## Secrets

Set these under the repository's Settings → Secrets and variables → Actions. Every one is optional for a
build to succeed; what you lose without each is listed.

| Secret                                                                      | Used for                                            | Without it                                                                         |
| --------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`           | Signing update bundles                              | No update artifacts; the app's "Check for updates" says updates are not configured |
| `LUMO_UPDATER_PUBKEY`                                                       | Public half of the key above, compiled into the app | Same as above (both must be set)                                                   |
| `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` | Developer ID code signing                           | macOS build is unsigned; Gatekeeper blocks it by default                           |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`                               | Notarization                                        | Signed build is not notarized; Gatekeeper still warns                              |

Windows builds are unsigned until a code-signing certificate is added (SmartScreen will warn).

Generate the updater key pair once with `pnpm --filter @lumo/desktop tauri signer generate -w lumo.key`. Keep
the private key out of the repository. The updater endpoint is the `latest.json` attached to the newest
GitHub release (`tauri.conf.json` → `plugins.updater.endpoints`).

## Plans and licensing (Whop)

Lite (`plan_0KzI2YIP7k6Pp`) and Pro (`plan_1ucbcMEoxhW3g`) are sold on Whop. The app opens
`https://whop.com/checkout/<plan id>` (override with the `LUMO_WHOP_CHECKOUT_LITE` / `LUMO_WHOP_CHECKOUT_PRO`
build variables if your store uses the `whop.com/<store>/checkout/<plan id>` form).

License keys are checked by `services/license`, a small serverless function, because the Whop API key must
never ship inside the app. To turn it on:

1. Deploy `services/license` (for Vercel: import the folder as a project; the function is `api/validate.js`).
2. Set the server secret `WHOP_API_KEY` there. Use a fresh key with `member:basic:read` and `member:email:read` (the membership lookup requires both); rotate any key that
   was ever pasted into a chat, ticket or file.
3. Set the repository variable `LUMO_LICENSE_SERVER` to the function URL (for example
   `https://license.lumo.keplar.one/api/validate`) so release builds compile it in.

## Checklist before publishing a draft

1. CI is green on the tagged commit (web, Rust on all three platforms, audit).
2. Version numbers match in `apps/desktop/src-tauri/tauri.conf.json`, `apps/desktop/src-tauri/Cargo.toml`
   and `apps/desktop/package.json`.
3. Install each installer on a clean machine and walk the first-run journey: onboarding, add a model key,
   send a message, grant a folder, organize files and undo, approve and deny a sensitive action, stop a run.
4. macOS: confirm the Screen Recording, Accessibility and Microphone prompts appear when the matching feature
   is first used, and that denying them gives a clear message rather than a crash.
5. Computer use: start a task that uses the mouse, press Alt+Shift+Escape and confirm control stops at once.
6. Set `version` in `apps/web/src/data/release.ts` to the published version so the download page links the
   installers, then deploy the site.
7. Plans: Whop checkout links open real purchases. Confirm license activation works against the deployed
   license server before announcing paid plans.
8. Write release notes, then publish the draft. Untick "pre-release" only for a stable release.

## Building locally

```sh
pnpm install
pnpm --filter @lumo/desktop tauri build          # installers for the current OS
```

Linux needs: `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev
libpipewire-0.3-dev libgbm-dev libxcb1-dev libxrandr-dev libdbus-1-dev`.
