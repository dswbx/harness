//! Thin Tauri adapter over harness-core (ADR 0001): `execute`, Session and app subscriptions, the
//! Terminal byte stream, plus macOS niceties (dock badge, notifications) and opt-in self-update.
//! Subscriptions are tied to their webview so reloads and closed windows never leak them.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use harness_core::api::{AppEvent, Command, CommandResult, Event, FrontendManifest, SessionStatus};
use harness_core::Harness;
use harness_core::terminal::TerminalOutput;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{Manager, Webview};

mod updates;

/// Frontend Manifests of the built-in Frontends, registered with core at boot.
const MANIFESTS: &[&str] = &[
    include_str!("../../../packages/frontend-chat/manifest.json"),
    include_str!("../../../packages/frontend-inspector/manifest.json"),
];

/// `$HARNESS_HOME`, else `~/.harness` (`~/.harness-dev` for dev builds, so they never touch real data).
fn data_dir(home: std::path::PathBuf) -> std::path::PathBuf {
    match std::env::var_os("HARNESS_HOME") {
        Some(dir) if !dir.is_empty() => dir.into(),
        _ => home.join(if cfg!(debug_assertions) { ".harness-dev" } else { ".harness" }),
    }
}

#[derive(Default)]
struct Subscriptions {
    /// Webview label -> (session id, subscription id).
    by_webview: Mutex<HashMap<String, Vec<(String, u64)>>>,
    /// Webview label -> app subscription ids.
    app_by_webview: Mutex<HashMap<String, Vec<u64>>>,
    /// Webview label -> (session id, terminal id, terminal attach id).
    terminals_by_webview: Mutex<HashMap<String, Vec<(String, u32, u64)>>>,
}

impl Subscriptions {
    fn drop_webview(&self, harness: &Harness, label: &str) {
        let subs = self.by_webview.lock().unwrap().remove(label).unwrap_or_default();
        for (session_id, id) in subs {
            harness.unsubscribe_session(&session_id, id);
        }
        for id in self.app_by_webview.lock().unwrap().remove(label).unwrap_or_default() {
            harness.unsubscribe_app(id);
        }
        for (session_id, terminal_id, id) in self.terminals_by_webview.lock().unwrap().remove(label).unwrap_or_default() {
            harness.terminal_detach(&session_id, terminal_id, id);
        }
    }
}

/// Sets the color behind the webview, which replaces its default white until the page paints.
/// `show` puts the window, which starts hidden, on screen after the color is set, still fully
/// transparent: a webview only renders once on screen, and its first frame can be white. The page
/// calls `reveal_window` once it has painted.
#[tauri::command]
fn set_window_background(window: tauri::WebviewWindow, rgb: Option<(u8, u8, u8)>, show: bool) -> Result<(), String> {
    if let Some((r, g, b)) = rgb {
        window.set_background_color(Some(tauri::window::Color(r, g, b, 255))).map_err(|e| e.to_string())?;
    }
    // Already visible: a reload, or the fallback got there first.
    if show && !window.is_visible().map_err(|e| e.to_string())? {
        set_window_alpha(window.as_ref().window(), 0.0).map_err(|e| e.to_string())?;
        window.show().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Makes the window opaque: it has painted, or (from the fallback) never will.
#[tauri::command]
fn reveal_window(window: tauri::WebviewWindow) -> Result<(), String> {
    set_window_alpha(window.as_ref().window(), 1.0).map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
fn set_window_alpha(window: tauri::Window, alpha: f64) -> tauri::Result<()> {
    let target = window.clone();
    window.run_on_main_thread(move || {
        let Ok(ns_window) = target.ns_window() else { return };
        // SAFETY: `ns_window` is this live window's NSWindow, and this runs on the main thread.
        unsafe {
            let _: () = objc2::msg_send![ns_window.cast::<objc2::runtime::AnyObject>(), setAlphaValue: alpha];
        }
    })
}

#[cfg(not(target_os = "macos"))]
fn set_window_alpha(_window: tauri::Window, _alpha: f64) -> tauri::Result<()> {
    Ok(())
}

#[tauri::command]
async fn execute(harness: tauri::State<'_, Arc<Harness>>, cmd: Command) -> Result<CommandResult, String> {
    harness.execute(cmd).await
}

/// Saves bytes where the user chooses in the native save dialog; `None` on cancel. The path comes
/// only from the dialog, so a webview cannot write to any other path.
#[tauri::command]
async fn save_file(app: tauri::AppHandle, name: String, data: String) -> Result<Option<String>, String> {
    use base64::Engine;
    use tauri_plugin_dialog::DialogExt;
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|e| format!("invalid file data: {e}"))?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().set_file_name(name).save_file(move |path| {
        let _ = tx.send(path);
    });
    let Some(path) = rx.await.map_err(|e| e.to_string())? else { return Ok(None) };
    let path = path.into_path().map_err(|e| e.to_string())?;
    tokio::fs::write(&path, bytes).await.map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(Some(path.display().to_string()))
}

#[tauri::command]
fn subscribe(
    webview: Webview,
    harness: tauri::State<'_, Arc<Harness>>,
    subs: tauri::State<'_, Subscriptions>,
    session_id: String,
    from_seq: u64,
    channel: Channel<Event>,
) -> Result<u64, String> {
    let id = harness.subscribe_session(
        &session_id,
        from_seq,
        Box::new(move |e: &Event| channel.send(e.clone()).is_ok()),
    )?;
    subs.by_webview
        .lock()
        .unwrap()
        .entry(webview.label().to_owned())
        .or_default()
        .push((session_id, id));
    Ok(id)
}

/// Harness-wide events (session list, attention) for this webview.
#[tauri::command]
fn subscribe_app(
    webview: Webview,
    harness: tauri::State<'_, Arc<Harness>>,
    subs: tauri::State<'_, Subscriptions>,
    channel: Channel<AppEvent>,
) -> u64 {
    let id = harness.subscribe_app(Box::new(move |e: &AppEvent| channel.send(e.clone()).is_ok()));
    subs.app_by_webview.lock().unwrap().entry(webview.label().to_owned()).or_default().push(id);
    id
}

/// A Terminal tab of the Session: the replay as raw bytes then `{"replayed": true}`, live output as raw
/// bytes (an `ArrayBuffer` in JS, no JSON), then `{"exit": code}` when the shell ends.
#[tauri::command]
fn terminal_attach(
    webview: Webview,
    harness: tauri::State<'_, Arc<Harness>>,
    subs: tauri::State<'_, Subscriptions>,
    session_id: String,
    terminal_id: u32,
    cols: u16,
    rows: u16,
    channel: Channel<InvokeResponseBody>,
) -> Result<u64, String> {
    let id = harness
        .terminal_attach(
            &session_id,
            terminal_id,
            cols,
            rows,
            Box::new(move |o: TerminalOutput| match o {
                TerminalOutput::Replay(d) => {
                    (d.is_empty() || channel.send(InvokeResponseBody::Raw(d.to_vec())).is_ok())
                        && channel.send(InvokeResponseBody::Json(r#"{"replayed":true}"#.into())).is_ok()
                }
                TerminalOutput::Data(d) => channel.send(InvokeResponseBody::Raw(d.to_vec())).is_ok(),
                TerminalOutput::Exit(code) => {
                    let _ = channel.send(InvokeResponseBody::Json(serde_json::json!({ "exit": code }).to_string()));
                    false
                }
            }),
        )
        .map_err(|e| format!("{e:#}"))?;
    subs.terminals_by_webview
        .lock()
        .unwrap()
        .entry(webview.label().to_owned())
        .or_default()
        .push((session_id, terminal_id, id));
    Ok(id)
}

#[tauri::command]
fn terminal_detach(
    webview: Webview,
    harness: tauri::State<'_, Arc<Harness>>,
    subs: tauri::State<'_, Subscriptions>,
    session_id: String,
    terminal_id: u32,
    id: u64,
) {
    harness.terminal_detach(&session_id, terminal_id, id);
    if let Some(list) = subs.terminals_by_webview.lock().unwrap().get_mut(webview.label()) {
        list.retain(|(s, t, i)| !(s == &session_id && *t == terminal_id && *i == id));
    }
}

/// Dock badge with the number of Sessions waiting for the user, and notifications while no
/// Harness window has focus: a Session starts waiting, or a Turn ends.
fn watch_attention(app: &tauri::AppHandle, harness: &Harness) {
    use tauri_plugin_notification::NotificationExt;
    let app = app.clone();
    let waiting: Mutex<std::collections::HashSet<String>> = Default::default();
    harness.subscribe_app(Box::new(move |e: &AppEvent| {
        let focused = || app.webview_windows().values().any(|w| w.is_focused().unwrap_or(false));
        if let AppEvent::TurnFinished { title, stop_reason, .. } = e {
            if !focused() {
                let body = match stop_reason.as_str() {
                    "end_turn" => "Finished",
                    "cancelled" => "Stopped",
                    "error" => "Failed",
                    "auth_required" => "Needs you to sign in",
                    _ => "Turn ended",
                };
                let _ = app.notification().builder().title(title.as_str()).body(body).show();
            }
            return true;
        }
        let AppEvent::SessionStatus { session_id, title, status } = e else { return true };
        let count = {
            let mut w = waiting.lock().unwrap();
            let newly = *status == SessionStatus::NeedsAttention && w.insert(session_id.clone());
            if *status != SessionStatus::NeedsAttention {
                w.remove(session_id);
            }
            if newly && !focused() {
                let _ = app.notification().builder().title(title.as_str()).body("Needs your attention").show();
            }
            w.len()
        };
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.set_badge_count(if count == 0 { None } else { Some(count as i64) });
        }
        true
    }));
}

#[tauri::command]
fn unsubscribe(
    webview: Webview,
    harness: tauri::State<'_, Arc<Harness>>,
    subs: tauri::State<'_, Subscriptions>,
    session_id: String,
    id: u64,
) {
    harness.unsubscribe_session(&session_id, id);
    if let Some(list) = subs.by_webview.lock().unwrap().get_mut(webview.label()) {
        list.retain(|(s, i)| !(s == &session_id && *i == id));
    }
}

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,agent_stderr=off".into()),
        )
        .with_writer(std::io::stderr)
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Main window reopens where and at the size it was. Not VISIBLE: windows stay hidden until first paint.
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(tauri_plugin_window_state::StateFlags::all() - tauri_plugin_window_state::StateFlags::VISIBLE)
                .with_filter(|label| label == "main")
                .build(),
        )
        .manage(Subscriptions::default())
        .manage(updates::Updates::default())
        .setup(|app| {
            let data_dir = data_dir(app.path().home_dir()?);
            let exe = std::env::current_exe()?.display().to_string();
            let options = harness_core::host::Options {
                mcp_shim: Some((exe, vec!["mcp-shim".to_owned()])),
                ..Default::default()
            };
            let harness = Harness::with_options(data_dir, Vec::new(), options)?;
            for raw in MANIFESTS {
                harness.register_frontend(serde_json::from_str::<FrontendManifest>(raw)?);
            }
            watch_attention(app.handle(), &harness);
            app.manage(harness);
            if let Some(main) = app.get_webview_window("main") {
                main.set_title(&app.package_info().name)?;
            }
            updates::spawn_checks(app.handle());
            Ok(())
        })
        .on_page_load(|webview, payload| {
            // A (re)loading page starts with no subscriptions.
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                let app = webview.app_handle();
                if let Some(harness) = app.try_state::<Arc<Harness>>() {
                    app.state::<Subscriptions>().drop_webview(&harness, webview.label());
                }
            }
            // Windows start hidden; the page shows them once it has the theme background and has
            // painted (`set_window_background`, `reveal_window`). This is only for a page that
            // never gets that far.
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                let window = webview.window();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(1));
                    let _ = set_window_alpha(window.clone(), 1.0);
                    if !window.is_visible().unwrap_or(true) {
                        let _ = window.show();
                    }
                });
            }
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let app = window.app_handle();
                if let Some(harness) = app.try_state::<Arc<Harness>>() {
                    app.state::<Subscriptions>().drop_webview(&harness, window.label());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            execute,
            set_window_background,
            reveal_window,
            save_file,
            subscribe,
            unsubscribe,
            subscribe_app,
            terminal_attach,
            terminal_detach,
            updates::update_state,
            updates::update_check,
            updates::update_install,
            updates::update_restart
        ])
        .run(tauri::generate_context!())
        .expect("error while running Harness");
}
