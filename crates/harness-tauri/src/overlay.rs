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
    /// Logical size of the card (what the user sees). The prompt card is taller than the box,
    /// so the box can grow with the text.
    fn card(self) -> (f64, f64) {
        match self {
            Mode::Prompt => (540.0, 260.0),
            Mode::Chat => (540.0, 560.0),
            Mode::Mini => (380.0, 52.0),
        }
    }

    /// Default logical window size: the card plus the transparent `SHADOW` margin on each side.
    fn size(self) -> (f64, f64) {
        let (w, h) = self.card();
        (w + 2.0 * SHADOW, h + 2.0 * SHADOW)
    }

    /// Only the chat can be resized by the user (its size is kept for the app session).
    fn resizable(self) -> bool {
        self == Mode::Chat
    }

    /// Logical minimum window size while the user resizes.
    fn min_size(self) -> Option<(f64, f64)> {
        (self == Mode::Chat).then_some((380.0 + 2.0 * SHADOW, 300.0 + 2.0 * SHADOW))
    }
}

/// Which edge of the card stays at the anchor point: the top for "at the mouse" (the window opens
/// below the mouse and the chat grows down), the bottom for "bottom center" (it grows up).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Anchor {
    #[default]
    Top,
    Bottom,
}

/// Transparent margin around the card, for its CSS shadow (logical px). `Overlay.tsx` pads by
/// the same amount.
const SHADOW: f64 = 20.0;
/// Space kept between the window and the screen edges (logical px).
const MARGIN: f64 = 8.0;
/// `OverlayPosition::Cursor`: the card's top edge this far below the mouse (logical px).
const BELOW_CURSOR: f64 = 12.0;
/// `OverlayPosition::Bottom`: the card's bottom edge this far above the screen's bottom (logical px).
const ABOVE_BOTTOM: f64 = 96.0;
/// While a menu is open, the window grows by this much on each side (logical px), so menus and
/// submenus are not cut at the window edge. The card stays where it is on screen.
const MENU_ROOM: f64 = 320.0;

#[derive(Default)]
pub struct Overlay {
    mode: Mutex<Mode>,
    anchor: Mutex<Anchor>,
    /// The chat's window size after the user resized it (logical px), for this app session.
    chat_size: Mutex<Option<(f64, f64)>>,
    /// The window frame (physical px) before it grew for an open menu.
    menu_base: Mutex<Option<Rect>>,
    settings: Mutex<OverlaySettings>,
    /// Why the shortcut could not be registered (e.g. another app has it).
    shortcut_error: Mutex<Option<String>>,
}

impl Overlay {
    /// Logical window size for `mode`: the user's chat size, else the default.
    fn size(&self, mode: Mode) -> (f64, f64) {
        match mode {
            Mode::Chat => self.chat_size.lock().unwrap_or(mode.size()),
            _ => mode.size(),
        }
    }
}

/// A screen area or window frame, in one unit (physical px here).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Space added on each side of the window, in one unit.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
pub struct Insets {
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    pub left: f64,
}

/// The point of `frame` that `anchor` keeps in place: its top or bottom center.
pub fn anchor_point(frame: Rect, anchor: Anchor) -> (f64, f64) {
    let x = frame.x + frame.w / 2.0;
    match anchor {
        Anchor::Top => (x, frame.y),
        Anchor::Bottom => (x, frame.y + frame.h),
    }
}

/// Top-left of a `size` window whose top (or bottom) center is at `point`, moved so it is inside
/// `screen` with `margin` around it. A window larger than the screen keeps to its top-left.
pub fn place(point: (f64, f64), anchor: Anchor, size: (f64, f64), screen: Rect, margin: f64) -> (f64, f64) {
    let (w, h) = size;
    let top = match anchor {
        Anchor::Top => point.1,
        Anchor::Bottom => point.1 - h,
    };
    let x = (point.0 - w / 2.0).min(screen.x + screen.w - margin - w).max(screen.x + margin);
    let y = top.min(screen.y + screen.h - margin - h).max(screen.y + margin);
    (x, y)
}

/// `frame` grown by `room` on each side, but not past `screen`. Returns the new frame and what
/// was added on each side (the page moves its card by that much, so it stays in place).
pub fn grow(frame: Rect, room: f64, screen: Rect) -> (Rect, Insets) {
    let side = |space: f64| room.min(space).max(0.0);
    let i = Insets {
        top: side(frame.y - screen.y),
        right: side(screen.x + screen.w - frame.x - frame.w),
        bottom: side(screen.y + screen.h - frame.y - frame.h),
        left: side(frame.x - screen.x),
    };
    let r = Rect { x: frame.x - i.left, y: frame.y - i.top, w: frame.w + i.left + i.right, h: frame.h + i.top + i.bottom };
    (r, i)
}

fn work_area(m: &tauri::Monitor) -> Rect {
    let a = m.work_area();
    Rect { x: a.position.x as f64, y: a.position.y as f64, w: a.size.width as f64, h: a.size.height as f64 }
}

fn frame(window: &WebviewWindow) -> tauri::Result<Rect> {
    let pos = window.outer_position()?;
    let size = window.outer_size()?;
    Ok(Rect { x: pos.x as f64, y: pos.y as f64, w: size.width as f64, h: size.height as f64 })
}

fn set_frame(window: &WebviewWindow, r: Rect) -> tauri::Result<()> {
    window.set_size(PhysicalSize::new(r.w.round() as u32, r.h.round() as u32))?;
    window.set_position(PhysicalPosition::new(r.x.round() as i32, r.y.round() as i32))
}

/// Resizable and minimum size for `mode`, then the frame (physical px). The minimum is cleared
/// first, so a smaller mode (mini) is not held at the chat's minimum.
fn apply(window: &WebviewWindow, mode: Mode, r: Rect) -> tauri::Result<()> {
    window.set_min_size(None::<tauri::Size>)?;
    window.set_resizable(mode.resizable())?;
    set_frame(window, r)?;
    if let Some((w, h)) = mode.min_size() {
        window.set_min_size(Some(tauri::LogicalSize::new(w, h)))?;
    }
    Ok(())
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

/// Puts the overlay below the mouse (or at the bottom center of the mouse's screen) and shows it.
fn show(app: &AppHandle) -> tauri::Result<()> {
    let window = ensure(app)?;
    let state = app.state::<Overlay>();
    let mode = *state.mode.lock();
    let position = state.settings.lock().position;
    let anchor = match position {
        OverlayPosition::Cursor => Anchor::Top,
        OverlayPosition::Bottom => Anchor::Bottom,
    };
    *state.anchor.lock() = anchor;
    // A menu left open when the window was hidden: the page drops its room on `overlay-shown`.
    *state.menu_base.lock() = None;
    let cursor = app.cursor_position()?;
    let monitor = match app.monitor_from_point(cursor.x, cursor.y)? {
        Some(m) => Some(m),
        None => app.primary_monitor()?,
    };
    if let Some(m) = monitor {
        let scale = m.scale_factor();
        let screen = work_area(&m);
        let (w, h) = state.size(mode);
        let size = (w * scale, h * scale);
        // The point is where the card's edge goes; the window edge is `SHADOW` further out.
        let point = match anchor {
            Anchor::Top => (cursor.x, cursor.y + (BELOW_CURSOR - SHADOW) * scale),
            Anchor::Bottom => (screen.x + screen.w / 2.0, screen.y + screen.h - (ABOVE_BOTTOM - SHADOW) * scale),
        };
        let (x, y) = place(point, anchor, size, screen, MARGIN * scale);
        apply(&window, mode, Rect { x, y, w: size.0, h: size.1 })?;
    }
    native_show(&window);
    let _ = app.emit_to(LABEL, "overlay-shown", anchor);
    Ok(())
}

/// The chat's current size is the user's: kept for the next chat (and expand after minimize).
fn remember_chat_size(state: &Overlay, frame: Rect, scale: f64) {
    *state.chat_size.lock() = Some((frame.w / scale, frame.h / scale));
}

/// New size for `mode`, keeping the top (or bottom) center where it is: the chat grows down from
/// the prompt box (up, at the bottom of the screen).
fn resize(app: &AppHandle, mode: Mode) -> tauri::Result<()> {
    let state = app.state::<Overlay>();
    let old = std::mem::replace(&mut *state.mode.lock(), mode);
    let Some(window) = app.get_webview_window(LABEL) else { return Ok(()) };
    let scale = window.scale_factor()?;
    // An open menu's room is dropped (the page drops it on a mode change too).
    let current = match state.menu_base.lock().take() {
        Some(r) => r,
        None => frame(&window)?,
    };
    if old == Mode::Chat && mode != Mode::Chat {
        remember_chat_size(&state, current, scale);
    }
    let (w, h) = state.size(mode);
    let size = (w * scale, h * scale);
    let anchor = *state.anchor.lock();
    let point = anchor_point(current, anchor);
    let (x, y) = match window.current_monitor()? {
        Some(m) => place(point, anchor, size, work_area(&m), MARGIN * scale),
        None => (point.0 - size.0 / 2.0, if anchor == Anchor::Top { point.1 } else { point.1 - size.1 }),
    };
    apply(&window, mode, Rect { x, y, w: size.0, h: size.1 })
}

/// Grows the window by `MENU_ROOM` on each side (`open`), or back to its size before. Returns
/// what was added on each side, in logical px: the page pads its card by that much.
fn menu_room(app: &AppHandle, open: bool) -> tauri::Result<Insets> {
    let state = app.state::<Overlay>();
    let Some(window) = app.get_webview_window(LABEL) else { return Ok(Insets::default()) };
    let scale = window.scale_factor()?;
    let mut base = state.menu_base.lock();
    if !open {
        if let Some(r) = base.take() {
            apply(&window, *state.mode.lock(), r)?;
        }
        return Ok(Insets::default());
    }
    let current = match *base {
        Some(r) => r,
        None => frame(&window)?,
    };
    let Some(m) = window.current_monitor()? else { return Ok(Insets::default()) };
    let (grown, i) = grow(current, MENU_ROOM * scale, work_area(&m));
    // The user cannot resize the window while it has the menu room (its edges are not the card's).
    window.set_min_size(None::<tauri::Size>)?;
    window.set_resizable(false)?;
    set_frame(&window, grown)?;
    *base = Some(current);
    Ok(Insets { top: i.top / scale, right: i.right / scale, bottom: i.bottom / scale, left: i.left / scale })
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

/// A menu opened (`open`) or all closed in the overlay page. Returns the room added on each side.
#[tauri::command]
pub async fn overlay_set_menu_room(app: AppHandle, open: bool) -> Result<Insets, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(menu_room(&handle, open).map_err(|e| e.to_string()));
    })
    .map_err(|e| e.to_string())?;
    rx.await.map_err(|e| e.to_string())?
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
        let base = state.menu_base.lock().take();
        let old = std::mem::replace(&mut *state.mode.lock(), Mode::Prompt);
        if old == Mode::Chat
            && let Some(w) = handle.get_webview_window(LABEL)
            && let (Ok(scale), Some(r)) = (w.scale_factor(), base.or_else(|| frame(&w).ok()))
        {
            remember_chat_size(&state, r, scale);
        }
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
    use super::{Anchor, Insets, Rect, anchor_point, grow, place};

    const SCREEN: Rect = Rect { x: 0.0, y: 25.0, w: 1440.0, h: 875.0 };

    #[test]
    fn top_anchor_opens_below_the_point_centered() {
        assert_eq!(place((720.0, 300.0), Anchor::Top, (480.0, 300.0), SCREEN, 8.0), (480.0, 300.0));
    }

    #[test]
    fn bottom_anchor_centers_the_bottom_edge_on_the_point() {
        assert_eq!(place((720.0, 600.0), Anchor::Bottom, (480.0, 300.0), SCREEN, 8.0), (480.0, 300.0));
    }

    #[test]
    fn clamps_to_the_left_and_right_edges() {
        assert_eq!(place((10.0, 300.0), Anchor::Top, (480.0, 300.0), SCREEN, 8.0).0, 8.0);
        assert_eq!(place((1430.0, 300.0), Anchor::Top, (480.0, 300.0), SCREEN, 8.0).0, 1440.0 - 8.0 - 480.0);
    }

    #[test]
    fn no_room_below_the_mouse_moves_it_up() {
        assert_eq!(place((720.0, 850.0), Anchor::Top, (480.0, 300.0), SCREEN, 8.0).1, 25.0 + 875.0 - 8.0 - 300.0);
    }

    #[test]
    fn clamps_to_the_top_and_bottom_edges() {
        // Below the screen (bottom anchor near the Dock): moves up.
        assert_eq!(place((720.0, 990.0), Anchor::Bottom, (480.0, 300.0), SCREEN, 8.0).1, 25.0 + 875.0 - 8.0 - 300.0);
        // Above the screen (mouse at the menu bar, card edge above it): moves down under the work area's top.
        assert_eq!(place((720.0, 10.0), Anchor::Top, (480.0, 300.0), SCREEN, 8.0).1, 25.0 + 8.0);
    }

    #[test]
    fn a_window_larger_than_the_screen_keeps_to_its_top_left() {
        let small = Rect { x: 100.0, y: 50.0, w: 300.0, h: 200.0 };
        assert_eq!(place((250.0, 60.0), Anchor::Top, (480.0, 580.0), small, 8.0), (108.0, 58.0));
    }

    #[test]
    fn works_on_a_second_screen_left_of_the_main_one() {
        let left = Rect { x: -1920.0, y: 0.0, w: 1920.0, h: 1080.0 };
        assert_eq!(place((-1900.0, 200.0), Anchor::Top, (480.0, 300.0), left, 8.0), (-1912.0, 200.0));
    }

    #[test]
    fn resize_keeps_the_anchored_edge() {
        let prompt = Rect { x: 480.0, y: 300.0, w: 480.0, h: 300.0 };
        let top = anchor_point(prompt, Anchor::Top);
        assert_eq!(top, (720.0, 300.0));
        // The chat grows down from the same top center.
        assert_eq!(place(top, Anchor::Top, (580.0, 500.0), SCREEN, 8.0), (430.0, 300.0));
        let bottom = anchor_point(prompt, Anchor::Bottom);
        assert_eq!(place(bottom, Anchor::Bottom, (580.0, 500.0), SCREEN, 8.0), (430.0, 100.0));
    }

    #[test]
    fn grow_adds_room_on_every_side_with_space() {
        let card = Rect { x: 500.0, y: 400.0, w: 400.0, h: 200.0 };
        let (r, i) = grow(card, 100.0, SCREEN);
        assert_eq!(i, Insets { top: 100.0, right: 100.0, bottom: 100.0, left: 100.0 });
        assert_eq!(r, Rect { x: 400.0, y: 300.0, w: 600.0, h: 400.0 });
    }

    #[test]
    fn grow_stops_at_the_screen_edges() {
        // Near the top-right corner: little room up and right, the menus flip to the other sides.
        let card = Rect { x: 1000.0, y: 45.0, w: 400.0, h: 200.0 };
        let (r, i) = grow(card, 100.0, SCREEN);
        assert_eq!(i, Insets { top: 20.0, right: 40.0, bottom: 100.0, left: 100.0 });
        assert_eq!(r, Rect { x: 900.0, y: 25.0, w: 540.0, h: 320.0 });
        // A frame already past the edge gets no room there (never negative).
        let off = Rect { x: -10.0, y: 400.0, w: 400.0, h: 200.0 };
        assert_eq!(grow(off, 100.0, SCREEN).1.left, 0.0);
    }
}
