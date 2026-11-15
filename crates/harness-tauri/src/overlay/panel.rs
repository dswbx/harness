//! The NSPanel side (tauri-nspanel). Kept here alone, so it can be replaced with plain objc2.

use super::geometry::Rect;
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
        let f = super::geometry::cocoa_frame(r, scale, screen.size.h);
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
