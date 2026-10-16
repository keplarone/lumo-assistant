# Releasing Lumo

Pushing a tag like `v0.1.0`, or running the Release workflow by hand on the default branch, runs
`.github/workflows/release.yml`; the release is tagged `v<app version>`. It builds installers on macOS (universal),
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

Lite (`plan_0KzI2YIP7k6Pp`, $19.99/month) and Pro (`plan_1ucbcMEoxhW3g`, $49.99/month) are sold on Whop. The app opens
`https://whop.com/checkout/<plan id>` (override with the `LUMO_WHOP_CHECKOUT_LITE` / `LUMO_WHOP_CHECKOUT_PRO`
build variables if your store uses the `whop.com/<store>/checkout/<plan id>` form). The old Unlimited plan
(`plan_PRiCMfcmM4uul`) no longer grants anything; to keep honoring members who bought it, add its id to
`WHOP_PLANS_PRO` on the server.

License keys are checked by `services/license`, a small serverless function, because the Whop API key must
never ship inside the app. To turn it on:

1. Deploy `services/license` (for Vercel: import the folder as a project; the function is `api/validate.js`).
2. Set the server secret `WHOP_API_KEY` there. Use a fresh key with `member:basic:read` and `member:email:read` (the membership lookup requires both); rotate any key that
   was ever pasted into a chat, ticket or file.
3. Release builds use `https://lumo-license.vercel.app/api/validate` (the deployed `lumo-license` Vercel project). To point them elsewhere, set the repository variable `LUMO_LICENSE_SERVER` to the function URL (for example
   `https://license.lumo.keplar.one/api/validate`) so release builds compile it in. The model gateway is
   the same server's origin unless `LUMO_API_BASE` is set.

## Lumo's models (OpenRouter)

The same server runs Lumo's model gateway (`api/chat.js`, `api/usage.js`, `api/models.js`). It needs:

1. `OPENROUTER_API_KEY`: an OpenRouter API key, set as a sensitive production variable on `lumo-license`.
   Give the key a credit limit in OpenRouter as a backstop.
2. Redis for metering: add **Upstash for Redis** to `lumo-license` from the Vercel Marketplace (the free
   tier is enough to start); it sets `KV_REST_API_URL` and `KV_REST_API_TOKEN`.
3. In OpenRouter's privacy settings, allow the free models' data policy, or free models return "no
   endpoints found". Buy at least $10 of credits once: OpenRouter raises the free-model limit for the
   whole account from 50 to 1,000 requests a day.

Plan models, budgets and limits are in `services/license/catalog.js`; run
`pnpm --filter @lumo/license check-models` after changing them.

## Checklist before publishing a draft

1. CI is green on the tagged commit (web, Rust on all three platforms, audit).
2. Version numbers match in `apps/desktop/src-tauri/tauri.conf.json`, `apps/desktop/src-tauri/Cargo.toml`
   and `apps/desktop/package.json`.
3. Install each installer on a clean machine and walk the first-run journey: onboarding, send a message on
   Free, grant a folder, organize files and undo, approve and deny a sensitive action, stop a run.
4. macOS: confirm the Screen Recording, Accessibility and Microphone prompts appear when the matching feature
   is first used, and that denying them gives a clear message rather than a crash.
5. Computer use: start a task that uses the mouse, press Alt+Shift+Escape and confirm control stops at once.
6. Set `version` in `apps/web/src/data/release.ts` to the published version so the download page links the
   installers, then deploy the site.
7. Plans: Whop checkout links open real purchases. Confirm license activation works against the deployed
   license server before announcing paid plans.
8. Write release notes, then publish the draft (on GitHub, or by running the **Publish release** workflow, which
   publishes it as a pre-release). Untick "pre-release" only for a stable release.

## Building locally

```sh
pnpm install
pnpm --filter @lumo/desktop tauri build          # installers for the current OS
```

Linux needs: `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev
libpipewire-0.3-dev libgbm-dev libxcb1-dev libxrandr-dev libdbus-1-dev`.
