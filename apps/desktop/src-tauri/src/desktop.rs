//! The desktop shell: the real `Platform` (native dialogs, notifications, clipboard, screen), the
//! tray, the global shortcut, the compact window and the preview protocol.

use crate::agent::events::ActionPreview;
use crate::core::{Core, Platform, Screenshot};
use crate::error::{LumoError, Result};
use crate::tools::computer::InputAction;
use async_trait::async_trait;
use parking_lot::Mutex;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
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
        let mut b = self
            .app
            .dialog()
            .message(text.trim().to_string())
            .title(format!("Lumo: {}", preview.title))
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom("Allow".into(), "Don't Allow".into()));
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
        // Keep the desktop buddy out of Lumo's own screenshots.
        let buddy = visible_buddy(&self.app);
        if let Some(w) = &buddy {
            let _ = w.hide();
            std::thread::sleep(std::time::Duration::from_millis(80));
        }
        let shot = capture_primary();
        if let Some(w) = buddy {
            // show() does not focus it; the window was also built unfocused.
            let _ = w.show();
        }
        shot
    }

    fn perform_input(&self, actions: &[InputAction]) -> Result<()> {
        use enigo::{Axis, Button, Coordinate, Direction, Enigo, Keyboard, Mouse, Settings};
        let mut e = Enigo::new(&Settings::default()).map_err(|e| {
            LumoError::Unavailable(format!(
                "Lumo can't control input on this system ({e}). On macOS, allow Lumo under System Settings → Privacy & Security → Accessibility."
            ))
        })?;
        let err = |e: enigo::InputError| LumoError::Unavailable(format!("input failed: {e}"));
        let pause = || std::thread::sleep(std::time::Duration::from_millis(60));
        for a in actions {
            // Let the buddy fly to where Lumo is about to act, so the user sees it coming.
            match a {
                InputAction::MoveTo { x, y }
                | InputAction::Click { x, y, .. }
                | InputAction::Drag { from_x: x, from_y: y, .. }
                | InputAction::Scroll { x, y, .. } => point_buddy(&self.app, *x, *y),
                _ => {}
            }
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

    fn input_control_changed(&self, active: bool) {
        let gs = self.app.global_shortcut();
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
            if let Some(tray) = self.app.tray_by_id("lumo") {
                let _ = tray.set_tooltip(Some("Lumo is using your mouse and keyboard"));
            }
        } else {
            let _ = gs.unregister(crate::tools::computer::STOP_SHORTCUT);
            if let Some(tray) = self.app.tray_by_id("lumo") {
                let _ = tray.set_tooltip(Some("Lumo"));
            }
        }
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

fn capture_primary() -> Result<Screenshot> {
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
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// The floating assistant: a small window that stays on top, opened with the global shortcut.
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
        .background_color(tauri::window::Color(247, 249, 253, 255))
        .build();
    match built {
        Ok(w) => {
            let _ = w.set_focus();
        }
        Err(e) => log::error!("could not open the compact window: {e}"),
    }
}

/// The desktop buddy's window label. Only this window may call the `buddy_*` commands.
pub const BUDDY: &str = "buddy";
/// The buddy window's size in logical pixels, and its margin from the screen edges.
const BUDDY_SIZE: (f64, f64) = (220.0, 240.0);
const BUDDY_MARGIN: f64 = 24.0;

/// The buddy window, if it exists and is on screen.
fn visible_buddy(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(BUDDY).filter(|w| w.is_visible().unwrap_or(false))
}

/// Tell the buddy where Lumo is about to act (the logical coordinates enigo uses) and give him a
/// moment to fly there. Only when he is on screen; the event goes to his window alone.
fn point_buddy(app: &AppHandle, x: i32, y: i32) {
    if visible_buddy(app).is_none() {
        return;
    }
    let _ = app.emit_to(BUDDY, "buddy-point", serde_json::json!({ "x": x, "y": y }));
    std::thread::sleep(std::time::Duration::from_millis(280));
}

/// Keep the tray's "Lumo on desktop" check in step with the saved setting.
fn sync_buddy_menu(app: &AppHandle) {
    if let (Some(item), Some(state)) = (app.try_state::<BuddyMenuItem>(), app.try_state::<crate::commands::AppState>()) {
        let _ = item.0.set_checked(state.core.settings().buddy_enabled);
    }
}

struct BuddyMenuItem(CheckMenuItem<tauri::Wry>);

/// Show or remove the desktop buddy: a small transparent, always-on-top window the mascot lives in.
pub fn set_buddy_visible(app: &AppHandle, on: bool) {
    sync_buddy_menu(app);
    let existing = app.get_webview_window(BUDDY);
    if !on {
        if let Some(w) = existing {
            let _ = w.destroy();
        }
        return;
    }
    if let Some(w) = existing {
        let _ = w.show();
        return;
    }
    let built = WebviewWindowBuilder::new(app, BUDDY, WebviewUrl::App("index.html#/buddy".into()))
        .title("Lumo")
        .inner_size(BUDDY_SIZE.0, BUDDY_SIZE.1)
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .focused(false)
        .visible_on_all_workspaces(true)
        .visible(false)
        .build();
    let w = match built {
        Ok(w) => w,
        Err(e) => {
            log::error!("could not open the desktop buddy: {e}");
            return;
        }
    };
    // Bottom-right of the primary display's work area.
    if let Ok(Some(m)) = w.primary_monitor() {
        let area = m.work_area();
        let scale = m.scale_factor();
        let size = w.outer_size().unwrap_or(tauri::PhysicalSize::new((BUDDY_SIZE.0 * scale) as u32, (BUDDY_SIZE.1 * scale) as u32));
        let margin = (BUDDY_MARGIN * scale).round() as i64;
        let x = area.position.x as i64 + area.size.width as i64 - size.width as i64 - margin;
        let y = area.position.y as i64 + area.size.height as i64 - size.height as i64 - margin;
        let rect = Rect { x: area.position.x, y: area.position.y, width: area.size.width, height: area.size.height };
        let (x, y) = clamp_into(&[rect], sat(x), sat(y), size.width, size.height);
        let _ = w.set_position(PhysicalPosition::new(x, y));
    }
    let _ = w.show();
}

fn sat(v: i64) -> i32 {
    v.clamp(i32::MIN as i64, i32::MAX as i64) as i32
}

/// A rectangle in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// A point in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

/// Where the buddy may go, in physical pixels.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuddyScreen {
    /// Each display's work area (the screen minus taskbars and menu bars).
    pub monitors: Vec<Rect>,
    /// Scale factor of the display the buddy is on.
    pub scale: f64,
    /// The buddy window's outer position and size.
    pub window: Rect,
    /// The mouse pointer, when the system reports it.
    pub cursor: Option<Point>,
}

/// Squared distance from a point to a rectangle (0 inside).
fn dist2(r: &Rect, px: i64, py: i64) -> i64 {
    let (x0, y0) = (r.x as i64, r.y as i64);
    let (x1, y1) = (x0 + r.width as i64, y0 + r.height as i64);
    let dx = if px < x0 {
        x0 - px
    } else if px >= x1 {
        px - x1 + 1
    } else {
        0
    };
    let dy = if py < y0 {
        y0 - py
    } else if py >= y1 {
        py - y1 + 1
    } else {
        0
    };
    dx * dx + dy * dy
}

fn clamp_axis(pos: i64, len: i64, start: i64, avail: i64) -> i64 {
    if len >= avail {
        start
    } else {
        pos.clamp(start, start + avail - len)
    }
}

/// Clamp a window's requested top-left (`x`, `y`, size `w`×`h`) so the whole window stays inside the
/// work area of the display that contains, or is nearest to, its centre. All in physical pixels.
/// A window bigger than the area is pinned to the area's top-left. With no displays, unchanged.
pub fn clamp_into(areas: &[Rect], x: i32, y: i32, w: u32, h: u32) -> (i32, i32) {
    let (cx, cy) = (x as i64 + w as i64 / 2, y as i64 + h as i64 / 2);
    let Some(area) = areas.iter().min_by_key(|r| dist2(r, cx, cy)) else {
        return (x, y);
    };
    let nx = clamp_axis(x as i64, w as i64, area.x as i64, area.width as i64);
    let ny = clamp_axis(y as i64, h as i64, area.y as i64, area.height as i64);
    (sat(nx), sat(ny))
}

fn work_areas(w: &WebviewWindow) -> Vec<Rect> {
    w.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let a = m.work_area();
            Rect { x: a.position.x, y: a.position.y, width: a.size.width, height: a.size.height }
        })
        .collect()
}

fn require_buddy(w: &WebviewWindow) -> Result<()> {
    if w.label() == BUDDY {
        Ok(())
    } else {
        Err(crate::error::denied("only the desktop buddy can do this"))
    }
}

/// The displays, the buddy window and the pointer, for the buddy to plan where to fly.
pub fn buddy_screen(w: &WebviewWindow) -> Result<BuddyScreen> {
    require_buddy(w)?;
    let err = |e: tauri::Error| LumoError::Unavailable(format!("could not read the window: {e}"));
    let pos = w.outer_position().map_err(err)?;
    let size = w.outer_size().map_err(err)?;
    let scale = match w.current_monitor() {
        Ok(Some(m)) => m.scale_factor(),
        _ => w.scale_factor().unwrap_or(1.0),
    };
    let cursor = w.app_handle().cursor_position().ok().map(|p| Point { x: p.x, y: p.y });
    Ok(BuddyScreen { monitors: work_areas(w), scale, window: Rect { x: pos.x, y: pos.y, width: size.width, height: size.height }, cursor })
}

/// Move the buddy, kept fully on one display's work area.
pub fn buddy_move(w: &WebviewWindow, x: i32, y: i32) -> Result<()> {
    require_buddy(w)?;
    let size = w.outer_size().map_err(|e| LumoError::Unavailable(format!("could not read the window: {e}")))?;
    let (x, y) = clamp_into(&work_areas(w), x, y, size.width, size.height);
    w.set_position(PhysicalPosition::new(x, y)).map_err(|e| LumoError::Unavailable(format!("could not move the window: {e}")))
}

/// Toggle the buddy setting from the tray (or anywhere outside the settings screen) and apply it.
pub fn set_buddy_enabled(app: &AppHandle, core: &Core, enabled: bool) -> Result<()> {
    let mut s = core.settings();
    s.buddy_enabled = enabled;
    crate::settings::save(&core.db, &s)?;
    let _ = app.emit("settings-changed", ());
    set_buddy_visible(app, s.onboarded && s.buddy_enabled);
    Ok(())
}

static MAIN_SHORTCUT: Mutex<Option<String>> = Mutex::new(None);

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

pub fn build_tray(app: &AppHandle, core: &Arc<Core>) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Lumo", true, None::<&str>)?;
    let ask = MenuItem::with_id(app, "ask", "Ask Lumo…", true, None::<&str>)?;
    let buddy = CheckMenuItem::with_id(app, "buddy", "Lumo on desktop", true, core.settings().buddy_enabled, None::<&str>)?;
    let pause = CheckMenuItem::with_id(app, "pause", "Pause automations", true, core.settings().automations_paused, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Lumo", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&open, &ask, &PredefinedMenuItem::separator(app)?, &buddy, &pause, &PredefinedMenuItem::separator(app)?, &quit],
    )?;
    app.manage(BuddyMenuItem(buddy));
    let core2 = core.clone();
    TrayIconBuilder::with_id("lumo")
        .icon(app.default_window_icon().cloned().expect("app icon"))
        .tooltip("Lumo")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, ev| match ev.id().as_ref() {
            "open" => show_main(app),
            "ask" => toggle_compact(app),
            "buddy" => {
                let on = !core2.settings().buddy_enabled;
                if let Err(e) = set_buddy_enabled(app, &core2, on) {
                    log::warn!("could not change the desktop buddy setting: {e}");
                }
                sync_buddy_menu(app);
            }
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

    fn r(x: i32, y: i32, width: u32, height: u32) -> Rect {
        Rect { x, y, width, height }
    }

    #[test]
    fn buddy_stays_inside_one_display() {
        let one = [r(0, 0, 1920, 1040)];
        // Inside: unchanged.
        assert_eq!(clamp_into(&one, 100, 200, 220, 240), (100, 200));
        // Past the right/bottom edges: pulled back fully on screen.
        assert_eq!(clamp_into(&one, 1900, 1030, 220, 240), (1700, 800));
        // Past the top/left: pushed to the origin.
        assert_eq!(clamp_into(&one, -500, -9000, 220, 240), (0, 0));
        // Extreme values don't overflow.
        assert_eq!(clamp_into(&one, i32::MAX, i32::MIN, 220, 240), (1700, 0));
    }

    #[test]
    fn buddy_picks_the_display_under_or_nearest_its_centre() {
        // A display to the left at negative coordinates, the primary, and one above-right.
        let areas = [r(-1280, 0, 1280, 1024), r(0, 0, 1920, 1080), r(1920, -600, 1600, 900)];
        // Centre on the left display: clamped within it, not jumped to the primary.
        assert_eq!(clamp_into(&areas, -150, 100, 220, 240), (-220, 100));
        // Centre well off the left display: stays on the left display.
        assert_eq!(clamp_into(&areas, -3000, 500, 220, 240), (-1280, 500));
        // Centre on the top-right display, window straddling its bottom edge.
        assert_eq!(clamp_into(&areas, 2000, 250, 220, 240), (2000, 60));
        // Centre in the gap below the top-right display (x > 1920, y > 300): nearest is it.
        assert_eq!(clamp_into(&areas, 3000, 1200, 220, 240), (3000, 60));
        // No displays: left alone.
        assert_eq!(clamp_into(&[], 5, 6, 220, 240), (5, 6));
    }

    #[test]
    fn a_window_bigger_than_the_area_is_pinned_to_its_top_left() {
        let tiny = [r(-100, -50, 200, 100)];
        assert_eq!(clamp_into(&tiny, 400, 400, 220, 240), (-100, -50));
        // Only one axis too big: the other is still clamped normally.
        let wide = [r(0, 0, 200, 1000)];
        assert_eq!(clamp_into(&wide, 50, 900, 220, 240), (0, 760));
    }

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
