//! `Harness::shutdown` against the scripted `fake-agent`: nothing survives, the log keeps everything.
#![allow(clippy::unwrap_used, reason = "tests fail loudly")]

mod common;
use common::{fake_agent_bin, wait_until};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use harness_core::Harness;
use harness_core::api::{AgentInfo, Command, CommandResult, ErrorCode, Event, EventKind, FrontendManifest, ProcessState, Resolver};

/// Every test counts the processes of the one fake-agent binary, so they take turns.
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn harness(data: &Path, flags: &[&str], timeout: Duration) -> Arc<Harness> {
    let agent = AgentInfo {
        id: "fake".into(),
        name: "Fake".into(),
        command: fake_agent_bin().display().to_string(),
        args: flags.iter().map(|f| f.to_string()).collect(),
        env: Default::default(),
        source: Default::default(),
        version: None,
        icon: None,
        install: Default::default(),
    };
    let options = harness_core::host::Options { shutdown_timeout: timeout, restore_retries: vec![Duration::from_millis(1); 3], ..Default::default() };
    let h = Harness::with_options(data.to_owned(), vec![agent], options).unwrap();
    h.register_frontend(FrontendManifest { id: "inspector".into(), name: "I".into(), version: "0".into(), instructions: None, frontend_tools: vec![] });
    h
}

async fn setup(flags: &[&str], timeout: Duration) -> (Arc<Harness>, String, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let h = harness(&dir.path().join("data"), flags, timeout);
    let CommandResult::SessionCreated { session_id } = h
        .execute(Command::CreateSession {
            folder: dir.path().display().to_string(),
            agent_id: "fake".into(),
            frontend_id: "inspector".into(),
            title: None,
            branch: None,
            worktree: false,
            new_branch: None,
            pr: None,
            mcp_servers: vec![],
        })
        .await
        .unwrap()
    else {
        panic!()
    };
    (h, session_id, dir)
}

async fn prompt(h: &Harness, sid: &str, text: &str) {
    h.execute(Command::Prompt { session_id: sid.into(), thread_id: None, text: text.into(), attachments: vec![] }).await.unwrap();
}

fn events(h: &Harness, sid: &str) -> Vec<Event> {
    h.session_events(sid).unwrap()
}

fn has(h: &Harness, sid: &str, f: impl Fn(&EventKind) -> bool) -> bool {
    events(h, sid).iter().any(|e| f(&e.kind))
}

/// Live (not zombie) processes whose command line contains `needle`.
fn procs(needle: &str) -> Vec<String> {
    let out = std::process::Command::new("ps").args(["-axo", "pid=,stat=,command="]).output().unwrap();
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|l| l.contains(needle) && !l.contains("ps -axo"))
        .filter(|l| !l.split_whitespace().nth(1).is_some_and(|stat| stat.starts_with('Z')))
        .map(str::to_owned)
        .collect()
}

fn agents() -> Vec<String> {
    procs(&fake_agent_bin().display().to_string())
}

/// The Session reopened from disk, as the next start does.
fn reopened(data: &Path, sid: &str) -> (Arc<Harness>, Vec<Event>) {
    let h = harness(data, &[], Duration::from_secs(5));
    let evs = events(&h, sid);
    (h, evs)
}

fn stops(evs: &[Event]) -> Vec<Option<String>> {
    evs.iter()
        .filter_map(|e| match &e.kind {
            EventKind::AgentProcessState { state: ProcessState::Stopped, message } => Some(message.clone()),
            _ => None,
        })
        .collect()
}

/// Ends the Harness the way the app does and checks what every test checks: a second call is a
/// no-op, Commands fail with a code, and no Agent process is left.
async fn shut_down(h: &Harness) {
    h.shutdown().await;
    let started = Instant::now();
    h.shutdown().await;
    assert!(started.elapsed() < Duration::from_millis(200), "a second shutdown is a no-op");
    let err = h.execute(Command::ListSessions).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Unavailable);
    wait_until("the Agent processes to be gone", Duration::from_secs(3), || agents().is_empty()).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn an_idle_session_shuts_down_and_reloads_cleanly() {
    let _turn = SERIAL.lock().await;
    let (h, sid, dir) = setup(&[], Duration::from_secs(5)).await;
    prompt(&h, &sid, "hi").await;
    wait_until("the Turn to end", Duration::from_secs(10), || has(&h, &sid, |k| matches!(k, EventKind::TurnEnded { .. }))).await;
    assert_eq!(agents().len(), 1);
    shut_down(&h).await;
    let before = events(&h, &sid).len();
    drop(h);
    let (_h2, evs) = reopened(&dir.path().join("data"), &sid);
    assert_eq!(evs.len(), before, "nothing was lost, and opening adds no stop of its own");
    assert_eq!(stops(&evs), vec![Some("app_restart".to_owned())]);
    assert_eq!(evs.iter().map(|e| e.seq).collect::<Vec<_>>(), (0..evs.len() as u64).collect::<Vec<_>>());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_session_that_never_started_an_agent_is_fine() {
    let _turn = SERIAL.lock().await;
    let (h, sid, dir) = setup(&[], Duration::from_secs(5)).await;
    shut_down(&h).await;
    drop(h);
    let (_h2, evs) = reopened(&dir.path().join("data"), &sid);
    assert!(stops(&evs).is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_running_turn_ends_as_cancelled_in_the_log() {
    let _turn = SERIAL.lock().await;
    let (h, sid, dir) = setup(&[], Duration::from_secs(5)).await;
    prompt(&h, &sid, "fault-hang").await;
    wait_until("partial output", Duration::from_secs(10), || has(&h, &sid, |k| matches!(k, EventKind::AgentMessageChunk { .. }))).await;
    shut_down(&h).await;
    let ended = events(&h, &sid).into_iter().find_map(|e| match e.kind {
        EventKind::TurnEnded { stop_reason, .. } => Some(stop_reason),
        _ => None,
    });
    assert_eq!(ended.as_deref(), Some("cancelled"));
    let before = events(&h, &sid).len();
    drop(h);
    let (_h2, evs) = reopened(&dir.path().join("data"), &sid);
    assert_eq!(evs.len(), before);
    // The chunk held for coalescing reached the file.
    assert!(evs.iter().any(|e| matches!(&e.kind, EventKind::AgentMessageChunk { text, .. } if text.contains("partial"))));
    assert_eq!(stops(&evs), vec![Some("app_restart".to_owned())]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_pending_permission_request_is_cancelled() {
    let _turn = SERIAL.lock().await;
    let (h, sid, dir) = setup(&[], Duration::from_secs(5)).await;
    prompt(&h, &sid, "ask permission").await;
    wait_until("the request", Duration::from_secs(10), || has(&h, &sid, |k| matches!(k, EventKind::PermissionRequested { .. }))).await;
    shut_down(&h).await;
    let evs = events(&h, &sid);
    assert!(evs.iter().any(|e| matches!(&e.kind, EventKind::PermissionResolved { by: Resolver::Cancelled, .. })));
    assert!(evs.iter().any(|e| matches!(&e.kind, EventKind::TurnEnded { .. })));
    drop(h);
    let (_h2, reloaded) = reopened(&dir.path().join("data"), &sid);
    assert_eq!(reloaded.len(), evs.len());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_job_watcher_stops_and_logs_nothing_after() {
    let _turn = SERIAL.lock().await;
    let (h, sid, dir) = setup(&[], Duration::from_secs(5)).await;
    let file = dir.path().join("job.output");
    let path = file.display().to_string();
    // Holds the file open like a running job does.
    let mut job = std::process::Command::new("sh").arg("-c").arg(format!("exec sleep 3011 > '{path}'")).spawn().unwrap();
    wait_until("the job to hold its file", Duration::from_secs(5), || !procs("sleep 3011").is_empty() && file.exists()).await;
    let watchers = h.job_watcher_counter(&sid).unwrap();
    prompt(&h, &sid, &format!("background-job {path}")).await;
    wait_until("the watcher", Duration::from_secs(10), || watchers() == 1).await;
    shut_down(&h).await;
    assert_eq!(watchers(), 0);
    job.kill().unwrap();
    job.wait().unwrap();
    // A watcher that survived would see the file closed at its next poll and log the end.
    tokio::time::sleep(Duration::from_millis(3500)).await;
    drop(h);
    let (_h2, evs) = reopened(&dir.path().join("data"), &sid);
    assert!(!evs.iter().any(|e| matches!(e.kind, EventKind::BackgroundJobEnded { .. })));
}

#[tokio::test(flavor = "multi_thread")]
async fn deleting_a_session_stops_its_job_watcher() {
    let _turn = SERIAL.lock().await;
    let (h, sid, dir) = setup(&[], Duration::from_secs(5)).await;
    let file = dir.path().join("job.output");
    let path = file.display().to_string();
    let mut job = std::process::Command::new("sh").arg("-c").arg(format!("exec sleep 3012 > '{path}'")).spawn().unwrap();
    wait_until("the job to hold its file", Duration::from_secs(5), || !procs("sleep 3012").is_empty() && file.exists()).await;
    let watchers = h.job_watcher_counter(&sid).unwrap();
    prompt(&h, &sid, &format!("background-job {path}")).await;
    wait_until("the watcher", Duration::from_secs(10), || watchers() == 1).await;
    h.execute(Command::DeleteSession { session_id: sid.clone(), force: true }).await.unwrap();
    assert_eq!(watchers(), 0, "the watcher no longer polls a deleted Session's job");
    job.kill().unwrap();
    job.wait().unwrap();
    shut_down(&h).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn an_open_terminal_is_killed() {
    let _turn = SERIAL.lock().await;
    let (h, sid, _dir) = setup(&[], Duration::from_secs(5)).await;
    h.terminal_attach(&sid, 1, 80, 24, Box::new(|_| true)).unwrap();
    h.execute(Command::TerminalInput { session_id: sid.clone(), terminal_id: 1, data: "sleep 3013\n".into() }).await.unwrap();
    wait_until("the command to run", Duration::from_secs(10), || !procs("sleep 3013").is_empty()).await;
    h.shutdown().await;
    wait_until("the shell and its command to be gone", Duration::from_secs(3), || procs("sleep 3013").is_empty()).await;
    assert!(h.terminal_attach(&sid, 1, 80, 24, Box::new(|_| true)).is_err(), "no new shell after shutdown");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_agent_that_ignores_sigterm_does_not_hold_shutdown_up() {
    let _turn = SERIAL.lock().await;
    let (h, sid, _dir) = setup(&["--ignore-sigterm"], Duration::from_secs(2)).await;
    prompt(&h, &sid, "fault-hang").await;
    wait_until("partial output", Duration::from_secs(10), || has(&h, &sid, |k| matches!(k, EventKind::AgentMessageChunk { .. }))).await;
    let started = Instant::now();
    h.shutdown().await;
    assert!(started.elapsed() < Duration::from_millis(2500), "took {:?}", started.elapsed());
    wait_until("the Agent to be gone", Duration::from_secs(3), || agents().is_empty()).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn commands_after_shutdown_fail_with_unavailable() {
    let _turn = SERIAL.lock().await;
    let (h, sid, _dir) = setup(&[], Duration::from_secs(5)).await;
    h.shutdown().await;
    let err = h.execute(Command::Prompt { session_id: sid, thread_id: None, text: "hi".into(), attachments: vec![] }).await.unwrap_err();
    assert_eq!((err.code, err.message.as_str()), (ErrorCode::Unavailable, "the Harness is shutting down"));
    assert!(agents().is_empty());
}
