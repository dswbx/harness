//! Opt-in self-update from GitHub Releases (`latest.json`, stable only). Release builds check at
//! launch and every few hours; a newer release only shows as available. The user starts the
//! download (`update_install`), then restarts when they like. The app shell follows
//! `update-state`. Dev builds never update.

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

const EVERY: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Clone, Serialize, Default)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UpdateState {
    #[default]
    Idle,
    Available { version: String },
    Downloading { version: String, percent: Option<u8> },
    Ready { version: String },
    Failed { version: String, error: String },
}

#[derive(Default)]
pub struct Updates {
    /// One check or install at a time.
    busy: tokio::sync::Mutex<()>,
    state: Mutex<(UpdateState, Option<Update>)>,
}

fn set(app: &AppHandle, state: UpdateState, update: Option<Update>) {
    let updates = app.state::<Updates>();
    let mut s = updates.state.lock().unwrap();
    if update.is_some() {
        s.1 = update;
    }
    s.0 = state.clone();
    let _ = app.emit("update-state", state);
}

fn current(app: &AppHandle) -> UpdateState {
    app.state::<Updates>().state.lock().unwrap().0.clone()
}

/// Looks for a newer release; marks it available without downloading. Leaves a download in
/// progress or an installed update alone.
async fn check(app: &AppHandle) -> Result<UpdateState, String> {
    if cfg!(debug_assertions) {
        return Err("Updates only work in release builds".into());
    }
    let updates = app.state::<Updates>();
    let _busy = updates.busy.lock().await;
    if matches!(current(app), UpdateState::Downloading { .. } | UpdateState::Ready { .. }) {
        return Ok(current(app));
    }
    let found = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    match found {
        Some(update) => set(app, UpdateState::Available { version: update.version.clone() }, Some(update)),
        None => set(app, UpdateState::Idle, None),
    }
    Ok(current(app))
}

pub fn spawn_checks(app: &AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            if let Err(e) = check(&app).await {
                tracing::warn!("update check failed: {e}");
            }
            tokio::time::sleep(EVERY).await;
        }
    });
}

#[tauri::command]
pub fn update_state(app: AppHandle) -> UpdateState {
    current(&app)
}

#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<UpdateState, String> {
    check(&app).await
}

/// Downloads and installs the available update; it applies on the next restart.
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    let updates = app.state::<Updates>();
    let _busy = updates.busy.lock().await;
    let Some(update) = updates.state.lock().unwrap().1.clone() else {
        return Err("No update available".into());
    };
    let version = update.version.clone();
    set(&app, UpdateState::Downloading { version: version.clone(), percent: None }, None);
    let (mut done, mut last) = (0u64, None);
    let result = update
        .download_and_install(
            |chunk, total| {
                done += chunk as u64;
                let percent = total.filter(|t| *t > 0).map(|t| (done * 100 / t).min(100) as u8);
                if percent != last {
                    last = percent;
                    set(&app, UpdateState::Downloading { version: version.clone(), percent }, None);
                }
            },
            || {},
        )
        .await;
    match result {
        Ok(()) => {
            tracing::info!(%version, "update installed, waiting for restart");
            set(&app, UpdateState::Ready { version }, None);
            Ok(())
        }
        Err(e) => {
            set(&app, UpdateState::Failed { version, error: e.to_string() }, None);
            Err(e.to_string())
        }
    }
}

#[tauri::command]
pub fn update_restart(app: AppHandle) {
    app.restart();
}
