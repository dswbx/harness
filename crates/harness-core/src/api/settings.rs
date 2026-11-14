//! App settings types.

use serde::{Deserialize, Serialize};
use specta::Type;

/// App settings kept as JSON files in the data dir (`app_settings.rs`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum AppSettingKey {
    Appearance,
    Themes,
    /// `OverlaySettings`: the Quick overlay's global shortcut and where it opens.
    Overlay,
}

/// The Quick overlay's settings (`AppSettingKey::Overlay`, `overlay.json`). Missing fields take
/// their defaults, so an older or hand-edited file still loads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default)]
pub struct OverlaySettings {
    /// Global shortcut in the `global-hotkey` format, e.g. `Alt+Space`, `CmdOrCtrl+Shift+K`.
    pub shortcut: String,
    pub position: OverlayPosition,
    /// While the overlay is open, a removable chip shows the app the user is looking at (and its
    /// window, page, selection); each message sends it as an attachment (ADR 0022 Phase 3).
    pub window_context: bool,
}

impl Default for OverlaySettings {
    fn default() -> Self {
        Self { shortcut: "Alt+Space".to_owned(), position: OverlayPosition::Cursor, window_context: true }
    }
}

/// Where the overlay's prompt box opens: at the mouse, or at the bottom center of that screen.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum OverlayPosition {
    #[default]
    Cursor,
    Bottom,
}

/// The editor "Open in editor" uses: a known editor's URL scheme, a custom URL template
/// (`{path}`, `{line}`), or the system default app (no line).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Editor {
    Vscode,
    Cursor,
    Windsurf,
    Zed,
    Custom { template: String },
    System,
}
