//! The app menu: Tauri's default menu plus Back / Forward in View. They tell the main window's
//! Shell to move through its navigation history (`nav` event, payload "back" or "forward").
//! Quit is our own item, not the predefined one: the predefined one ends the app at once
//! (`terminate:`), so it cannot ask first while an Agent is working.
//! Release builds add "Install 'harness' Command in PATH…" and "Uninstall 'harness' Command…" to
//! the app menu (`cli.rs`, ADR 0030).

use std::sync::Arc;

use harness_core::host::Harness;
use tauri::menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem};
use tauri::{AppHandle, Emitter, Manager, Runtime};

const BACK: &str = "nav-back";
const FORWARD: &str = "nav-forward";
const QUIT: &str = "app-quit";
const CLI_INSTALL: &str = "cli-install";
const CLI_UNINSTALL: &str = "cli-uninstall";

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;
    let submenus: Vec<_> = menu.items()?.into_iter().filter_map(|i| i.as_submenu().cloned()).collect();
    if let Some(view) = submenus.iter().find(|s| s.text().is_ok_and(|t| t == "View")) {
        view.append_items(&[
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, BACK, "Back", true, Some("Alt+CmdOrCtrl+Left"))?,
            &MenuItem::with_id(app, FORWARD, "Forward", true, Some("Alt+CmdOrCtrl+Right"))?,
        ])?;
    }
    // The link points at the bundle's binary; a dev build has none.
    if let Some(app_menu) = submenus.first().filter(|_| !cfg!(debug_assertions)) {
        app_menu.insert_items(
            &[
                &MenuItem::with_id(app, CLI_INSTALL, "Install 'harness' Command in PATH…", true, None::<&str>)?,
                &MenuItem::with_id(app, CLI_UNINSTALL, "Uninstall 'harness' Command…", true, None::<&str>)?,
                &PredefinedMenuItem::separator(app)?,
            ],
            2,
        )?;
    }
    for sub in &submenus {
        let items = sub.items()?;
        let quit = items.iter().position(|i| matches!(i, MenuItemKind::Predefined(p) if p.text().is_ok_and(|t| t.starts_with("Quit"))));
        if let Some(at) = quit {
            let text = items[at].as_predefined_menuitem().and_then(|p| p.text().ok()).unwrap_or_else(|| "Quit".into());
            sub.remove_at(at)?;
            sub.insert(&MenuItem::with_id(app, QUIT, text, true, Some("CmdOrCtrl+Q"))?, at)?;
        }
    }
    Ok(menu)
}

pub fn on_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let dir = match id {
        BACK => "back",
        FORWARD => "forward",
        QUIT => return quit(app),
        // Dialogs and the password prompt block: off the main thread.
        CLI_INSTALL | CLI_UNINSTALL => {
            let app = app.clone();
            let install = id == CLI_INSTALL;
            std::thread::spawn(move || if install { crate::cli::install(&app) } else { crate::cli::uninstall(&app) });
            return;
        }
        _ => return,
    };
    if let Err(e) = app.emit_to("main", "nav", dir) {
        tracing::warn!("menu nav: {e}");
    }
}

/// Quits, after a confirm dialog when a Session has a Turn in flight (quitting cancels it).
fn quit<R: Runtime>(app: &AppHandle<R>) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let busy = app.try_state::<Arc<Harness>>().map_or(0, |h| h.busy_sessions());
    if busy == 0 {
        return app.exit(0);
    }
    let what = if busy == 1 { "An Agent is working".to_owned() } else { format!("{busy} Agents are working") };
    let app = app.clone();
    app.dialog()
        .message(if busy == 1 { "Quitting stops it and cancels its Turn." } else { "Quitting stops them and cancels their Turns." })
        .title(format!("{what}. Quit anyway?"))
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("Quit".into(), "Cancel".into()))
        .show(move |quit| {
            if quit {
                app.exit(0);
            }
        });
}
