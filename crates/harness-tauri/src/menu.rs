//! The app menu: Tauri's default menu plus Back / Forward in View. They tell the main window's
//! Shell to move through its navigation history (`nav` event, payload "back" or "forward").

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::{AppHandle, Emitter, Runtime};

const BACK: &str = "nav-back";
const FORWARD: &str = "nav-forward";

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;
    let view = menu.items()?.into_iter().find_map(|i| i.as_submenu().filter(|s| s.text().is_ok_and(|t| t == "View")).cloned());
    if let Some(view) = view {
        view.append_items(&[
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, BACK, "Back", true, Some("Alt+CmdOrCtrl+Left"))?,
            &MenuItem::with_id(app, FORWARD, "Forward", true, Some("Alt+CmdOrCtrl+Right"))?,
        ])?;
    }
    Ok(menu)
}

pub fn on_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let dir = match id {
        BACK => "back",
        FORWARD => "forward",
        _ => return,
    };
    if let Err(e) = app.emit_to("main", "nav", dir) {
        tracing::warn!("menu nav: {e}");
    }
}
