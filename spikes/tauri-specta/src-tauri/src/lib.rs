pub mod api;

use api::{Command, Event, EventKind};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{ipc::Channel, AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

#[derive(Default)]
struct Subs {
    next: AtomicU64,
    tasks: Mutex<HashMap<u64, tauri::async_runtime::JoinHandle<()>>>,
}

#[tauri::command]
async fn execute(app: AppHandle, cmd: Command) -> Result<serde_json::Value, String> {
    eprintln!("[rust] execute {cmd:?}");
    match cmd {
        Command::Ping { text } => Ok(serde_json::json!({ "pong": text })),
        Command::CreateSession { name } => {
            // second window demo: open from Rust
            if name == "open-window" && app.get_webview_window("second").is_none() {
                WebviewWindowBuilder::new(&app, "second", WebviewUrl::default())
                    .title("second")
                    .build()
                    .map_err(|e| e.to_string())?;
            }
            Ok(serde_json::json!({ "id": "s1", "name": name }))
        }
        other => Err(format!("unhandled: {other:?}")),
    }
}

#[tauri::command]
fn subscribe(subs: State<'_, Subs>, from_seq: u64, channel: Channel<Event>) -> u64 {
    let id = subs.next.fetch_add(1, Ordering::SeqCst) + 1;
    let handle = tauri::async_runtime::spawn(async move {
        let t0 = Instant::now();
        let mut seq = from_seq;
        // burst
        for i in 0..1000u32 {
            seq += 1;
            let ev = Event {
                seq,
                session_id: "s1".into(),
                kind: EventKind::MessageChunk { text: format!("chunk {i}") },
            };
            if channel.send(ev).is_err() {
                return;
            }
        }
        eprintln!("[rust] sub {id}: burst of 1000 sent in {:?}", t0.elapsed());
        // slow trickle
        loop {
            tokio::time::sleep(Duration::from_millis(500)).await;
            seq += 1;
            let ev = Event { seq, session_id: "s1".into(), kind: EventKind::Heartbeat };
            if channel.send(ev).is_err() {
                eprintln!("[rust] sub {id}: channel closed");
                return;
            }
        }
    });
    subs.tasks.lock().unwrap().insert(id, handle);
    id
}

#[tauri::command]
fn unsubscribe(subs: State<'_, Subs>, id: u64) {
    if let Some(h) = subs.tasks.lock().unwrap().remove(&id) {
        h.abort();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Subs::default())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![execute, subscribe, unsubscribe])
        .setup(|app| {
            let _ = app.get_webview_window("main");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
