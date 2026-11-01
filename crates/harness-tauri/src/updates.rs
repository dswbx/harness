//! Self-update from GitHub Releases (`latest.json`, stable only). Release builds check at launch and
//! every few hours, install in the background, then tell the app shell (`update-ready`) so it can
//! offer a restart. Dev builds never update.

use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

const EVERY: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Default)]
pub struct Updates {
    /// One check at a time.
    checking: tokio::sync::Mutex<()>,
    /// The installed version waiting for a restart.
    ready: std::sync::Mutex<Option<String>>,
}

/// Checks, and installs a newer release if there is one. Returns the version waiting for a restart.
async fn check(app: &AppHandle) -> Result<Option<String>, String> {
    if cfg!(debug_assertions) {
        return Err("Updates only work in release builds".into());
    }
    let state = app.state::<Updates>();
    let _checking = state.checking.lock().await;
    if let Some(v) = state.ready.lock().unwrap().clone() {
        return Ok(Some(v));
    }
    let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    let Some(update) = update else { return Ok(None) };
    update.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    tracing::info!(version = %update.version, "update installed, waiting for restart");
    *state.ready.lock().unwrap() = Some(update.version.clone());
    let _ = app.emit("update-ready", &update.version);
    Ok(Some(update.version))
}

pub fn spawn_checks(app: &AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            match check(&app).await {
                Ok(Some(_)) => return,
                Ok(None) => {}
                Err(e) => tracing::warn!("update check failed: {e}"),
            }
            tokio::time::sleep(EVERY).await;
        }
    });
}

#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<Option<String>, String> {
    check(&app).await
}

/// The installed version waiting for a restart, if any (for windows that missed `update-ready`).
#[tauri::command]
pub fn update_ready(updates: tauri::State<'_, Updates>) -> Option<String> {
    updates.ready.lock().unwrap().clone()
}

#[tauri::command]
pub fn update_restart(app: AppHandle) {
    app.restart();
}
