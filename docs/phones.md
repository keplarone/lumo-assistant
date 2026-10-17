# Lumo on phones

Lumo ships for Windows, macOS and Linux today. The Rust core is already prepared for an iPhone and
Android app built from the same code with Tauri 2's mobile targets, so the phone app is mostly new
packaging and screens, not a second app.

## What is ready

- **One core for both.** The agent loop, plans and usage limits, accounts and licenses, memory,
  automations, the encrypted database and cloud models are shared. Accounts
  and plans already follow the person across devices.
- **`src-tauri/src/device.rs`** is the one place that says what a device can do. The agent, plans and
  UI ask it instead of checking the operating system. The UI gets the same answer as `device` in
  `app_info` (`DeviceCaps` in `src/lib/ipc.ts`).
- **Computer-only features are left out of phone builds**, both in code and in dependencies:
  screen capture and mouse/keyboard control (`take_screenshot`, `active_window`,
  `control_computer`), developer commands (`run_command`), the system Trash (`move_to_trash`),
  choosing arbitrary folders (`request_folder_access`), the tray and close-to-tray, the global
  shortcut and floating compact window, single-instance handling, window-state saving and
  self-updates (the app stores update phone apps). The agent is never offered a tool the device
  doesn't have.
- **Secrets stay in the device's own secure store.** iPhone: the Keychain's data-protection store,
  readable after the first unlock and never synced or restored to another device. Android: storage
  encrypted with an Android Keystore key. As on computers, there is no plaintext fallback.
- **CI compiles the core for Android and iPhone** on every pull request (`Rust for phones`), so
  nothing desktop-only slips back into shared code.

## What a phone app still needs

1. Generate the native projects: `pnpm tauri android init` and `pnpm tauri ios init` (needs Android
   Studio and Xcode), then add phone icons and splash screens.
2. Phone screens: the redesign makes every screen responsive and touch-friendly down to phone
   size. Hide settings that read `device` as unavailable (shortcut, close to tray, updates).
3. Apple Developer and Google Play accounts, signing, and store listings. Store rules for selling
   plans inside the app (in-app purchase versus Whop links) need a decision before submission.
4. Phone-specific helpers worth adding later: share sheet ("send to Lumo"), widgets, push
   notifications for reminders, and voice.

Ordering apps on a phone works through checkout handoff (Lumo fills in what it can and opens the
merchant's app or site to finish), because phones don't let one app control another.

## Build notes

- `Cargo.lock` holds `libc` at 0.2.189: 0.2.190 dropped `mach_task_self` on iOS, which `num_threads`
  (through `time`, used by Tauri) still calls. Keep it there until `num_threads` moves to `mach2`;
  the iPhone CI check fails if a `cargo update` brings it back.
