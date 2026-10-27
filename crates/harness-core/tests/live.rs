//! Live smoke tests against real Agents from the ACP Registry. They spend tokens and need the
//! Agents' logins, so they only run with `HARNESS_LIVE=1`:
//!
//! `HARNESS_LIVE=1 cargo test -p harness-core --test live -- --nocapture --test-threads=1`
//!
//! Installs are cached in `target/live-data` across runs. Each test: fresh git repo, ask the
//! Agent to create a file (permissions auto-allowed), then to call the Harness MCP `git_status`.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use harness_core::api::{Command, CommandResult, Event, EventKind, FrontendManifest};
use harness_core::Harness;

fn live() -> bool {
    std::env::var("HARNESS_LIVE").is_ok_and(|v| v == "1")
}

fn data_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/live-data")
}

fn repo(dir: &Path) -> PathBuf {
    let git = |args: &[&str]| assert!(std::process::Command::new("git").args(args).current_dir(dir).status().unwrap().success());
    git(&["init", "-q", "-b", "main"]);
    git(&["config", "user.email", "live@example.com"]);
    git(&["config", "user.name", "Live"]);
    std::fs::write(dir.join("README.md"), "live test\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "-q", "-m", "init"]);
    dir.canonicalize().unwrap()
}

fn events(h: &Harness, sid: &str) -> Vec<Event> {
    let all = Arc::new(Mutex::new(Vec::new()));
    let a = all.clone();
    let id = h.subscribe_session(sid, 0, Box::new(move |e: &Event| {
        a.lock().unwrap().push(e.clone());
        true
    }))
    .unwrap();
    h.unsubscribe_session(sid, id);
    all.lock().unwrap().clone()
}

/// Runs a Turn, allowing every permission request; returns its events.
async fn turn(h: &Harness, sid: &str, text: &str) -> Vec<Event> {
    let before = events(h, sid).len();
    h.execute(Command::Prompt { session_id: sid.into(), thread_id: None, text: text.into() }).await.unwrap();
    let mut answered = std::collections::HashSet::new();
    for _ in 0..(240 * 10) {
        let evs = events(h, sid);
        for e in &evs[before..] {
            if let EventKind::PermissionRequested { request_id, options, .. } = &e.kind
                && answered.insert(request_id.clone())
            {
                let allow = options.iter().find(|o| o.kind == "allow_once").or(options.first()).map(|o| o.option_id.clone());
                let _ = h
                    .execute(Command::ResolvePermission { session_id: sid.into(), request_id: request_id.clone(), option_id: allow })
                    .await;
            }
        }
        if evs[before..].iter().any(|e| matches!(e.kind, EventKind::TurnEnded { .. })) {
            return evs[before..].to_vec();
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("turn did not end within 4 minutes");
}

async fn smoke(registry_id: &str) {
    if !live() {
        eprintln!("skipped (set HARNESS_LIVE=1)");
        return;
    }
    let h = Harness::new(data_dir()).unwrap();
    h.register_frontend(serde_json::from_str::<FrontendManifest>(include_str!("../../../packages/frontend-chat/manifest.json")).unwrap());
    let CommandResult::Agents { agents } = h.execute(Command::ListAgents).await.unwrap() else { panic!() };
    if !agents.iter().any(|a| a.id == registry_id) {
        h.execute(Command::InstallAgent { registry_id: registry_id.into() }).await.unwrap();
    }
    let dir = tempfile::tempdir().unwrap();
    let folder = repo(dir.path());
    let cmd = Command::CreateSession {
        folder: folder.display().to_string(),
        agent_id: registry_id.into(),
        frontend_id: "chat".into(),
        title: Some(format!("live {registry_id}")),
        branch: None,
        worktree: false,
        mcp_servers: vec![],
    };
    let CommandResult::SessionCreated { session_id } = h.execute(cmd).await.unwrap() else { panic!() };

    let evs = turn(&h, &session_id, "Create a file named hello.txt in the current directory containing exactly the word hi. Then reply with: done").await;
    let ended = evs.iter().find_map(|e| match &e.kind {
        EventKind::TurnEnded { stop_reason, .. } => Some(stop_reason.clone()),
        _ => None,
    });
    assert_eq!(ended.as_deref(), Some("end_turn"), "{:#?}", evs.iter().map(|e| &e.kind).collect::<Vec<_>>());
    assert_eq!(std::fs::read_to_string(folder.join("hello.txt")).unwrap().trim(), "hi");
    let changed = evs.iter().any(|e| matches!(&e.kind, EventKind::WorkspaceChanged { files, .. } if files.iter().any(|f| f.path == "hello.txt")));
    assert!(changed, "WorkspaceChanged lists hello.txt");

    let evs = turn(&h, &session_id, "Call the git_status tool of the harness MCP server and tell me which files are untracked. Do not use the shell.").await;
    let called = evs.iter().any(|e| matches!(&e.kind, EventKind::ToolCall { title, .. } if title.contains("harness") && title.contains("git_status")));
    let reply: String = evs
        .iter()
        .filter_map(|e| match &e.kind {
            EventKind::AgentMessageChunk { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert!(called, "Harness MCP git_status was called");
    assert!(reply.contains("hello.txt"), "{reply}");
    h.execute(Command::DeleteSession { session_id, force: true }).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn claude() {
    smoke("claude-acp").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn codex() {
    smoke("codex-acp").await;
}
