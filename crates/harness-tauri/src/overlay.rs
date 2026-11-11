//! The Quick overlay (ADR 0022): one floating, always-on-top window (label `overlay`, `/?overlay=1`)
//! that a global shortcut opens at the mouse or at the bottom center of the screen. It is one
//! more Frontend window of the core; this module only creates, places, shows and hides it.
//!
//! The webview owns the overlay's state (`app/src/overlayMode.ts`) and sends each mode here with
//! `overlay_set_mode`. The shortcut shows a hidden overlay; on a visible one it sends
//! `overlay-shortcut` to the webview, which decides (hide the prompt, minimize, expand).
//! On macOS the window is a non-activating NSPanel (`panel` below), so typing in it does not
//! make Harness the active app.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use harness_core::Harness;
use harness_core::api::{AppSettingKey, Command, CommandResult, OverlayPosition, OverlaySettings};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

pub const LABEL: &str = "overlay";

/// What the overlay shows: the prompt box of a draft, the pinned chat, or the minimized bar.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    #[default]
    Prompt,
    Chat,
    Mini,
}

impl Mode {
    /// Logical window size. It is larger than the visible card: the CSS shadow (and, for the
    /// prompt, the menus that open above the box) need the transparent space around it.
    fn size(self) -> (f64, f64) {
        match self {
            Mode::Prompt => (480.0, 300.0),
            Mode::Chat => (480.0, 580.0),
            Mode::Mini => (380.0, 72.0),
        }
    }
}

/// Space kept between the window and the screen edges (logical px).
const MARGIN: f64 = 8.0;
/// The prompt opens with its bottom edge this far below the mouse (logical px).
const BELOW_CURSOR: f64 = 60.0;
/// `OverlayPosition::Bottom`: the bottom edge this far above the screen's bottom (logical px).
const ABOVE_BOTTOM: f64 = 96.0;

#[derive(Default)]
pub struct Overlay {
    mode: Mutex<Mode>,
    settings: Mutex<OverlaySettings>,
    /// Why the shortcut could not be registered (e.g. another app has it).
    shortcut_error: Mutex<Option<String>>,
}

/// A screen area or window frame, in one unit (physical px here).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Top-left of a `size` window whose bottom center is at `anchor`, moved so it is inside `screen`
/// with `margin` around it. A window larger than the screen keeps to its top-left.
pub fn place(anchor: (f64, f64), size: (f64, f64), screen: Rect, margin: f64) -> (f64, f64) {
    let (w, h) = size;
    let x = (anchor.0 - w / 2.0).min(screen.x + screen.w - margin - w).max(screen.x + margin);
    let y = (anchor.1 - h).min(screen.y + screen.h - margin - h).max(screen.y + margin);
    (x, y)
}

fn work_area(m: &tauri::Monitor) -> Rect {
    let a = m.work_area();
    Rect { x: a.position.x as f64, y: a.position.y as f64, w: a.size.width as f64, h: a.size.height as f64 }
}

/// Reads `overlay.json` through the core, registers the shortcut. Call once in `setup`.
pub fn init(app: &AppHandle, harness: &Arc<Harness>) {
    let settings = tauri::async_runtime::block_on(harness.execute(Command::GetAppSetting { key: AppSettingKey::Overlay }))
        .ok()
        .and_then(|r| match r {
            CommandResult::Json { value: Some(v) } => serde_json::from_value::<OverlaySettings>(v).ok(),
            _ => None,
        })
        .unwrap_or_default();
    let error = app.global_shortcut().register(settings.shortcut.as_str()).err().map(|e| e.to_string());
    if let Some(e) = &error {
        tracing::warn!("overlay shortcut {}: {e}", settings.shortcut);
    }
    app.manage(Overlay { settings: Mutex::new(settings), shortcut_error: Mutex::new(error), ..Default::default() });
}

/// The global shortcut was pressed.
pub fn on_shortcut(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let visible = handle.get_webview_window(LABEL).and_then(|w| w.is_visible().ok()).unwrap_or(false);
        if visible {
            let _ = handle.emit_to(LABEL, "overlay-shortcut", ());
        } else if let Err(e) = show(&handle) {
            tracing::warn!("overlay show: {e}");
        }
    });
}

/// The overlay window, created hidden on first use.
fn ensure(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(w) = app.get_webview_window(LABEL) {
        return Ok(w);
    }
    let (w, h) = Mode::Prompt.size();
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("/?overlay=1".into()))
        .title("Harness Quick")
        .inner_size(w, h)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .visible(false)
        .build()?;
    #[cfg(target_os = "macos")]
    panel::convert(&window)?;
    Ok(window)
}

/// Puts the overlay at the mouse (or the bottom center of the mouse's screen) and shows it.
fn show(app: &AppHandle) -> tauri::Result<()> {
    let window = ensure(app)?;
    let state = app.state::<Overlay>();
    let mode = *state.mode.lock();
    let position = state.settings.lock().position;
    let cursor = app.cursor_position()?;
    let monitor = match app.monitor_from_point(cursor.x, cursor.y)? {
        Some(m) => Some(m),
        None => app.primary_monitor()?,
    };
    if let Some(m) = monitor {
        let scale = m.scale_factor();
        let screen = work_area(&m);
        let (w, h) = mode.size();
        let size = (w * scale, h * scale);
        let anchor = match position {
            OverlayPosition::Cursor => (cursor.x, cursor.y + BELOW_CURSOR * scale),
            OverlayPosition::Bottom => (screen.x + screen.w / 2.0, screen.y + screen.h - ABOVE_BOTTOM * scale),
        };
        let (x, y) = place(anchor, size, screen, MARGIN * scale);
        window.set_size(PhysicalSize::new(size.0.round() as u32, size.1.round() as u32))?;
        window.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32))?;
    }
    native_show(&window);
    let _ = app.emit_to(LABEL, "overlay-shown", ());
    Ok(())
}

/// New size for `mode`, keeping the bottom center where it is (the prompt box stays put).
fn resize(app: &AppHandle, mode: Mode) -> tauri::Result<()> {
    *app.state::<Overlay>().mode.lock() = mode;
    let Some(window) = app.get_webview_window(LABEL) else { return Ok(()) };
    let pos = window.outer_position()?;
    let old = window.outer_size()?;
    let scale = window.scale_factor()?;
    let (w, h) = mode.size();
    let size = (w * scale, h * scale);
    let anchor = (pos.x as f64 + old.width as f64 / 2.0, pos.y as f64 + old.height as f64);
    let (x, y) = match window.current_monitor()? {
        Some(m) => place(anchor, size, work_area(&m), MARGIN * scale),
        None => (anchor.0 - size.0 / 2.0, anchor.1 - size.1),
    };
    window.set_size(PhysicalSize::new(size.0.round() as u32, size.1.round() as u32))?;
    window.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32))?;
    Ok(())
}

fn native_show(window: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    panel::show(window.app_handle());
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn hide(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    panel::hide(app);
    #[cfg(not(target_os = "macos"))]
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.hide();
    }
}

/// Same as the shortcut: show when hidden, else let the webview decide.
#[tauri::command]
pub fn overlay_toggle(app: AppHandle) {
    on_shortcut(&app);
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
        *handle.state::<Overlay>().mode.lock() = Mode::Prompt;
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

/// Registers a changed shortcut (the old one stays when that fails) and saves the settings.
#[tauri::command]
pub async fn overlay_set_settings(
    app: AppHandle,
    harness: tauri::State<'_, Arc<Harness>>,
    overlay: tauri::State<'_, Overlay>,
    settings: OverlaySettings,
) -> Result<OverlayStatus, String> {
    let old = overlay.settings.lock().shortcut.clone();
    let registered = overlay.shortcut_error.lock().is_none();
    let gs = app.global_shortcut();
    if settings.shortcut != old {
        gs.register(settings.shortcut.as_str()).map_err(|e| format!("{}: {e}", settings.shortcut))?;
        if registered {
            let _ = gs.unregister(old.as_str());
        }
        *overlay.shortcut_error.lock() = None;
    } else if !registered {
        // Same shortcut, failed before (another app had it): try again, but save the rest anyway.
        *overlay.shortcut_error.lock() = gs.register(old.as_str()).err().map(|e| e.to_string());
    }
    let value = serde_json::to_value(&settings).map_err(|e| e.to_string())?;
    harness.execute(Command::SetAppSetting { key: AppSettingKey::Overlay, value: Some(value) }).await.map_err(|e| e.message)?;
    *overlay.settings.lock() = settings;
    Ok(overlay_settings(overlay))
}

/// The NSPanel side (tauri-nspanel). Kept here alone, so it can be replaced with plain objc2.
#[cfg(target_os = "macos")]
mod panel {
    use tauri::{AppHandle, WebviewWindow};
    use tauri_nspanel::{CollectionBehavior, ManagerExt, PanelLevel, StyleMask, WebviewWindowExt, tauri_panel};

    tauri_panel! {
        panel!(OverlayPanel {
            config: {
                can_become_key_window: true,
                can_become_main_window: false,
                is_floating_panel: true,
                hides_on_deactivate: false
            }
        })
    }

    /// Floating, on every Space and over full-screen apps, and non-activating: it takes the
    /// keyboard while the other app stays active. Runs on the main thread (window creation).
    pub fn convert(window: &WebviewWindow) -> tauri::Result<()> {
        let panel = window.to_panel::<OverlayPanel>()?;
        panel.set_level(PanelLevel::Floating.into());
        if let Err(e) = panel.add_style_mask(StyleMask::empty().nonactivating_panel().into()) {
            tracing::warn!("overlay panel style: {e}");
        }
        panel.set_collection_behavior(CollectionBehavior::new().can_join_all_spaces().full_screen_auxiliary().into());
        panel.set_hides_on_deactivate(false);
        Ok(())
    }

    pub fn show(app: &AppHandle) {
        if let Ok(p) = app.get_webview_panel(super::LABEL) {
            p.show_and_make_key();
        }
    }

    pub fn hide(app: &AppHandle) {
        if let Ok(p) = app.get_webview_panel(super::LABEL) {
            p.hide();
        }
    }

    /// Makes Harness the active app (merge: the overlay never activated it). Main thread only.
    pub fn activate_app() {
        // SAFETY: `NSApplication.sharedApplication` exists in an AppKit app; called on the main thread.
        unsafe {
            let ns_app: *mut objc2::runtime::AnyObject = objc2::msg_send![objc2::class!(NSApplication), sharedApplication];
            let _: () = objc2::msg_send![ns_app, activateIgnoringOtherApps: true];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Rect, place};

    const SCREEN: Rect = Rect { x: 0.0, y: 25.0, w: 1440.0, h: 875.0 };

    #[test]
    fn centers_the_bottom_edge_on_the_anchor() {
        assert_eq!(place((720.0, 600.0), (480.0, 300.0), SCREEN, 8.0), (480.0, 300.0));
    }

    #[test]
    fn clamps_to_the_left_and_right_edges() {
        assert_eq!(place((10.0, 600.0), (480.0, 300.0), SCREEN, 8.0).0, 8.0);
        assert_eq!(place((1430.0, 600.0), (480.0, 300.0), SCREEN, 8.0).0, 1440.0 - 8.0 - 480.0);
    }

    #[test]
    fn clamps_to_the_top_and_bottom_edges() {
        // Below the screen (mouse near the Dock): moves up.
        assert_eq!(place((720.0, 990.0), (480.0, 300.0), SCREEN, 8.0).1, 25.0 + 875.0 - 8.0 - 300.0);
        // Above the screen (mouse at the menu bar): moves down under the work area's top.
        assert_eq!(place((720.0, 30.0), (480.0, 300.0), SCREEN, 8.0).1, 25.0 + 8.0);
    }

    #[test]
    fn a_window_larger_than_the_screen_keeps_to_its_top_left() {
        let small = Rect { x: 100.0, y: 50.0, w: 300.0, h: 200.0 };
        assert_eq!(place((250.0, 250.0), (480.0, 580.0), small, 8.0), (108.0, 58.0));
    }

    #[test]
    fn works_on_a_second_screen_left_of_the_main_one() {
        let left = Rect { x: -1920.0, y: 0.0, w: 1920.0, h: 1080.0 };
        assert_eq!(place((-1900.0, 500.0), (480.0, 300.0), left, 8.0), (-1912.0, 200.0));
    }
}
