//! The desktop shell: the real `Platform` (native dialogs, notifications, clipboard, screen), the
//! tray, the global shortcut, the compact window and the preview protocol.

use crate::agent::events::ActionPreview;
use crate::core::{Core, Platform};
use crate::error::{LumoError, Result};
use async_trait::async_trait;
use parking_lot::Mutex;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
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

    fn capture_screen(&self) -> Result<(Vec<u8>, u32, u32)> {
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
        Ok((png.into_inner(), w, h))
    }

    fn active_window(&self) -> Result<(String, String)> {
        self.last_window.lock().clone().ok_or_else(|| {
            LumoError::Unavailable("Lumo doesn't know which window you were in. Open Lumo with the keyboard shortcut from that window and try again.".into())
        })
    }

    fn broadcast(&self, event: &str, payload: serde_json::Value) {
        let _ = self.app.emit(event, payload);
    }
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
        .background_color(tauri::window::Color(16, 17, 24, 255))
        .build();
    match built {
        Ok(w) => {
            let _ = w.set_focus();
        }
        Err(e) => log::error!("could not open the compact window: {e}"),
    }
}

pub fn register_shortcut(app: &AppHandle, shortcut: &str) -> Result<()> {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    gs.on_shortcut(shortcut, |app, _sc, ev| {
        if ev.state == ShortcutState::Pressed {
            if let Some(p) = app.try_state::<Arc<TauriPlatform>>() {
                remember_front_window(&p);
            }
            toggle_compact(app);
        }
    })
    .map_err(|e| LumoError::Invalid(format!("Could not use the shortcut {shortcut}: {e}")))
}

pub fn build_tray(app: &AppHandle, core: &Arc<Core>) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Lumo", true, None::<&str>)?;
    let ask = MenuItem::with_id(app, "ask", "Ask Lumo…", true, None::<&str>)?;
    let pause = CheckMenuItem::with_id(app, "pause", "Pause automations", true, core.settings().automations_paused, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Lumo", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &ask, &PredefinedMenuItem::separator(app)?, &pause, &PredefinedMenuItem::separator(app)?, &quit])?;
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
            .header(
                "content-security-policy",
                "default-src 'self' https: data: blob: 'unsafe-inline' 'unsafe-eval'; connect-src https:; frame-ancestors http://tauri.localhost tauri://localhost http://localhost:1420",
            )
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
