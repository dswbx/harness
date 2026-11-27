//! Thin Tauri adapter over harness-core (ADR 0001): `execute`, Session Log pages and subscriptions, app subscriptions, the
//! Terminal byte stream, plus macOS niceties (dock badge, notifications), opt-in self-update and
//! the Quick overlay (`overlay/`) and the `harness` command's socket (`cli.rs`).
//! Subscriptions are tied to their webview so reloads and closed windows never leak them.

use parking_lot::Mutex;
use std::sync::Arc;

use harness_core::Harness;
use harness_core::api::{AppEvent, Command, CommandResult, Event, EventSink, HarnessError, Lagged, LogPage, SessionMessage, SessionStatus};
use harness_core::terminal::TerminalOutput;
use subscriptions::Subscriptions;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{Manager, Webview};

pub mod cli;
mod context;
pub mod host_types;
mod links;
mod menu;
mod overlay;
mod subscriptions;
mod updates;

/// Sets the color behind the webview, which replaces its default white until the page paints.
/// `show` puts the window, which starts hidden, on screen after the color is set, still fully
/// transparent: a webview only renders once on screen, and its first frame can be white. The page
/// calls `reveal_window` once it has painted. `focus: false` (a window opened quietly) puts it on
/// screen without taking focus; default true.
#[tauri::command]
fn set_window_background(window: tauri::WebviewWindow, rgb: Option<(u8, u8, u8)>, show: bool, focus: Option<bool>) -> Result<(), String> {
    if let Some((r, g, b)) = rgb {
        window.set_background_color(Some(tauri::window::Color(r, g, b, 255))).map_err(|e| e.to_string())?;
    }
    // Already visible: a reload, or the fallback got there first.
    if show && !window.is_visible().map_err(|e| e.to_string())? {
        set_window_alpha(window.as_ref().window(), 0.0).map_err(|e| e.to_string())?;
        show_window(window.as_ref().window(), focus.unwrap_or(true)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Puts a window on screen. Without `focus` it goes to the front without becoming the key window
/// (macOS; `show()` makes it key). Elsewhere it is a plain `show()`.
fn show_window(window: tauri::Window, focus: bool) -> tauri::Result<()> {
    if focus || !cfg!(target_os = "macos") {
        return window.show();
    }
    order_front(window)
}

#[cfg(target_os = "macos")]
fn order_front(window: tauri::Window) -> tauri::Result<()> {
    let target = window.clone();
    window.run_on_main_thread(move || {
        let Ok(ns_window) = target.ns_window() else { return };
        // SAFETY: `ns_window` is this live window's NSWindow, and this runs on the main thread.
        unsafe {
            let _: () = objc2::msg_send![ns_window.cast::<objc2::runtime::AnyObject>(), orderFront: std::ptr::null::<objc2::runtime::AnyObject>()];
        }
    })
}

#[cfg(not(target_os = "macos"))]
fn order_front(window: tauri::Window) -> tauri::Result<()> {
    window.show()
}

/// Unminimizes, shows and focuses a window, and makes Harness the active app. Main thread only.
pub(crate) fn bring_to_front<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    #[cfg(target_os = "macos")]
    overlay::activate_app();
}

/// Selects the Session in the main window (`select-session`), then on the main thread runs
/// `before` and brings the main window to the front.
pub(crate) fn show_session_in_main(app: &tauri::AppHandle, session_id: String, before: impl FnOnce(&tauri::AppHandle) + Send + 'static) -> Result<(), String> {
    use tauri::Emitter;
    app.emit_to("main", "select-session", session_id).map_err(|e| e.to_string())?;
    let handle = app.clone();
    app.run_on_main_thread(move || {
        before(&handle);
        if let Some(main) = handle.get_webview_window("main") {
            bring_to_front(&main);
        }
    })
    .map_err(|e| e.to_string())
}

/// Brings the window with this label to the front (a panel window, from its rail badge or the
/// sidebar). False when no such window is open.
#[tauri::command]
fn focus_window(app: tauri::AppHandle, label: String) -> Result<bool, String> {
    let Some(window) = app.get_webview_window(&label) else { return Ok(false) };
    app.run_on_main_thread(move || bring_to_front(&window)).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Shows the Session in the main window and brings that window to the front (a panel window's
/// Session chip).
#[tauri::command]
fn show_session(app: tauri::AppHandle, session_id: String) -> Result<(), String> {
    show_session_in_main(&app, session_id, |_| {})
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
async fn execute(harness: tauri::State<'_, Arc<Harness>>, cmd: Command) -> Result<CommandResult, HarnessError> {
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

/// Session Log sink for one webview: Events, then `Lagged` if the core drops it for being too slow.
struct ViewSink(Channel<SessionMessage>);

impl EventSink for ViewSink {
    fn send(&self, event: &Event) -> bool {
        self.0.send(SessionMessage::Event(event.clone())).is_ok()
    }

    fn lagged(&self, last_seq: Option<u64>) {
        let _ = self.0.send(SessionMessage::Lagged(Lagged { last_seq }));
    }
}

/// Blocking work of a command (parsing a big log, forking a shell, taking a lock a load holds)
/// runs on the blocking pool: a sync command would run it on the main thread.
async fn blocking<R: Send + 'static>(f: impl FnOnce() -> R + Send + 'static) -> Result<R, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())
}

/// The webview's generation at the moment its IPC message arrived. Tauri reads command arguments
/// synchronously when it dispatches the command, before an async command's body is spawned, so a
/// reload that lands later makes the registration fail (`Subscriptions::subscribe_at`).
struct Generation(u64);

impl<'de, R: tauri::Runtime> tauri::ipc::CommandArg<'de, R> for Generation {
    fn from_command(command: tauri::ipc::CommandItem<'de, R>) -> Result<Self, tauri::ipc::InvokeError> {
        let webview = command.message.webview();
        Ok(Self(webview.state::<Subscriptions>().generation(webview.label())))
    }
}

/// The replay-then-live hand-over is one step inside the log (`SessionLog::subscribe`), so moving
/// the first parse of the log off the main thread leaves no gap and no duplicate.
#[tauri::command]
async fn subscribe(
    webview: Webview,
    generation: Generation,
    harness: tauri::State<'_, Arc<Harness>>,
    session_id: String,
    from_seq: u64,
    channel: Channel<SessionMessage>,
) -> Result<u64, String> {
    let harness = harness.inner().clone();
    let app = webview.app_handle().clone();
    let label = webview.label().to_owned();
    let generation = generation.0;
    blocking(move || app.state::<Subscriptions>().subscribe_at(&harness, &label, generation, &session_id, from_seq, Box::new(ViewSink(channel)))).await?
}

/// One page of a Session Log for a View that opens the Session (ADR 0029), as one answer. On the
/// blocking pool: the first read of a log parses it. It registers nothing, so it needs no
/// generation: the answer to a webview that reloaded meanwhile is dropped by Tauri.
#[tauri::command]
async fn read_log_page(harness: tauri::State<'_, Arc<Harness>>, session_id: String, from_seq: u64, to_seq: Option<u64>) -> Result<LogPage, String> {
    let harness = harness.inner().clone();
    blocking(move || harness.read_log_page(&session_id, from_seq, to_seq)).await?
}

/// Harness-wide events (session list, attention) for this webview.
#[tauri::command]
fn subscribe_app(webview: Webview, harness: tauri::State<'_, Arc<Harness>>, subs: tauri::State<'_, Subscriptions>, channel: Channel<AppEvent>) -> u64 {
    subs.subscribe_app(&harness, webview.label(), Box::new(move |e: &AppEvent| channel.send(e.clone()).is_ok()))
}

/// A Terminal tab of the Session: the replay as raw bytes then `{"replayed": true}`, live output as raw
/// bytes (an `ArrayBuffer` in JS, no JSON), then `{"exit": code}` when the shell ends.
#[tauri::command]
#[allow(clippy::too_many_arguments, reason = "Tauri maps each IPC argument to a parameter")]
async fn terminal_attach(
    webview: Webview,
    generation: Generation,
    harness: tauri::State<'_, Arc<Harness>>,
    session_id: String,
    terminal_id: u32,
    cols: u16,
    rows: u16,
    channel: Channel<InvokeResponseBody>,
) -> Result<u64, String> {
    let harness = harness.inner().clone();
    let app = webview.app_handle().clone();
    let label = webview.label().to_owned();
    // Starting the shell forks; the replay then live hand-over is atomic inside the Terminal.
    let generation = generation.0;
    blocking(move || {
        app.state::<Subscriptions>().terminal_attach_at(
            &harness,
            &label,
            generation,
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
    })
    .await?
}

#[tauri::command]
async fn terminal_detach(webview: Webview, harness: tauri::State<'_, Arc<Harness>>, session_id: String, terminal_id: u32, id: u64) -> Result<(), String> {
    let harness = harness.inner().clone();
    let app = webview.app_handle().clone();
    let label = webview.label().to_owned();
    blocking(move || app.state::<Subscriptions>().terminal_detach(&harness, &label, &session_id, terminal_id, id)).await
}

/// Dock badge with the number of Sessions waiting for the user, and notifications while no
/// Harness window has focus: a Session starts waiting, or a Turn ends.
fn watch_attention(app: &tauri::AppHandle, harness: &Harness) {
    use tauri_plugin_notification::NotificationExt;
    let app = app.clone();
    let waiting: Mutex<std::collections::HashSet<String>> = Default::default();
    harness.subscribe_app(Box::new(move |e: &AppEvent| {
        if QUITTING.load(std::sync::atomic::Ordering::SeqCst) {
            return true;
        }
        let focused = || app.webview_windows().values().any(|w| w.is_focused().unwrap_or(false));
        if let AppEvent::TurnFinished { title, stop_reason, main, .. } = e {
            if !focused() {
                let body = match (stop_reason.as_str(), *main) {
                    ("end_turn", true) => "Finished",
                    ("end_turn", false) => "Side chat finished",
                    ("cancelled", true) => "Stopped",
                    ("cancelled", false) => "Side chat stopped",
                    ("error", true) => "Failed",
                    ("error", false) => "Side chat failed",
                    ("auth_required", true) => "Needs you to sign in",
                    ("auth_required", false) => "Side chat needs you to sign in",
                    (_, true) => "Turn ended",
                    (_, false) => "Side chat turn ended",
                };
                let _ = app.notification().builder().title(title.as_str()).body(body).show();
            }
            return true;
        }
        let AppEvent::SessionStatus { session_id, title, status, .. } = e else { return true };
        let count = {
            let mut w = waiting.lock();
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

/// Async: the log lock may be held by a first load of a big log.
#[tauri::command]
async fn unsubscribe(webview: Webview, harness: tauri::State<'_, Arc<Harness>>, session_id: String, id: u64) -> Result<(), String> {
    let harness = harness.inner().clone();
    let app = webview.app_handle().clone();
    let label = webview.label().to_owned();
    blocking(move || app.state::<Subscriptions>().unsubscribe(&harness, &label, &session_id, id)).await
}

/// Forgets what the webview subscribed to now (a reload or a closed window must not leak it), and
/// releases it in the core off the main thread.
fn drop_webview(app: &tauri::AppHandle, label: &str) {
    let Some(harness) = app.try_state::<Arc<Harness>>() else { return };
    let dropped = app.state::<Subscriptions>().take_webview(label);
    let harness = harness.inner().clone();
    tauri::async_runtime::spawn_blocking(move || dropped.release(&harness));
}

/// Same as `HTML_CSP` in the Chat Frontend's `htmlBridge.ts`.
const FRAME_CSP: &str = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'";

/// Loader of an Html frame (ADR 0013 addendum): takes its document from the host and writes it over itself.
const FRAME_LOADER: &str = r#"<!doctype html><script>addEventListener("message",function(e){if(e.source===parent&&e.data&&e.data.type==="doc"){document.open();document.write(e.data.html);document.close()}});parent.postMessage({type:"ready"},"*")</script>"#;

/// A `srcdoc` frame inherits the app's CSP, which blocks its scripts. A document from this scheme has its own.
fn frame_response() -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .header("Content-Type", "text/html; charset=utf-8")
        .header("Content-Security-Policy", FRAME_CSP)
        .body(FRAME_LOADER.as_bytes().to_vec())
        .expect("static response")
}

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info,agent_stderr=off".into()))
        .with_writer(std::io::stderr)
        .init();

    let builder = tauri::Builder::default();
    // The Quick overlay's NSPanel (`overlay/`).
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_nspanel::init());
    builder
        .register_uri_scheme_protocol("harness-frame", |_ctx, _request| frame_response())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(links::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        overlay::on_shortcut(app);
                    }
                })
                .build(),
        )
        // Main window reopens where and at the size it was. Not VISIBLE: windows stay hidden until first paint.
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(tauri_plugin_window_state::StateFlags::all() - tauri_plugin_window_state::StateFlags::VISIBLE)
                .with_filter(|label| label == "main")
                .build(),
        )
        .menu(menu::build)
        .on_menu_event(|app, event| menu::on_event(app, event.id().as_ref()))
        .manage(Subscriptions::default())
        .manage(updates::Updates::default())
        .manage(cli::CliQueue::default())
        .manage(cli::CliServer::default())
        .setup(|app| {
            let data_dir = harness_core::host::default_data_dir(app.path().home_dir()?, std::env::var_os("HARNESS_HOME"), cfg!(debug_assertions));
            let exe = std::env::current_exe()?.display().to_string();
            let options = harness_core::host::Options { mcp_shim: Some((exe, vec!["mcp-shim".to_owned()])), ..Default::default() };
            let harness = Harness::with_options(data_dir.clone(), Vec::new(), options)?;
            for manifest in harness_core::host::builtin_frontends() {
                harness.register_frontend(manifest);
            }
            watch_attention(app.handle(), &harness);
            overlay::init(app.handle(), &harness);
            app.manage(harness);
            overlay::create(app.handle());
            if let Some(main) = app.get_webview_window("main") {
                main.set_title(&app.package_info().name)?;
            }
            updates::spawn_checks(app.handle());
            cli::serve(app.handle(), &data_dir);
            stop_on_signal(app.handle());
            Ok(())
        })
        .on_page_load(|webview, payload| {
            // A (re)loading page starts with no subscriptions.
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                drop_webview(webview.app_handle(), webview.label());
            }
            // Windows start hidden; the page shows them once it has the theme background and has
            // painted (`set_window_background`, `reveal_window`). This is only for a page that
            // never gets that far.
            // The overlay is transparent and shown only by its shortcut.
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) && webview.label() != overlay::LABEL {
                let window = webview.window();
                // A window opened quietly (`?quiet=1`, `openWindow({ quiet })`) must not take focus.
                let focus = !payload.url().query_pairs().any(|(k, v)| k == "quiet" && v == "1");
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(1));
                    let _ = set_window_alpha(window.clone(), 1.0);
                    if !window.is_visible().unwrap_or(true) {
                        let _ = show_window(window, focus);
                    }
                });
            }
        })
        .on_window_event(|window, event| {
            // The overlay is made once: closing it (e.g. Cmd+W) only hides it.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event
                && window.label() == overlay::LABEL
            {
                api.prevent_close();
                overlay::hide(window.app_handle());
            }
            // The main window (red X, Cmd+W): on macOS it only hides, so panel windows keep it and
            // the Dock icon (`Reopen`) or a Session chip shows it again. Elsewhere closing it quits,
            // so panel windows never run without it (they stay popped and restore on launch).
            if let tauri::WindowEvent::CloseRequested { api, .. } = event
                && window.label() == "main"
            {
                if cfg!(target_os = "macos") {
                    api.prevent_close();
                    let _ = window.hide();
                } else {
                    window.app_handle().exit(0);
                }
            }
            if let tauri::WindowEvent::Destroyed = event {
                drop_webview(window.app_handle(), window.label());
                window.app_handle().state::<Subscriptions>().forget_label(window.label());
            }
        })
        .invoke_handler(tauri::generate_handler![
            execute,
            set_window_background,
            reveal_window,
            focus_window,
            show_session,
            save_file,
            subscribe,
            unsubscribe,
            read_log_page,
            subscribe_app,
            terminal_attach,
            terminal_detach,
            cli::cli_take,
            updates::update_state,
            updates::update_check,
            updates::update_install,
            updates::update_restart,
            overlay::overlay_ready,
            overlay::overlay_set_mode,
            overlay::overlay_set_menu_room,
            overlay::overlay_set_panels,
            overlay::overlay_resize,
            overlay::overlay_chat_width,
            overlay::overlay_hide,
            overlay::overlay_merge,
            overlay::overlay_context,
            overlay::overlay_open_privacy_settings,
            overlay::overlay_settings,
            overlay::overlay_set_settings
        ])
        .build(tauri::generate_context!())
        .expect("error while building Harness")
        .run(|app, event| match event {
            // Every way out passes here: Cmd+Q, the last window closing, the updater's restart, and
            // SIGINT/SIGTERM (`stop_on_signal`). A restart cannot be prevented, so shutdown runs
            // right here and blocks (bounded) instead of deferring the exit.
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => shut_down(app),
            // Dock icon click (macOS): the main window comes back (it hides on close; made anew if
            // it is gone).
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => cli::show_main(app),
            _ => {}
        });
}

/// Set once quitting starts: cancelled Turns must not notify or move the dock badge.
static QUITTING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// How long the exit path waits for `Harness::shutdown`, past its own bound.
const SHUTDOWN_MARGIN: std::time::Duration = std::time::Duration::from_secs(1);

/// Stops the Agents, Terminals and Session Logs before the process ends. Windows hide first, so
/// quitting looks instant. The work runs on the async runtime; this thread waits with a hard
/// timeout and exits regardless (also when shutdown panics). Runs once: both exit events call it.
fn shut_down(app: &tauri::AppHandle) {
    if QUITTING.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    // First: a client must not hand requests to an app that is going away.
    cli::stop(app);
    let Some(harness) = app.try_state::<Arc<Harness>>() else { return };
    for window in app.webview_windows().values() {
        let _ = window.hide();
    }
    let harness = harness.inner().clone();
    let wait = harness.shutdown_timeout() + SHUTDOWN_MARGIN;
    let (tx, rx) = std::sync::mpsc::channel();
    tauri::async_runtime::spawn(async move {
        harness.shutdown().await;
        let _ = tx.send(());
    });
    if rx.recv_timeout(wait) == Err(std::sync::mpsc::RecvTimeoutError::Timeout) {
        tracing::warn!("shutdown did not finish within {wait:?}; exiting anyway");
    }
}

/// SIGINT/SIGTERM (Ctrl-C in `bun run dev`) quit the app the normal way, through `shut_down`. A
/// second signal, or the bound running out, ends the process at once.
#[cfg(unix)]
fn stop_on_signal(app: &tauri::AppHandle) {
    use tokio::signal::unix::{SignalKind, signal};
    let app = app.clone();
    let wait = app.try_state::<Arc<Harness>>().map_or(std::time::Duration::from_secs(5), |h| h.shutdown_timeout()) + SHUTDOWN_MARGIN * 2;
    tauri::async_runtime::spawn(async move {
        let (Ok(mut int), Ok(mut term)) = (signal(SignalKind::interrupt()), signal(SignalKind::terminate())) else { return };
        tokio::select! {
            _ = int.recv() => {}
            _ = term.recv() => {}
        }
        app.exit(0);
        tokio::select! {
            _ = int.recv() => {}
            _ = term.recv() => {}
            _ = tokio::time::sleep(wait) => {}
        }
        std::process::exit(130);
    });
}

#[cfg(not(unix))]
fn stop_on_signal(_app: &tauri::AppHandle) {}

#[cfg(test)]
mod frame_tests {
    use super::FRAME_CSP;

    #[test]
    fn frame_csp_allows_no_network() {
        assert!(!FRAME_CSP.contains("http:") && !FRAME_CSP.contains("https:"), "{FRAME_CSP}");
        assert!(FRAME_CSP.contains("connect-src 'none'"));
        assert!(FRAME_CSP.contains("img-src data: blob:;"));
    }
}
