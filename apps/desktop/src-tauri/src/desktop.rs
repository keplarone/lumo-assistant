//! The app shell: the real `Platform` (native dialogs, notifications, clipboard, screen), the
//! tray, the global shortcut, the compact window and the preview protocol.
//!
//! The same shell runs on phones. Parts phones don't have (tray, global shortcut, compact window,
//! screen capture and input control) are compiled for computers only; see `crate::device`.

use crate::agent::events::ActionPreview;
use crate::core::{Core, Platform, Screenshot};
use crate::error::{LumoError, Result};
use crate::tools::computer::InputAction;
use async_trait::async_trait;
use parking_lot::Mutex;
use std::path::PathBuf;
#[cfg(desktop)]
use std::sync::Arc;
#[cfg(desktop)]
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
#[cfg(desktop)]
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};
#[cfg(desktop)]
use tauri::{WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
#[cfg(desktop)]
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

pub struct TauriPlatform {
    pub app: AppHandle,
    /// The window in front when the user last summoned Lumo. Kept in memory only.
    pub last_window: Mutex<Option<(String, String)>>,
}

#[async_trait]
impl Platform for TauriPlatform {
    async fn native_confirm(&self, preview: &ActionPreview) -> bool {
        let mut text = String::new();
        for (k, v) in &preview.details {
            text.push_str(&format!("{k}: {v}\n"));
        }
        if let Some(w) = &preview.warning {
            text.push_str(&format!("\n{w}"));
        }
        let (tx, rx) = tokio::sync::oneshot::channel();
        #[cfg_attr(mobile, allow(unused_mut))]
        let mut b = self
            .app
            .dialog()
            .message(text.trim().to_string())
            .title(format!("Lumo: {}", preview.title))
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom("Allow".into(), "Don't Allow".into()));
        #[cfg(desktop)]
        if let Some(w) = self.app.get_webview_window("main") {
            b = b.parent(&w);
        }
        b.show(move |ok| {
            let _ = tx.send(ok);
        });
        rx.await.unwrap_or(false)
    }

    fn notify(&self, title: &str, body: &str) -> Result<()> {
        self.app
            .notification()
            .builder()
            .title(title)
            .body(body)
            .show()
            .map_err(|e| LumoError::Unavailable(format!("could not show a notification: {e}")))
    }

    fn open_url(&self, url: &str) -> Result<()> {
        self.app.opener().open_url(url, None::<&str>).map_err(|e| LumoError::Unavailable(format!("could not open the browser: {e}")))
    }

    fn clipboard_read(&self) -> Result<String> {
        Ok(self.app.clipboard().read_text().unwrap_or_default())
    }

    fn clipboard_write(&self, text: &str) -> Result<()> {
        self.app.clipboard().write_text(text.to_string()).map_err(|e| LumoError::Unavailable(format!("could not use the clipboard: {e}")))
    }

    #[cfg(mobile)]
    async fn pick_folder(&self) -> Option<PathBuf> {
        // Phones don't let apps pick arbitrary folders; Lumo works in its own projects folder there.
        None
    }

    #[cfg(desktop)]
    async fn pick_folder(&self) -> Option<PathBuf> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let mut b = self.app.dialog().file().set_title("Choose a folder for Lumo");
        if let Some(w) = self.app.get_webview_window("main") {
            b = b.set_parent(&w);
        }
        b.pick_folder(move |p| {
            let _ = tx.send(p.and_then(|p| p.into_path().ok()));
        });
        rx.await.ok().flatten()
    }

    fn capture_screen(&self) -> Result<Screenshot> {
        capture_primary_screen()
    }

    fn perform_input(&self, actions: &[InputAction]) -> Result<()> {
        send_input(actions)
    }

    fn input_control_changed(&self, active: bool) {
        #[cfg(desktop)]
        stop_shortcut_and_tray(&self.app, active);
        let _ =
            self.app.emit("input-control", serde_json::json!({ "active": active, "stopShortcut": crate::tools::computer::STOP_SHORTCUT }));
    }

    fn active_window(&self) -> Result<(String, String)> {
        self.last_window.lock().clone().ok_or_else(|| {
            LumoError::Unavailable(
                "Lumo doesn't know which window you were in. Open Lumo with the keyboard shortcut from that window and try again.".into(),
            )
        })
    }

    async fn current_position(&self) -> Result<crate::location::Fix> {
        crate::location::os_position().await
    }

    fn broadcast(&self, event: &str, payload: serde_json::Value) {
        let _ = self.app.emit(event, payload);
    }
}

#[cfg(desktop)]
fn capture_primary_screen() -> Result<Screenshot> {
    let monitors = xcap::Monitor::all().map_err(|e| LumoError::Unavailable(format!("screen capture is not available: {e}")))?;
    let m = monitors
        .iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .or(monitors.first())
        .ok_or_else(|| LumoError::Unavailable("no display found".into()))?;
    let img = m.capture_image().map_err(|e| {
        LumoError::Unavailable(format!(
            "Lumo could not capture the screen ({e}). On macOS, allow Lumo under System Settings → Privacy & Security → Screen Recording."
        ))
    })?;
    // Logical size of the display, which is what input coordinates use.
    let (sw, sh) = (m.width().unwrap_or(img.width()), m.height().unwrap_or(img.height()));
    let (ox, oy) = (m.x().unwrap_or(0), m.y().unwrap_or(0));
    // Downscale large displays: fewer tokens, same usefulness.
    let img = if img.width() > 1568 {
        let h = (img.height() as f64 * 1568.0 / img.width() as f64) as u32;
        xcap::image::imageops::resize(&img, 1568, h, xcap::image::imageops::FilterType::Triangle)
    } else {
        img
    };
    let (w, h) = (img.width(), img.height());
    let mut png = std::io::Cursor::new(Vec::new());
    img.write_to(&mut png, xcap::image::ImageFormat::Png).map_err(|e| LumoError::Other(e.into()))?;
    Ok(Screenshot { png: png.into_inner(), width: w, height: h, origin_x: ox, origin_y: oy, screen_width: sw, screen_height: sh })
}

#[cfg(desktop)]
fn send_input(actions: &[InputAction]) -> Result<()> {
    use enigo::{Axis, Button, Coordinate, Direction, Enigo, Keyboard, Mouse, Settings};
    let mut e = Enigo::new(&Settings::default()).map_err(|e| {
        LumoError::Unavailable(format!(
            "Lumo can't control input on this system ({e}). On macOS, allow Lumo under System Settings → Privacy & Security → Accessibility."
        ))
    })?;
    let err = |e: enigo::InputError| LumoError::Unavailable(format!("input failed: {e}"));
    let pause = || std::thread::sleep(std::time::Duration::from_millis(60));
    for a in actions {
        match a {
            InputAction::MoveTo { x, y } => e.move_mouse(*x, *y, Coordinate::Abs).map_err(err)?,
            InputAction::Click { x, y, button, count } => {
                e.move_mouse(*x, *y, Coordinate::Abs).map_err(err)?;
                pause();
                let b = match button.as_deref() {
                    Some("right") => Button::Right,
                    Some("middle") => Button::Middle,
                    _ => Button::Left,
                };
                for _ in 0..count.unwrap_or(1) {
                    e.button(b, Direction::Click).map_err(err)?;
                }
            }
            InputAction::Drag { from_x, from_y, to_x, to_y } => {
                e.move_mouse(*from_x, *from_y, Coordinate::Abs).map_err(err)?;
                e.button(Button::Left, Direction::Press).map_err(err)?;
                pause();
                e.move_mouse(*to_x, *to_y, Coordinate::Abs).map_err(err)?;
                pause();
                e.button(Button::Left, Direction::Release).map_err(err)?;
            }
            InputAction::Scroll { x, y, dx, dy } => {
                e.move_mouse(*x, *y, Coordinate::Abs).map_err(err)?;
                if *dy != 0 {
                    e.scroll(*dy, Axis::Vertical).map_err(err)?;
                }
                if *dx != 0 {
                    e.scroll(*dx, Axis::Horizontal).map_err(err)?;
                }
            }
            InputAction::Type { text } => e.text(text).map_err(err)?,
            InputAction::Key { keys } => {
                let parts = crate::tools::computer::parse_keys(keys)?;
                let keys: Vec<enigo::Key> = parts.iter().map(|p| to_key(p)).collect();
                for k in &keys[..keys.len() - 1] {
                    e.key(*k, Direction::Press).map_err(err)?;
                }
                e.key(keys[keys.len() - 1], Direction::Click).map_err(err)?;
                for k in keys[..keys.len() - 1].iter().rev() {
                    e.key(*k, Direction::Release).map_err(err)?;
                }
            }
            InputAction::Wait { ms } => std::thread::sleep(std::time::Duration::from_millis(*ms as u64)),
        }
        pause();
    }
    Ok(())
}

/// While Lumo controls input: the stop shortcut works everywhere and the tray says so.
#[cfg(desktop)]
fn stop_shortcut_and_tray(app: &AppHandle, active: bool) {
    let gs = app.global_shortcut();
    if active {
        let res = gs.on_shortcut(crate::tools::computer::STOP_SHORTCUT, |app, _sc, ev| {
            if ev.state == ShortcutState::Pressed {
                if let Some(state) = app.try_state::<crate::commands::AppState>() {
                    let ids: Vec<String> = state.core.pending.input_sessions.lock().iter().cloned().collect();
                    for id in ids {
                        crate::agent::cancel(&state.core, &id);
                        crate::tools::computer::end_session(&state.core, &id);
                    }
                }
            }
        });
        if let Err(e) = res {
            log::warn!("could not register the stop shortcut: {e}");
        }
        if let Some(tray) = app.tray_by_id("lumo") {
            let _ = tray.set_tooltip(Some("Lumo is using your mouse and keyboard"));
        }
    } else {
        let _ = gs.unregister(crate::tools::computer::STOP_SHORTCUT);
        if let Some(tray) = app.tray_by_id("lumo") {
            let _ = tray.set_tooltip(Some("Lumo"));
        }
    }
}

/// Phones don't let apps see or control the screen, so these tools are never offered there.
#[cfg(mobile)]
fn capture_primary_screen() -> Result<Screenshot> {
    Err(LumoError::Unavailable("Screen capture is only available in Lumo on a computer.".into()))
}

#[cfg(mobile)]
fn send_input(_actions: &[InputAction]) -> Result<()> {
    Err(LumoError::Unavailable("Controlling the mouse and keyboard is only available in Lumo on a computer.".into()))
}

#[cfg(desktop)]
/// Note the focused window before Lumo takes focus (for `get_active_window`).
pub fn remember_front_window(platform: &TauriPlatform) {
    let found = xcap::Window::all().ok().and_then(|ws| {
        ws.into_iter()
            .find(|w| w.is_focused().unwrap_or(false) && !w.app_name().unwrap_or_default().to_lowercase().contains("lumo"))
            .map(|w| (w.app_name().unwrap_or_default(), w.title().unwrap_or_default()))
    });
    if found.is_some() {
        *platform.last_window.lock() = found;
    }
}

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        #[cfg(desktop)]
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// The floating assistant: a small window that stays on top, opened with the global shortcut.
#[cfg(desktop)]
pub fn toggle_compact(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("compact") {
        if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) {
            let _ = w.hide();
        } else {
            let _ = w.show();
            let _ = w.set_focus();
        }
        return;
    }
    let built = WebviewWindowBuilder::new(app, "compact", WebviewUrl::App("index.html#/compact".into()))
        .title("Lumo")
        .inner_size(460.0, 560.0)
        .min_inner_size(380.0, 300.0)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(true)
        .center()
        .background_color(tauri::window::Color(16, 17, 24, 255))
        .build();
    match built {
        Ok(w) => {
            let _ = w.set_focus();
        }
        Err(e) => log::error!("could not open the compact window: {e}"),
    }
}

#[cfg(desktop)]
static MAIN_SHORTCUT: Mutex<Option<String>> = Mutex::new(None);

#[cfg(desktop)]
pub fn register_shortcut(app: &AppHandle, shortcut: &str) -> Result<()> {
    let gs = app.global_shortcut();
    if let Some(prev) = MAIN_SHORTCUT.lock().take() {
        let _ = gs.unregister(prev.as_str());
    }
    gs.on_shortcut(shortcut, |app, _sc, ev| {
        if ev.state == ShortcutState::Pressed {
            if let Some(p) = app.try_state::<Arc<TauriPlatform>>() {
                remember_front_window(&p);
            }
            toggle_compact(app);
        }
    })
    .map_err(|e| LumoError::Invalid(format!("Could not use the shortcut {shortcut}: {e}")))?;
    *MAIN_SHORTCUT.lock() = Some(shortcut.to_string());
    Ok(())
}

#[cfg(desktop)]
pub fn build_tray(app: &AppHandle, core: &Arc<Core>) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Lumo", true, None::<&str>)?;
    let ask = MenuItem::with_id(app, "ask", "Ask Lumo…", true, None::<&str>)?;
    let pause = CheckMenuItem::with_id(app, "pause", "Pause automations", true, core.settings().automations_paused, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Lumo", true, None::<&str>)?;
    let menu =
        Menu::with_items(app, &[&open, &ask, &PredefinedMenuItem::separator(app)?, &pause, &PredefinedMenuItem::separator(app)?, &quit])?;
    let core2 = core.clone();
    TrayIconBuilder::with_id("lumo")
        .icon(app.default_window_icon().cloned().expect("app icon"))
        .tooltip("Lumo")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, ev| match ev.id().as_ref() {
            "open" => show_main(app),
            "ask" => toggle_compact(app),
            "pause" => {
                let mut s = core2.settings();
                s.automations_paused = !s.automations_paused;
                if crate::settings::save(&core2.db, &s).is_ok() {
                    let _ = app.emit("settings-changed", ());
                }
            }
            "quit" => {
                for r in core2.pending.runs.lock().values() {
                    r.cancel.cancel();
                }
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// The policy for every preview response. `sandbox` (without `allow-same-origin`,
/// `allow-top-navigation` or `allow-popups`) gives the page an opaque origin and keeps it from
/// navigating Lumo's window. That matters because `preview:` is one of Lumo's own protocols, which
/// Tauri treats as a local origin: a preview page that took over the top-level window would be
/// handed the IPC bridge. The webview's iframe sets the same sandbox, but this header is enforced
/// from Rust, so it holds even if the UI forgets it or the URL is opened some other way.
pub const PREVIEW_CSP: &str = "sandbox allow-scripts allow-forms; default-src 'self' preview: http://preview.localhost https: data: blob: 'unsafe-inline' 'unsafe-eval'; connect-src https:; frame-ancestors http://tauri.localhost tauri://localhost http://localhost:1420";

/// Serve project files to the preview pane: `preview://localhost/<project-id>/<path>`.
pub fn preview_response(core: &Core, uri_path: &str) -> tauri::http::Response<Vec<u8>> {
    let trimmed = uri_path.trim_start_matches('/');
    let (id, rest) = trimmed.split_once('/').unwrap_or((trimmed, ""));
    let rest = rest.split(['?', '#']).next().unwrap_or("");
    match crate::tools::projects::preview_file(core, id, rest) {
        Ok((body, mime)) => tauri::http::Response::builder()
            .status(200)
            .header("content-type", mime)
            // Previews are untrusted pages: no access to Lumo, no network beyond public assets.
            .header("content-security-policy", PREVIEW_CSP)
            .header("cache-control", "no-store")
            .body(body)
            .unwrap(),
        Err(e) => tauri::http::Response::builder()
            .status(404)
            .header("content-type", "text/plain; charset=utf-8")
            .body(e.to_string().into_bytes())
            .unwrap(),
    }
}

#[cfg(desktop)]
fn to_key(p: &str) -> enigo::Key {
    use enigo::Key;
    match p {
        "enter" | "return" => Key::Return,
        "tab" => Key::Tab,
        "escape" | "esc" => Key::Escape,
        "backspace" => Key::Backspace,
        "delete" => Key::Delete,
        "space" => Key::Space,
        "up" => Key::UpArrow,
        "down" => Key::DownArrow,
        "left" => Key::LeftArrow,
        "right" => Key::RightArrow,
        "home" => Key::Home,
        "end" => Key::End,
        "pageup" => Key::PageUp,
        "pagedown" => Key::PageDown,
        "ctrl" | "control" => Key::Control,
        "alt" | "option" => Key::Alt,
        "shift" => Key::Shift,
        "cmd" | "command" | "meta" | "super" | "win" => Key::Meta,
        "f1" => Key::F1,
        "f2" => Key::F2,
        "f3" => Key::F3,
        "f4" => Key::F4,
        "f5" => Key::F5,
        "f6" => Key::F6,
        "f7" => Key::F7,
        "f8" => Key::F8,
        "f9" => Key::F9,
        "f10" => Key::F10,
        "f11" => Key::F11,
        "f12" => Key::F12,
        other => Key::Unicode(other.chars().next().unwrap_or(' ')),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::testing::{core_with, FakePlatform};

    #[test]
    fn previews_are_sandboxed_without_top_navigation_or_same_origin() {
        let (core, _d) = core_with(Arc::new(FakePlatform::default()));
        let p = crate::tools::projects::create(&core, "Site", "website", None).unwrap();
        std::fs::write(std::path::Path::new(&p.path).join("index.html"), "<h1>hi</h1>").unwrap();
        let r = preview_response(&core, &format!("/{}/index.html", p.id));
        assert_eq!(r.status(), 200);
        let csp = r.headers().get("content-security-policy").unwrap().to_str().unwrap();
        let sandbox = csp.split(';').next().unwrap().trim();
        assert!(sandbox.starts_with("sandbox "), "{csp}");
        for forbidden in ["allow-same-origin", "allow-top-navigation", "allow-popups"] {
            assert!(!sandbox.contains(forbidden), "{forbidden} in {csp}");
        }
    }
}
