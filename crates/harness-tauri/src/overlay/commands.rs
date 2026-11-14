//! The `#[tauri::command]` functions the overlay page calls.

use std::sync::Arc;

use serde::{Deserialize, Serialize};

#[cfg(target_os = "macos")]
use super::panel;
use super::poll::{start_context, stop_context};
use super::window::{hide, menu_room, on_main, resize, set_panels, show, user_resize};
use super::{LABEL, Mode, Overlay, SHADOW};
use crate::context::WindowContext;
use harness_core::Harness;
use harness_core::api::{AppSettingKey, Command, OverlaySettings};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

/// The page painted its first frame: the window may show now, and does when a shortcut waited.
#[tauri::command]
pub fn overlay_ready(app: AppHandle) {
    let state = app.state::<Overlay>();
    *state.ready.lock() = true;
    if std::mem::take(&mut *state.pending_show.lock()) {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Err(e) = show(&handle) {
                tracing::warn!("overlay show: {e}");
            }
        });
    }
}

#[tauri::command]
pub fn overlay_set_mode(app: AppHandle, mode: Mode) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Err(e) = resize(&handle, mode) {
            tracing::warn!("overlay resize: {e}");
        }
    });
}

/// A resize corner of the chat was dragged to `width` x `height` (logical window px): `left` / `top`
/// say which corner, the opposite one stays. Resolves, once the window has its size, to the card's
/// width (logical px), or `None` when it did not resize.
#[tauri::command]
pub async fn overlay_resize(app: AppHandle, width: f64, height: f64, left: bool, top: bool) -> Result<Option<f64>, String> {
    on_main(&app, move |h| user_resize(h, (width, height), left, top)).await
}

/// The chat card's width (logical px, without the margin): the user's size, else the default. The page
/// gives its card this fixed width; the window's width never changes it.
#[tauri::command]
pub fn overlay_chat_width(overlay: tauri::State<'_, Overlay>) -> f64 {
    overlay.size(Mode::Chat).0 - 2.0 * SHADOW
}

/// A menu opened (`open`) or all closed in the overlay page. Resolves once the window has its size.
#[tauri::command]
pub async fn overlay_set_menu_room(app: AppHandle, open: bool) -> Result<(), String> {
    on_main(&app, move |h| menu_room(h, open)).await
}

/// The chat's side panels want `left` and `right` (logical px) beside the card. Resolves once the
/// window has its size.
#[tauri::command]
pub async fn overlay_set_panels(app: AppHandle, left: f64, right: f64) -> Result<(), String> {
    on_main(&app, move |h| set_panels(h, left.max(0.0), right.max(0.0))).await
}

#[tauri::command]
pub fn overlay_hide(app: AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || hide(&handle));
}

/// Opens the Session in the main window (shown, focused, Harness the active app) and hides the overlay.
#[tauri::command]
pub fn overlay_merge(app: AppHandle, session_id: String) -> Result<(), String> {
    app.emit_to("main", "select-session", session_id).map_err(|e| e.to_string())?;
    let handle = app.clone();
    app.run_on_main_thread(move || {
        hide(&handle);
        let state = handle.state::<Overlay>();
        *state.menu_base.lock() = None;
        *state.mode.lock() = Mode::Prompt;
        *state.panels.lock() = (0.0, 0.0);
        if let Some(main) = handle.get_webview_window("main") {
            let _ = main.unminimize();
            let _ = main.show();
            let _ = main.set_focus();
        }
        #[cfg(target_os = "macos")]
        panel::activate_app();
    })
    .map_err(|e| e.to_string())
}

/// The last window context sent (the page may mount after `overlay-context` was sent).
#[tauri::command]
pub fn overlay_context(overlay: tauri::State<'_, Overlay>) -> Option<WindowContext> {
    overlay.context.lock().ctx.clone()
}

/// A Privacy & Security pane of System Settings, where the user can allow Harness.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PrivacyPane {
    Accessibility,
    Automation,
}

/// Opens System Settings > Privacy & Security > Accessibility or Automation (the chip's "Allow
/// more context", "Allow browser access"). Harness never asks for a permission itself.
#[tauri::command]
pub fn overlay_open_privacy_settings(app: AppHandle, pane: PrivacyPane) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let anchor = match pane {
        PrivacyPane::Accessibility => "Privacy_Accessibility",
        PrivacyPane::Automation => "Privacy_Automation",
    };
    let url = format!("x-apple.systempreferences:com.apple.preference.security?{anchor}");
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

/// The settings and why the shortcut is not registered, if it is not.
#[derive(Debug, Clone, Serialize)]
pub struct OverlayStatus {
    settings: OverlaySettings,
    shortcut_error: Option<String>,
}

#[tauri::command]
pub fn overlay_settings(overlay: tauri::State<'_, Overlay>) -> OverlayStatus {
    OverlayStatus { settings: overlay.settings.lock().clone(), shortcut_error: overlay.shortcut_error.lock().clone() }
}

/// Registers a changed shortcut (the old one stays when that fails) and saves the settings. When
/// the save fails the shortcut change is undone, so the registration always matches the stored settings.
#[tauri::command]
pub async fn overlay_set_settings(
    app: AppHandle,
    harness: tauri::State<'_, Arc<Harness>>,
    overlay: tauri::State<'_, Overlay>,
    settings: OverlaySettings,
) -> Result<OverlayStatus, String> {
    let _serial = overlay.set_settings.lock().await;
    let old = overlay.settings.lock().shortcut.clone();
    let prev_error = overlay.shortcut_error.lock().clone();
    let registered = prev_error.is_none();
    let gs = app.global_shortcut();
    let switched = settings.shortcut != old;
    if switched {
        gs.register(settings.shortcut.as_str()).map_err(|e| format!("{}: {e}", settings.shortcut))?;
        if registered {
            let _ = gs.unregister(old.as_str());
        }
        *overlay.shortcut_error.lock() = None;
    } else if !registered {
        // Same shortcut, failed before (another app had it): try again, but save the rest anyway.
        *overlay.shortcut_error.lock() = gs.register(old.as_str()).err().map(|e| e.to_string());
    }
    let saved = match serde_json::to_value(&settings) {
        Ok(value) => harness.execute(Command::SetAppSetting { key: AppSettingKey::Overlay, value: Some(value) }).await.map_err(|e| e.message),
        Err(e) => Err(e.to_string()),
    };
    if let Err(e) = saved {
        if switched {
            // Not saved: the old shortcut stays the setting, so put the registration back as it was.
            let _ = gs.unregister(settings.shortcut.as_str());
            *overlay.shortcut_error.lock() = if registered { gs.register(old.as_str()).err().map(|e| e.to_string()) } else { prev_error };
        }
        return Err(e);
    }
    let context_on = settings.window_context;
    let context_was = std::mem::replace(&mut *overlay.settings.lock(), settings).window_context;
    if context_on != context_was {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            let state = handle.state::<Overlay>();
            if !context_on {
                stop_context(&handle);
                let mut c = state.context.lock();
                c.id += 1;
                c.ctx = None;
                let _ = handle.emit_to(LABEL, "overlay-context", None::<WindowContext>);
            } else if state.mode.lock().follows_context() && handle.get_webview_window(LABEL).and_then(|w| w.is_visible().ok()).unwrap_or(false) {
                start_context(&handle, true);
            }
        });
    }
    Ok(OverlayStatus { settings: overlay.settings.lock().clone(), shortcut_error: overlay.shortcut_error.lock().clone() })
}
