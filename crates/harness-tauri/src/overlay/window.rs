//! Showing, hiding, placing and resizing the overlay window.

use super::geometry::{Rect, anchor_point, beside, card_of, grow, place, sized, widen};
#[cfg(target_os = "macos")]
use super::panel;
use super::poll::{start_context, stop_context};
use super::{ABOVE_BOTTOM, Anchor, BELOW_CURSOR, CHAT_MIN, LABEL, MARGIN, MENU_ROOM, Mode, Overlay, SHADOW};
use harness_core::api::OverlayPosition;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub(super) fn work_area(m: &tauri::Monitor) -> Rect {
    let a = m.work_area();
    Rect { x: a.position.x as f64, y: a.position.y as f64, w: a.size.width as f64, h: a.size.height as f64 }
}

pub(super) fn frame(window: &WebviewWindow) -> tauri::Result<Rect> {
    let pos = window.outer_position()?;
    let size = window.outer_size()?;
    Ok(Rect { x: pos.x as f64, y: pos.y as f64, w: size.width as f64, h: size.height as f64 })
}

/// Moves and resizes the window. On macOS in one native step (`setFrame:display:animate:`), so a
/// window that grows to the left never shows a frame where it has moved but not grown (or the
/// reverse); elsewhere a resize, then a move. Main thread only.
pub(super) fn set_frame(window: &WebviewWindow, r: Rect) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    if panel::set_frame(window, r)? {
        return Ok(());
    }
    window.set_size(PhysicalSize::new(r.w.round() as u32, r.h.round() as u32))?;
    window.set_position(PhysicalPosition::new(r.x.round() as i32, r.y.round() as i32))
}

/// The overlay window, created hidden.
pub(super) fn ensure(app: &AppHandle) -> tauri::Result<WebviewWindow> {
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
        .background_color(tauri::window::Color(0, 0, 0, 0))
        .build()?;
    #[cfg(target_os = "macos")]
    panel::convert(&window)?;
    Ok(window)
}

/// Puts the overlay below the mouse (or at the bottom center of the mouse's screen) and shows it.
pub(super) fn show(app: &AppHandle) -> tauri::Result<()> {
    let window = ensure(app)?;
    let state = app.state::<Overlay>();
    // The page has not painted yet: `overlay_ready` shows it.
    if !*state.ready.lock() {
        *state.pending_show.lock() = true;
        return Ok(());
    }
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
    if mode.follows_context() {
        start_context(app, true);
    }
    Ok(())
}

/// New size for `mode`, keeping the top (or bottom) center where it is: the chat grows down from
/// the prompt box (up, at the bottom of the screen).
/// Side panels (chat only) grow the window left and right of the card; the anchor is the card's.
pub(super) fn resize(app: &AppHandle, mode: Mode) -> tauri::Result<()> {
    let state = app.state::<Overlay>();
    let old = std::mem::replace(&mut *state.mode.lock(), mode);
    let Some(window) = app.get_webview_window(LABEL) else { return Ok(()) };
    if !mode.follows_context() {
        stop_context(app);
    } else if window.is_visible()? {
        start_context(app, old != mode);
    }
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
pub(super) fn user_resize(app: &AppHandle, size: (f64, f64), left_edge: bool, top: bool) -> tauri::Result<Option<f64>> {
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
    // The side panels need room past the card's edges.
    let screen = work_area(&m);
    let room = Rect { x: screen.x + left, w: screen.w - left - right, ..screen };
    let size = (size.0 * scale, size.1 * scale);
    let r = sized(card, size, min, room, MARGIN * scale, left_edge, top);
    set_frame(&window, beside(r, left, right))?;
    *state.chat_size.lock() = Some((r.w / scale, r.h / scale));
    Ok(Some(r.w / scale - 2.0 * SHADOW))
}

/// Grows the window by `MENU_ROOM` to the right and down (`open`), or back to its size before.
/// The top-left never moves, so the card stays in place with no page offset.
pub(super) fn menu_room(app: &AppHandle, open: bool) -> tauri::Result<()> {
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
pub(super) fn set_panels(app: &AppHandle, left: f64, right: f64) -> tauri::Result<()> {
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

pub(super) fn native_show(window: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    panel::show(window.app_handle());
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn hide(app: &AppHandle) {
    stop_context(app);
    #[cfg(target_os = "macos")]
    panel::hide(app);
    #[cfg(not(target_os = "macos"))]
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.hide();
    }
}
