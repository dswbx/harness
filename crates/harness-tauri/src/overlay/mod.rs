//! The Quick overlay (ADR 0022): one floating, always-on-top window (label `overlay`, `/?overlay=1`)
//! that a global shortcut opens at the mouse or at the bottom center of the screen. It is one
//! more Frontend window of the core; this module only creates, places, shows and hides it.
//!
//! The webview owns the overlay's state (`app/src/overlayMode.ts`) and sends each mode here with
//! `overlay_set_mode`. The shortcut only opens: it shows a hidden overlay; on a visible one it focuses
//! it and sends `overlay-shortcut` to the webview (a mini bar expands).
//! In the chat, `render_ui` panels sit beside the card (ADR 0022 Phase 2): the page sends their room
//! with `overlay_set_panels` and the window grows by it, left and right of the card, which stays put.
//! On macOS the window is a non-activating NSPanel (`panel` below), so typing in it does not
//! make Harness the active app.
//! While the overlay shows the prompt (not the chat, not mini), a thread polls what the user is looking at in other apps
//! (`context.rs`, ADR 0022 Phase 3) and sends each change as `overlay-context`.

mod commands;
mod geometry;
#[cfg(target_os = "macos")]
mod panel;
mod poll;
mod window;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::context;
use harness_core::Harness;
use harness_core::api::{AppSettingKey, Command, CommandResult, OverlaySettings};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

pub use commands::*;
use geometry::Rect;
use poll::{Capture, Poll};
pub use window::hide;
use window::{ensure, native_show, show};

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
    /// Only the prompt follows the front app: the chip exists until the first message is sent.
    fn follows_context(self) -> bool {
        self == Mode::Prompt
    }

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
    /// Held for the whole of `overlay_set_settings`: two calls must not interleave across its `.await`.
    set_settings: tokio::sync::Mutex<()>,
    /// Why the shortcut could not be registered (e.g. another app has it).
    shortcut_error: Mutex<Option<String>>,
    /// The page has painted (`overlay_ready`). Before that a show waits (`pending_show`), so no
    /// unpainted (black) window is ever visible.
    ready: Mutex<bool>,
    pending_show: Mutex<bool>,
    /// The window context: the last one sent, and what level 2 is doing.
    context: Mutex<Capture>,
    /// The running context poll (`poll_context`).
    poll: Mutex<Poll>,
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
    // In `bun run dev` the terminal app that runs Harness must have Accessibility.
    #[cfg(debug_assertions)]
    tracing::info!("window context: AXIsProcessTrusted = {}", context::trusted());
    app.manage(Overlay { settings: Mutex::new(settings), shortcut_error: Mutex::new(error), ..Default::default() });
}

/// The global shortcut was pressed.
pub fn on_shortcut(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let visible = handle.get_webview_window(LABEL).and_then(|w| w.is_visible().ok()).unwrap_or(false);
        if visible {
            if let Some(w) = handle.get_webview_window(LABEL) {
                native_show(&w);
            }
            let _ = handle.emit_to(LABEL, "overlay-shortcut", ());
            return;
        }
        if let Err(e) = show(&handle) {
            tracing::warn!("overlay show: {e}");
        }
    });
}

/// Creates the hidden overlay window at startup so its page is loaded and painted before the
/// first shortcut. Call on the main thread, after `init`.
pub fn create(app: &AppHandle) {
    if let Err(e) = ensure(app) {
        tracing::warn!("overlay create: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::Mode;

    #[test]
    fn only_the_prompt_follows_the_context() {
        assert!(Mode::Prompt.follows_context());
        assert!(!Mode::Chat.follows_context());
        assert!(!Mode::Mini.follows_context());
    }
}
