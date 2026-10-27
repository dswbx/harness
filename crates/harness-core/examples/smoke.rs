//! Headless smoke test: `cargo run -p harness-core --example smoke -- <agent_id> <folder> "<prompt>"`.
//! Continue an earlier run (restart check) with `SMOKE_DATA=<data dir> SMOKE_SESSION=<id>`.
//! `SMOKE_FRONTEND=chat` uses the chat Frontend (its Frontend Tools reach the Agent).
//! `SMOKE_INSTALL=1` first installs `<agent_id>` from the ACP Registry (e.g. `claude-acp`).

use harness_core::api::{Command, CommandResult, Event, EventKind, FrontendManifest};
use std::time::Duration;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let agent_id = args.next().unwrap_or_else(|| "codex".into());
    let folder = args.next().expect("folder");
    let prompt = args.next().unwrap_or_else(|| "Say hi in five words.".into());
    let data = std::env::var("SMOKE_DATA").map(Into::into).unwrap_or_else(|_| tempfile_dir());
    let h = harness_core::Harness::new(data.clone())?;
    h.register_frontend(FrontendManifest { id: "inspector".into(), name: "Inspector".into(), version: "0".into(), frontend_tools: vec![] });
    // The chat Frontend (with its Frontend Tools), used when `SMOKE_FRONTEND=chat`.
    h.register_frontend(serde_json::from_str(include_str!("../../../packages/frontend-chat/manifest.json"))?);
    let frontend_id = std::env::var("SMOKE_FRONTEND").unwrap_or_else(|_| "inspector".into());
    if std::env::var("SMOKE_INSTALL").is_ok() {
        let t = std::time::Instant::now();
        let r = h.execute(Command::InstallAgent { registry_id: agent_id.clone() }).await.map_err(anyhow::Error::msg)?;
        println!("installed in {:?}: {r:?}", t.elapsed());
    }
    let session_id = match std::env::var("SMOKE_SESSION") {
        Ok(id) => id,
        Err(_) => {
            let CommandResult::SessionCreated { session_id } = h
                .execute(Command::CreateSession { folder, agent_id, frontend_id: frontend_id.clone(), title: None, branch: None, worktree: false, mcp_servers: vec![] })
                .await
                .map_err(anyhow::Error::msg)?
            else { unreachable!() };
            session_id
        }
    };
    // Only print what this run adds.
    let count = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let c = count.clone();
    let probe = h
        .subscribe_session(&session_id, 0, Box::new(move |_: &Event| {
            c.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            true
        }))
        .map_err(anyhow::Error::msg)?;
    h.unsubscribe_session(&session_id, probe);
    let from_seq = count.load(std::sync::atomic::Ordering::SeqCst);
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Event>();
    h.subscribe_session(&session_id, from_seq, Box::new(move |e: &Event| tx.send(e.clone()).is_ok())).map_err(anyhow::Error::msg)?;
    h.execute(Command::Prompt { session_id: session_id.clone(), thread_id: None, text: prompt }).await.map_err(anyhow::Error::msg)?;
    loop {
        let Ok(Some(e)) = tokio::time::timeout(Duration::from_secs(180), rx.recv()).await else { break };
        let line = serde_json::to_string(&e.kind)?;
        println!("{:>3} {}", e.seq, &line[..line.len().min(160)]);
        if let EventKind::PermissionRequested { request_id, options, .. } = &e.kind {
            let opt = options.iter().find(|o| o.kind.starts_with("allow")).map(|o| o.option_id.clone());
            // Already answered by the Policy when this fails.
            let _ = h.execute(Command::ResolvePermission { session_id: session_id.clone(), request_id: request_id.clone(), option_id: opt }).await;
        }
        if matches!(e.kind, EventKind::TurnEnded { .. }) { break }
    }
    println!("SMOKE_DATA={} SMOKE_SESSION={session_id}", data.display());
    Ok(())
}

fn tempfile_dir() -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("harness-smoke-{}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    d
}
