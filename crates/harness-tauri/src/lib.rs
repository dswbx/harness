//! Thin Tauri adapter over harness-core (ADR 0001): `execute`, Session and app subscriptions, the
//! Terminal byte stream, plus macOS niceties (dock badge, notifications).
//! Subscriptions are tied to their webview so reloads and closed windows never leak them.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use harness_core::api::{AppEvent, Command, CommandResult, Event, FrontendManifest, SessionStatus};
use harness_core::Harness;
use harness_core::terminal::TerminalOutput;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{Manager, Webview};

/// Frontend Manifests of the built-in Frontends, registered with core at boot.
const MANIFESTS: &[&str] = &[
    include_str!("../../../packages/frontend-chat/manifest.json"),
    include_str!("../../../packages/frontend-inspector/manifest.json"),
];

#[derive(Default)]
struct Subscriptions {
    /// Webview label -> (session id, subscription id).
    by_webview: Mutex<HashMap<String, Vec<(String, u64)>>>,
    /// Webview label -> app subscription ids.
    app_by_webview: Mutex<HashMap<String, Vec<u64>>>,
    /// Webview label -> (session id, terminal attach id).
    terminals_by_webview: Mutex<HashMap<String, Vec<(String, u64)>>>,
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
        for (session_id, id) in self.terminals_by_webview.lock().unwrap().remove(label).unwrap_or_default() {
            harness.terminal_detach(&session_id, id);
        }
    }
}

#[tauri::command]
async fn execute(harness: tauri::State<'_, Arc<Harness>>, cmd: Command) -> Result<CommandResult, String> {
    harness.execute(cmd).await
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

/// The Session's Terminal: output as raw bytes (an `ArrayBuffer` in JS, no JSON), then
/// `{"exit": code}` when the shell ends.
#[tauri::command]
fn terminal_attach(
    webview: Webview,
    harness: tauri::State<'_, Arc<Harness>>,
    subs: tauri::State<'_, Subscriptions>,
    session_id: String,
    cols: u16,
    rows: u16,
    channel: Channel<InvokeResponseBody>,
) -> Result<u64, String> {
    let id = harness
        .terminal_attach(
            &session_id,
            cols,
            rows,
            Box::new(move |o: TerminalOutput| match o {
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
        .push((session_id, id));
    Ok(id)
}

#[tauri::command]
fn terminal_detach(
    webview: Webview,
    harness: tauri::State<'_, Arc<Harness>>,
    subs: tauri::State<'_, Subscriptions>,
    session_id: String,
    id: u64,
) {
    harness.terminal_detach(&session_id, id);
    if let Some(list) = subs.terminals_by_webview.lock().unwrap().get_mut(webview.label()) {
        list.retain(|(s, i)| !(s == &session_id && *i == id));
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
        .manage(Subscriptions::default())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
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
            // Windows start hidden so the blank (white) webview never shows before the first paint.
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                let _ = webview.window().show();
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
            subscribe,
            unsubscribe,
            subscribe_app,
            terminal_attach,
            terminal_detach
        ])
        .run(tauri::generate_context!())
        .expect("error while running Harness");
}
