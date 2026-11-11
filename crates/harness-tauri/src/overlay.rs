//! The Quick overlay (ADR 0022): one floating, always-on-top window (label `overlay`, `/?overlay=1`)
//! that a global shortcut opens at the mouse or at the bottom center of the screen. It is one
//! more Frontend window of the core; this module only creates, places, shows and hides it.
//!
//! The webview owns the overlay's state (`app/src/overlayMode.ts`) and sends each mode here with
//! `overlay_set_mode`. The shortcut shows a hidden overlay; on a visible one it sends
//! `overlay-shortcut` to the webview, which decides (hide the prompt, minimize, expand).
//! In the chat, `render_ui` panels sit beside the card (ADR 0022 Phase 2): the page sends their room
//! with `overlay_set_panels` and the window grows by it, left and right of the card, which stays put.
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
}

/// Smallest chat window the user can resize to (logical px): a 380x300 card plus the `SHADOW` margin.
const CHAT_MIN: (f64, f64) = (380.0 + 2.0 * SHADOW, 300.0 + 2.0 * SHADOW);

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
/// While a menu is open, the window grows by this much to the right and down (logical px), so menus
/// and submenus are not cut at the window edge. Its top-left stays, so the card does not move.
const MENU_ROOM: f64 = 320.0;

#[derive(Default)]
pub struct Overlay {
    mode: Mutex<Mode>,
    anchor: Mutex<Anchor>,
    /// The chat's window size after the user resized it (logical px), for this app session.
    /// Only `overlay_resize` sets it. Without side panels; they come on top.
    chat_size: Mutex<Option<(f64, f64)>>,
    /// Room for side panels left and right of the chat card (logical px), from the page. Used in
    /// `Mode::Chat` only; the window there is the card frame `beside` this much.
    panels: Mutex<(f64, f64)>,
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

    /// The side panels' room in `mode` (physical px): none outside the chat.
    fn panels(&self, mode: Mode, scale: f64) -> (f64, f64) {
        match mode {
            Mode::Chat => {
                let (l, r) = *self.panels.lock();
                (l * scale, r * scale)
            }
            _ => (0.0, 0.0),
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

/// `frame` grown by `room` to the right and down, but not past `screen`. The top-left stays, so
/// the page's card does not move and the page needs no offset.
pub fn grow(frame: Rect, room: f64, screen: Rect) -> Rect {
    let side = |space: f64| room.min(space).max(0.0);
    let right = side(screen.x + screen.w - frame.x - frame.w);
    let down = side(screen.y + screen.h - frame.y - frame.h);
    Rect { w: frame.w + right, h: frame.h + down, ..frame }
}

/// `frame` at `size` with its top-left kept: not smaller than `min`, not past `screen` less
/// `margin` (the minimum wins on a tiny screen).
pub fn sized(frame: Rect, size: (f64, f64), min: (f64, f64), screen: Rect, margin: f64) -> Rect {
    let w = size.0.min(screen.x + screen.w - margin - frame.x).max(min.0);
    let h = size.1.min(screen.y + screen.h - margin - frame.y).max(min.1);
    Rect { w, h, ..frame }
}

/// The window frame for a card frame with `left` and `right` of side panels beside it.
pub fn beside(card: Rect, left: f64, right: f64) -> Rect {
    Rect { x: card.x - left, w: card.w + left + right, ..card }
}

/// The card frame inside a window frame that has `left` and `right` of side panels (`beside` undone).
pub fn card_of(window: Rect, left: f64, right: f64) -> Rect {
    Rect { x: window.x + left, w: window.w - left - right, ..window }
}

/// The window for a card with side panels: it grows left and right of the card, so the card stays
/// where it is. With no room on one side the whole window moves to stay inside `screen` less
/// `margin` (the card moves with it). A window wider than the screen keeps to the screen's left
/// edge; its width is never cut, so `card_of` stays exact.
pub fn widen(card: Rect, left: f64, right: f64, screen: Rect, margin: f64) -> Rect {
    let f = beside(card, left, right);
    let x = f.x.min(screen.x + screen.w - margin - f.w).max(screen.x + margin);
    Rect { x, ..f }
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

/// `r` (physical px, top-left origin) as an AppKit frame: points, origin at the bottom-left of the main
/// screen (`main_h` points high), y up. The same conversion tao makes for `set_position`.
pub fn cocoa_frame(r: Rect, scale: f64, main_h: f64) -> Rect {
    let (x, y, w, h) = (r.x / scale, r.y / scale, r.w / scale, r.h / scale);
    Rect { x, y: main_h - y - h, w, h }
}

/// Moves and resizes the window. On macOS in one native step (`setFrame:display:animate:`), so a
/// window that grows to the left never shows a frame where it has moved but not grown (or the
/// reverse); elsewhere a resize, then a move. Main thread only.
fn set_frame(window: &WebviewWindow, r: Rect) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    if panel::set_frame(window, r)? {
        return Ok(());
    }
    window.set_size(PhysicalSize::new(r.w.round() as u32, r.h.round() as u32))?;
    window.set_position(PhysicalPosition::new(r.x.round() as i32, r.y.round() as i32))
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
        let (left, right) = state.panels(mode, scale);
        set_frame(&window, widen(Rect { x, y, w: size.0, h: size.1 }, left, right, screen, MARGIN * scale))?;
    }
    native_show(&window);
    let _ = app.emit_to(LABEL, "overlay-shown", anchor);
    Ok(())
}

/// New size for `mode`, keeping the top (or bottom) center where it is: the chat grows down from
/// the prompt box (up, at the bottom of the screen).
/// Side panels (chat only) grow the window left and right of the card; the anchor is the card's.
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
    let (l0, r0) = state.panels(old, scale);
    let card = card_of(current, l0, r0);
    let (w, h) = state.size(mode);
    let size = (w * scale, h * scale);
    let anchor = *state.anchor.lock();
    let point = anchor_point(card, anchor);
    let (left, right) = state.panels(mode, scale);
    let next = match window.current_monitor()? {
        Some(m) => {
            let screen = work_area(&m);
            let (x, y) = place(point, anchor, size, screen, MARGIN * scale);
            widen(Rect { x, y, w: size.0, h: size.1 }, left, right, screen, MARGIN * scale)
        }
        None => {
            let y = if anchor == Anchor::Top { point.1 } else { point.1 - size.1 };
            beside(Rect { x: point.0 - size.0 / 2.0, y, w: size.0, h: size.1 }, left, right)
        }
    };
    set_frame(&window, next)
}

/// The user drags the chat's resize grip: the card (with its shadow margin) becomes `size`
/// (logical px), its top-left kept, within `CHAT_MIN` and the screen; side panels keep their
/// widths beside it. The size is kept for the next chat and expand.
/// A borderless macOS window has no resize edges, so the page draws the grip and sends sizes.
/// Returns the card's new width (logical px, without the margin), or `None` when nothing changed;
/// the page sizes its card from it, after the window has its size.
fn user_resize(app: &AppHandle, size: (f64, f64)) -> tauri::Result<Option<f64>> {
    let state = app.state::<Overlay>();
    if *state.mode.lock() != Mode::Chat || state.menu_base.lock().is_some() {
        return Ok(None);
    }
    let Some(window) = app.get_webview_window(LABEL) else { return Ok(None) };
    let Some(m) = window.current_monitor()? else { return Ok(None) };
    let scale = window.scale_factor()?;
    let (left, right) = state.panels(Mode::Chat, scale);
    let card = card_of(frame(&window)?, left, right);
    let min = (CHAT_MIN.0 * scale, CHAT_MIN.1 * scale);
    // The right panels need room past the card's right edge.
    let screen = work_area(&m);
    let room = Rect { w: screen.w - right, ..screen };
    let r = sized(card, (size.0 * scale, size.1 * scale), min, room, MARGIN * scale);
    set_frame(&window, beside(r, left, right))?;
    *state.chat_size.lock() = Some((r.w / scale, r.h / scale));
    Ok(Some(r.w / scale - 2.0 * SHADOW))
}

/// Grows the window by `MENU_ROOM` to the right and down (`open`), or back to its size before.
/// The top-left never moves, so the card stays in place with no page offset.
fn menu_room(app: &AppHandle, open: bool) -> tauri::Result<()> {
    let state = app.state::<Overlay>();
    let Some(window) = app.get_webview_window(LABEL) else { return Ok(()) };
    let mut base = state.menu_base.lock();
    if !open {
        if let Some(r) = base.take() {
            set_frame(&window, r)?;
        }
        return Ok(());
    }
    if base.is_some() {
        return Ok(());
    }
    let Some(m) = window.current_monitor()? else { return Ok(()) };
    let scale = window.scale_factor()?;
    let current = frame(&window)?;
    set_frame(&window, grow(current, MENU_ROOM * scale, work_area(&m)))?;
    *base = Some(current);
    Ok(())
}

/// The page's side panels want `left` and `right` (logical px) beside the card. In the chat the
/// window grows or shrinks on those sides and the card stays (`widen`); elsewhere it is kept for
/// the next chat. While a menu has room, only the frame to go back to changes.
fn set_panels(app: &AppHandle, left: f64, right: f64) -> tauri::Result<()> {
    let state = app.state::<Overlay>();
    let mode = *state.mode.lock();
    let Some(window) = app.get_webview_window(LABEL) else {
        *state.panels.lock() = (left, right);
        return Ok(());
    };
    let scale = window.scale_factor()?;
    let (l0, r0) = state.panels(mode, scale);
    *state.panels.lock() = (left, right);
    if mode != Mode::Chat {
        return Ok(());
    }
    let mut base = state.menu_base.lock();
    let current = match *base {
        Some(r) => r,
        None => frame(&window)?,
    };
    let card = card_of(current, l0, r0);
    let (l, r) = (left * scale, right * scale);
    let next = match window.current_monitor()? {
        Some(m) => widen(card, l, r, work_area(&m), MARGIN * scale),
        None => beside(card, l, r),
    };
    if base.is_some() {
        *base = Some(next);
        Ok(())
    } else {
        set_frame(&window, next)
    }
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

/// The chat's resize grip was dragged to `width` x `height` (logical window px). Resolves, once the
/// window has its size, to the card's width (logical px), or `None` when it did not resize.
#[tauri::command]
pub async fn overlay_resize(app: AppHandle, width: f64, height: f64) -> Result<Option<f64>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(user_resize(&handle, (width, height)).map_err(|e| e.to_string()));
    })
    .map_err(|e| e.to_string())?;
    rx.await.map_err(|e| e.to_string())?
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
    let (tx, rx) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(menu_room(&handle, open).map_err(|e| e.to_string()));
    })
    .map_err(|e| e.to_string())?;
    rx.await.map_err(|e| e.to_string())?
}

/// The chat's side panels want `left` and `right` (logical px) beside the card. Resolves once the
/// window has its size.
#[tauri::command]
pub async fn overlay_set_panels(app: AppHandle, left: f64, right: f64) -> Result<(), String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(set_panels(&handle, left.max(0.0), right.max(0.0)).map_err(|e| e.to_string()));
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
    use super::Rect;
    // `tauri_panel!` brings its own `msg_send` and `AnyObject`; those below are written with their paths.
    use objc2::{Encode, Encoding, class};
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

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Point {
        x: f64,
        y: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Size {
        w: f64,
        h: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct NsRect {
        origin: Point,
        size: Size,
    }
    // SAFETY: the layouts match CoreGraphics' CGPoint, CGSize and CGRect (two f64 each, `repr(C)`).
    unsafe impl Encode for Point {
        const ENCODING: Encoding = Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
    }
    // SAFETY: as above.
    unsafe impl Encode for Size {
        const ENCODING: Encoding = Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]);
    }
    // SAFETY: as above.
    unsafe impl Encode for NsRect {
        const ENCODING: Encoding = Encoding::Struct("CGRect", &[Point::ENCODING, Size::ENCODING]);
    }

    /// Sets the NSWindow frame in one call (move and resize together, no animation). `r` is in
    /// physical px with a top-left origin, as `outer_position`. False when there is no main screen.
    /// Main thread only.
    pub fn set_frame(window: &WebviewWindow, r: Rect) -> tauri::Result<bool> {
        let scale = window.scale_factor()?;
        let ns_window = window.ns_window()? as *mut objc2::runtime::AnyObject;
        // SAFETY: `ns_window` is this window's live NSWindow; `NSScreen.screens` and `frame` are plain
        // AppKit getters; called on the main thread (all callers run there).
        unsafe {
            let screens: *mut objc2::runtime::AnyObject = objc2::msg_send![class!(NSScreen), screens];
            if screens.is_null() {
                return Ok(false);
            }
            let main: *mut objc2::runtime::AnyObject = objc2::msg_send![screens, firstObject];
            if main.is_null() || ns_window.is_null() {
                return Ok(false);
            }
            let screen: NsRect = objc2::msg_send![main, frame];
            let f = super::cocoa_frame(r, scale, screen.size.h);
            let frame = NsRect { origin: Point { x: f.x, y: f.y }, size: Size { w: f.w, h: f.h } };
            let _: () = objc2::msg_send![ns_window, setFrame: frame, display: true, animate: false];
        }
        Ok(true)
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
    use super::{Anchor, Rect, anchor_point, beside, card_of, cocoa_frame, grow, place, sized, widen};

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
    fn grow_adds_room_right_and_down_only() {
        let card = Rect { x: 500.0, y: 400.0, w: 400.0, h: 200.0 };
        assert_eq!(grow(card, 100.0, SCREEN), Rect { x: 500.0, y: 400.0, w: 500.0, h: 300.0 });
    }

    #[test]
    fn grow_stops_at_the_screen_edges() {
        // Near the bottom-right corner: little room right and down, Radix flips or shifts the menus.
        let card = Rect { x: 1000.0, y: 620.0, w: 400.0, h: 200.0 };
        assert_eq!(grow(card, 100.0, SCREEN), Rect { x: 1000.0, y: 620.0, w: 440.0, h: 280.0 });
        // A frame already past the edge gets no room there (never smaller).
        let off = Rect { x: 1100.0, y: 400.0, w: 400.0, h: 200.0 };
        assert_eq!(grow(off, 100.0, SCREEN).w, 400.0);
    }

    #[test]
    fn sized_keeps_the_top_left_and_clamps() {
        let chat = Rect { x: 500.0, y: 100.0, w: 580.0, h: 600.0 };
        let min = (420.0, 340.0);
        // Free: the asked size, top-left kept.
        assert_eq!(sized(chat, (700.0, 650.0), min, SCREEN, 8.0), Rect { x: 500.0, y: 100.0, w: 700.0, h: 650.0 });
        // Not smaller than the minimum.
        assert_eq!(sized(chat, (100.0, 100.0), min, SCREEN, 8.0), Rect { w: 420.0, h: 340.0, ..chat });
        // Not past the screen less the margin.
        assert_eq!(sized(chat, (5000.0, 5000.0), min, SCREEN, 8.0), Rect { w: 1440.0 - 8.0 - 500.0, h: 900.0 - 8.0 - 100.0, ..chat });
    }

    #[test]
    fn beside_and_card_of_undo_each_other() {
        let card = Rect { x: 500.0, y: 100.0, w: 580.0, h: 600.0 };
        let window = beside(card, 300.0, 420.0);
        assert_eq!(window, Rect { x: 200.0, y: 100.0, w: 1300.0, h: 600.0 });
        assert_eq!(card_of(window, 300.0, 420.0), card);
    }

    #[test]
    fn widen_keeps_the_card_in_place_when_there_is_room() {
        let card = Rect { x: 400.0, y: 100.0, w: 580.0, h: 600.0 };
        // Right panels grow the window to the right only, left ones to the left only.
        assert_eq!(widen(card, 0.0, 420.0, SCREEN, 8.0), Rect { w: 1000.0, ..card });
        assert_eq!(widen(card, 320.0, 0.0, SCREEN, 8.0), Rect { x: 80.0, w: 900.0, ..card });
    }

    #[test]
    fn widen_moves_the_window_when_a_side_has_no_room() {
        // Near the right edge: the window moves left, the card with it.
        let card = Rect { x: 800.0, y: 100.0, w: 580.0, h: 600.0 };
        let w = widen(card, 0.0, 420.0, SCREEN, 8.0);
        assert_eq!(w.x + w.w, 1440.0 - 8.0);
        assert_eq!(w.w, 1000.0);
        assert_eq!(card_of(w, 0.0, 420.0).x, 1440.0 - 8.0 - 1000.0);
        // Near the left edge: it moves right.
        let card = Rect { x: 50.0, ..card };
        assert_eq!(widen(card, 320.0, 0.0, SCREEN, 8.0).x, 8.0);
    }

    #[test]
    fn widen_wider_than_the_screen_keeps_its_width_at_the_left_edge() {
        let card = Rect { x: 400.0, y: 100.0, w: 580.0, h: 600.0 };
        let w = widen(card, 500.0, 500.0, SCREEN, 8.0);
        assert_eq!((w.x, w.w), (8.0, 1580.0));
    }

    #[test]
    fn cocoa_frame_flips_y_and_converts_to_points() {
        // A 2x screen 900 points high: a window 100 points from the top, 300 points high.
        let r = Rect { x: 200.0, y: 200.0, w: 1000.0, h: 600.0 };
        assert_eq!(cocoa_frame(r, 2.0, 900.0), Rect { x: 100.0, y: 900.0 - 100.0 - 300.0, w: 500.0, h: 300.0 });
        // Growing to the left keeps the right edge and the bottom: one frame, both changes.
        let grown = Rect { x: 0.0, w: 1200.0, ..r };
        let (a, b) = (cocoa_frame(r, 2.0, 900.0), cocoa_frame(grown, 2.0, 900.0));
        assert_eq!((a.x + a.w, a.y), (b.x + b.w, b.y));
    }

    #[test]
    fn closing_panels_shrinks_back_around_the_same_card() {
        let card = Rect { x: 400.0, y: 100.0, w: 580.0, h: 600.0 };
        let open = widen(card, 320.0, 420.0, SCREEN, 8.0);
        let back = widen(card_of(open, 320.0, 420.0), 0.0, 0.0, SCREEN, 8.0);
        assert_eq!(back, card);
    }
}
