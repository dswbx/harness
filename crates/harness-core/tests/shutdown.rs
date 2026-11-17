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
    let (h, sid) = setup_in(dir.path(), flags, timeout).await;
    (h, sid, dir)
}

async fn setup_in(dir: &Path, flags: &[&str], timeout: Duration) -> (Arc<Harness>, String) {
    let h = harness(&dir.join("data"), flags, timeout);
    let CommandResult::SessionCreated { session_id } = h
        .execute(Command::CreateSession {
            folder: dir.display().to_string(),
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
    (h, session_id)
}

async fn prompt(h: &Harness, sid: &str, text: &str) {
    h.execute(Command::Prompt { session_id: sid.into(), thread_id: None, text: text.into(), attachments: vec![], comment_ids: vec![] }).await.unwrap();
}

fn events(h: &Harness, sid: &str) -> Vec<Event> {
    h.session_events(sid).unwrap()
}

fn has(h: &Harness, sid: &str, f: impl Fn(&EventKind) -> bool) -> bool {
    events(h, sid).iter().any(|e| f(&e.kind))
}

/// Whether process `pid` still runs (a zombie, not yet reaped, does not count).
fn alive(pid: u32) -> bool {
    let out = std::process::Command::new("ps").args(["-o", "stat=", "-p", &pid.to_string()]).output().unwrap();
    let stat = String::from_utf8_lossy(&out.stdout);
    !stat.trim().is_empty() && !stat.trim().starts_with('Z')
}

/// The pids a process wrote to `file`, one per line.
async fn pids(file: &Path, n: usize) -> Vec<u32> {
    wait_until("the pid file", Duration::from_secs(10), || std::fs::read_to_string(file).is_ok_and(|t| t.lines().count() >= n)).await;
    std::fs::read_to_string(file).unwrap().lines().map(|l| l.trim().parse().unwrap()).collect()
}

/// The kill is not part of what the bound measures, only that it comes: the timeout only bounds a
/// failure, so it is generous for a loaded machine.
async fn all_gone(what: &str, pids: &[u32]) {
    wait_until(what, Duration::from_secs(30), || pids.iter().all(|p| !alive(*p))).await;
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
/// no-op and Commands fail with a code.
async fn shut_down(h: &Harness) {
    h.shutdown().await;
    let started = Instant::now();
    h.shutdown().await;
    assert!(started.elapsed() < Duration::from_millis(200), "a second shutdown is a no-op");
    let err = h.execute(Command::ListSessions).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Unavailable);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_idle_session_shuts_down_and_reloads_cleanly() {
    let _turn = SERIAL.lock().await;
    let (h, sid, dir) = setup(&[], Duration::from_secs(5)).await;
    prompt(&h, &sid, "hi").await;
    wait_until("the Turn to end", Duration::from_secs(10), || has(&h, &sid, |k| matches!(k, EventKind::TurnEnded { .. }))).await;
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
    wait_until("the job to hold its file", Duration::from_secs(5), || file.exists()).await;
    let watchers = h.job_watcher_counter(&sid).unwrap();
    prompt(&h, &sid, &format!("background-job {path}")).await;
    wait_until("the watcher", Duration::from_secs(10), || watchers() == 1).await;
    shut_down(&h).await;
    wait_until("the watcher task to end", Duration::from_secs(30), || watchers() == 0).await;
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
    wait_until("the job to hold its file", Duration::from_secs(5), || file.exists()).await;
    let watchers = h.job_watcher_counter(&sid).unwrap();
    prompt(&h, &sid, &format!("background-job {path}")).await;
    wait_until("the watcher", Duration::from_secs(10), || watchers() == 1).await;
    h.execute(Command::DeleteSession { session_id: sid.clone(), force: true }).await.unwrap();
    wait_until("the watcher task of the deleted Session to end", Duration::from_secs(30), || watchers() == 0).await;
    job.kill().unwrap();
    job.wait().unwrap();
    shut_down(&h).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn an_open_terminal_is_killed() {
    let _turn = SERIAL.lock().await;
    let (h, sid, dir) = setup(&[], Duration::from_secs(5)).await;
    let file = dir.path().join("terminal.pids");
    h.terminal_attach(&sid, 1, 80, 24, Box::new(|_| true)).unwrap();
    // The shell's pid, then a command of its own.
    let line = format!("echo $$ > '{0}'; sleep 3013 & echo $! >> '{0}'; wait\n", file.display());
    h.execute(Command::TerminalInput { session_id: sid.clone(), terminal_id: 1, data: line }).await.unwrap();
    let p = pids(&file, 2).await;
    h.shutdown().await;
    all_gone("the shell and its command to be gone", &p).await;
    assert!(h.terminal_attach(&sid, 1, 80, 24, Box::new(|_| true)).is_err(), "no new shell after shutdown");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_agent_and_its_grandchild_are_gone_even_if_they_ignore_stdin_eof() {
    let _turn = SERIAL.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("agent.pids");
    let (h, sid) = setup_in(dir.path(), &[&format!("--pid-file={}", file.display()), "--ignore-stdin-eof", "--ignore-sigterm"], Duration::from_secs(5)).await;
    prompt(&h, &sid, "hi").await;
    let p = pids(&file, 2).await;
    wait_until("the Turn to end", Duration::from_secs(10), || has(&h, &sid, |k| matches!(k, EventKind::TurnEnded { .. }))).await;
    assert!(p.iter().all(|p| alive(*p)));
    shut_down(&h).await;
    all_gone("the Agent and its grandchild", &p).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_start_in_flight_leaves_no_process() {
    let _turn = SERIAL.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("agent.pids");
    let (h, sid) = setup_in(dir.path(), &[&format!("--pid-file={}", file.display()), "--init-delay-ms=20000"], Duration::from_secs(2)).await;
    let h2 = h.clone();
    let starting = tokio::spawn(async move {
        h2.execute(Command::Prompt { session_id: sid, thread_id: None, text: "hi".into(), attachments: vec![], comment_ids: vec![] }).await
    });
    // The process exists, and `initialize` has not answered.
    let p = pids(&file, 2).await;
    let started = Instant::now();
    h.shutdown().await;
    assert!(started.elapsed() < Duration::from_millis(3000), "took {:?}", started.elapsed());
    all_gone("the Agent started during shutdown", &p).await;
    assert!(starting.await.unwrap().is_err(), "the prompt that was starting the Agent fails");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_bound_holds_when_a_turn_cannot_end_and_the_agent_will_not_die_politely() {
    let _turn = SERIAL.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("agent.pids");
    let flags = [format!("--pid-file={}", file.display()), "--ignore-sigterm".to_owned(), "--ignore-stdin-eof".to_owned()];
    let flags: Vec<&str> = flags.iter().map(String::as_str).collect();
    let (h, sid) = setup_in(dir.path(), &flags, Duration::from_secs(2)).await;
    prompt(&h, &sid, "fault-hang").await;
    wait_until("partial output", Duration::from_secs(10), || has(&h, &sid, |k| matches!(k, EventKind::AgentMessageChunk { .. }))).await;
    let p = pids(&file, 2).await;
    let started = Instant::now();
    h.shutdown().await;
    assert!(started.elapsed() < Duration::from_millis(3000), "took {:?}", started.elapsed());
    all_gone("the Agent", &p).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn concurrent_shutdowns_all_return_once_it_is_done() {
    let _turn = SERIAL.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("agent.pids");
    let (h, sid) = setup_in(dir.path(), &[&format!("--pid-file={}", file.display())], Duration::from_secs(5)).await;
    prompt(&h, &sid, "fault-hang").await;
    let p = pids(&file, 2).await;
    tokio::join!(h.shutdown(), h.shutdown(), h.shutdown());
    all_gone("the Agent", &p).await;
    assert!(has(&h, &sid, |k| matches!(k, EventKind::TurnEnded { .. })));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_read_only_session_is_left_byte_for_byte() {
    let _turn = SERIAL.lock().await;
    let (h, sid, dir) = setup(&[], Duration::from_secs(5)).await;
    h.shutdown().await;
    drop(h);
    let session_dir = dir.path().join("data/sessions").join(&sid);
    // As a newer build leaves it: an Event this build cannot read, and a field it does not know.
    let log = session_dir.join("log.jsonl");
    let next = std::fs::read_to_string(&log).unwrap().lines().count();
    let line = format!(r#"{{"v":999,"seq":{next},"session_id":"{sid}","thread_id":null,"ts_ms":1,"kind":{{"type":"FromTheFuture"}}}}"#);
    std::fs::write(&log, format!("{}{line}\n", std::fs::read_to_string(&log).unwrap())).unwrap();
    let meta_path = session_dir.join("session.json");
    let mut meta: serde_json::Value = serde_json::from_slice(&std::fs::read(&meta_path).unwrap()).unwrap();
    meta["from_the_future"] = serde_json::json!(true);
    std::fs::write(&meta_path, serde_json::to_vec_pretty(&meta).unwrap()).unwrap();
    let snapshot = || -> Vec<(String, Vec<u8>)> {
        let mut files: Vec<_> = std::fs::read_dir(&session_dir)
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.is_file())
            .map(|p| (p.file_name().unwrap().to_string_lossy().into_owned(), std::fs::read(&p).unwrap()))
            .collect();
        files.sort();
        files
    };
    let h2 = harness(&dir.path().join("data"), &[], Duration::from_secs(5));
    let before = snapshot();
    h2.shutdown().await;
    assert_eq!(snapshot(), before);
}

#[tokio::test(flavor = "multi_thread")]
async fn no_session_or_turn_starts_once_shutdown_began() {
    let _turn = SERIAL.lock().await;
    let (h, sid, dir) = setup(&[], Duration::from_secs(5)).await;
    h.shutdown().await;
    let sessions = || std::fs::read_dir(dir.path().join("data/sessions")).unwrap().count();
    let before = sessions();
    let create = Command::CreateSession {
        folder: dir.path().display().to_string(),
        agent_id: "fake".into(),
        frontend_id: "inspector".into(),
        title: None,
        branch: None,
        worktree: false,
        new_branch: None,
        pr: None,
        mcp_servers: vec![],
    };
    assert_eq!(h.execute(create).await.unwrap_err().code, ErrorCode::Unavailable);
    assert_eq!(sessions(), before);
    let err =
        h.execute(Command::Prompt { session_id: sid.clone(), thread_id: None, text: "hi".into(), attachments: vec![], comment_ids: vec![] }).await.unwrap_err();
    assert_eq!((err.code, err.message.as_str()), (ErrorCode::Unavailable, "the Harness is shutting down"));
    let sub = h.subscribe_session(&sid, 0, Box::new(|_: &Event| true));
    assert_eq!(sub.unwrap_err(), "the Harness is shutting down");
}
