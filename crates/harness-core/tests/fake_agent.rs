//! Drives the Harness against the scripted `fake-agent` binary.

mod common;
use common::fake_agent_bin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use harness_core::api::{
    AgentInfo, Attachment, AttachmentInput, AttachmentKind, Boundary, Command, CommandResult, Decision, Event, EventKind, ForkPoint, FrontendManifest, NewPermissionRule, Resolver, RuleScope, ThreadStart,
    ProcessState, SessionStatus,
};
use harness_core::Harness;


async fn setup() -> (Arc<Harness>, String, tempfile::TempDir) {
    setup_with(&[], Duration::from_secs(900)).await
}

fn fake_info() -> AgentInfo {
    AgentInfo {
        id: "fake".into(),
        name: "Fake".into(),
        command: fake_agent_bin().display().to_string(),
        args: vec![],
        env: Default::default(),
        source: Default::default(),
        version: None,
        icon: None,
    }
}

fn harness(data: &std::path::Path, flags: &[&str], idle: Duration) -> Arc<Harness> {
    let args = flags.iter().map(|f| f.to_string()).collect();
    let agent = AgentInfo { args, ..fake_info() };
    let options = harness_core::host::Options { idle_timeout: idle, ..Default::default() };
    let h = Harness::with_options(data.to_owned(), vec![agent], options).unwrap();
    h.register_frontend(FrontendManifest { id: "inspector".into(), name: "I".into(), version: "0".into(), instructions: None, frontend_tools: vec![] });
    h
}

async fn setup_with(flags: &[&str], idle: Duration) -> (Arc<Harness>, String, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let h = harness(&dir.path().join("data"), flags, idle);
    let folder = dir.path().display().to_string();
    let CommandResult::SessionCreated { session_id } = h
        .execute(Command::CreateSession { folder, agent_id: "fake".into(), frontend_id: "inspector".into(), title: None, branch: None, worktree: false, new_branch: None, pr: None, mcp_servers: vec![] })
        .await
        .unwrap()
    else { panic!() };
    (h, session_id, dir)
}

fn collect(h: &Harness, sid: &str) -> (Arc<Mutex<Vec<Event>>>, tokio::sync::mpsc::UnboundedReceiver<Event>) {
    let all = Arc::new(Mutex::new(Vec::new()));
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let a = all.clone();
    h.subscribe_session(sid, 0, Box::new(move |e: &Event| {
        a.lock().unwrap().push(e.clone());
        let _ = tx.send(e.clone());
        true
    }))
    .unwrap();
    (all, rx)
}

async fn until(rx: &mut tokio::sync::mpsc::UnboundedReceiver<Event>, f: impl Fn(&EventKind) -> bool) -> Event {
    loop {
        let e = tokio::time::timeout(Duration::from_secs(20), rx.recv()).await.expect("timeout").expect("closed");
        if f(&e.kind) {
            return e;
        }
    }
}

fn kinds(events: &[Event]) -> Vec<String> {
    events.iter().map(|e| serde_json::to_value(&e.kind).unwrap()["type"].as_str().unwrap().to_owned()).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn turn_streams_into_session_log() {
    let (h, sid, _dir) = setup().await;
    let (all, mut rx) = collect(&h, &sid);
    h.execute(Command::Prompt { session_id: sid.clone(), thread_id: None, text: "use a tool".into(), attachments: vec![] }).await.unwrap();
    until(&mut rx, |k| matches!(k, EventKind::TurnEnded { .. })).await;
    let k = kinds(&all.lock().unwrap());
    for expected in ["SessionCreated", "ThreadStarted", "AgentSessionStarted", "TurnStarted", "AgentMessageChunk", "TaskListUpdated", "ToolCall", "ToolCallUpdate", "TurnEnded"] {
        assert!(k.iter().any(|x| x == expected), "missing {expected} in {k:?}");
    }
    let seqs: Vec<u64> = all.lock().unwrap().iter().map(|e| e.seq).collect();
    assert_eq!(seqs, (0..seqs.len() as u64).collect::<Vec<_>>(), "contiguous seq");
}

async fn title_of(h: &Harness) -> String {
    let CommandResult::Sessions { sessions } = h.execute(Command::ListSessions).await.unwrap() else { panic!() };
    sessions[0].title.clone()
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_title_becomes_session_title() {
    let (h, sid, dir) = setup().await;
    let (_all, mut rx) = collect(&h, &sid);
    h.execute(Command::Prompt { session_id: sid.clone(), thread_id: None, text: "set a title".into(), attachments: vec![] }).await.unwrap();
    until(&mut rx, |k| matches!(k, EventKind::TurnEnded { .. })).await;
    assert_eq!(title_of(&h).await, "Fake title");
    drop(h);

    // A Session from before titles were kept: its title comes back from the log once.
    let meta_path = dir.path().join("data/sessions").join(&sid).join("session.json");
    let mut meta: serde_json::Value = serde_json::from_slice(&std::fs::read(&meta_path).unwrap()).unwrap();
    meta["title"] = "folder".into();
    meta.as_object_mut().unwrap().remove("title_backfilled");
    std::fs::write(&meta_path, serde_json::to_vec(&meta).unwrap()).unwrap();
    let h = harness(&dir.path().join("data"), &[], Duration::from_secs(900));
    assert_eq!(title_of(&h).await, "Fake title");
}

#[tokio::test(flavor = "multi_thread")]
async fn permission_first_answer_wins_and_late_view_replays() {
    let (h, sid, _dir) = setup().await;
    let (_all, mut rx) = collect(&h, &sid);
    h.execute(Command::Prompt { session_id: sid.clone(), thread_id: None, text: "needs permission".into(), attachments: vec![] }).await.unwrap();
    let e = until(&mut rx, |k| matches!(k, EventKind::PermissionRequested { .. })).await;
    let EventKind::PermissionRequested { request_id, .. } = e.kind else { unreachable!() };
    assert_eq!(status_of(&h).await, SessionStatus::NeedsAttention);

    let answer = |opt: &str| Command::ResolvePermission { session_id: sid.clone(), request_id: request_id.clone(), option_id: Some(opt.into()) };
    h.execute(answer("reject")).await.unwrap();
    assert!(h.execute(answer("allow")).await.is_err(), "second answer must lose");

    let end = until(&mut rx, |k| matches!(k, EventKind::ToolCallUpdate { status: Some(_), .. })).await;
    let EventKind::ToolCallUpdate { status, .. } = end.kind else { unreachable!() };
    assert_eq!(status.as_deref(), Some("failed"));
    until(&mut rx, |k| matches!(k, EventKind::TurnEnded { .. })).await;

    // A View attaching late sees the identical log.
    let (late, _rx2) = collect(&h, &sid);
    let replayed = late.lock().unwrap().clone();
    assert!(kinds(&replayed).iter().any(|k| k == "PermissionResolved"));
    assert_eq!(replayed.first().unwrap().seq, 0);
}

async fn status_of(h: &Harness) -> SessionStatus {
    let CommandResult::Sessions { sessions } = h.execute(Command::ListSessions).await.unwrap() else { panic!() };
    sessions[0].status
}

fn rule(scope: RuleScope, pattern: &str, decision: Decision) -> Command {
    Command::AddPermissionRule {
        rule: NewPermissionRule { scope, tool_kind: Some("execute".into()), pattern: Some(pattern.into()), decision },
    }
}

/// Runs one "needs permission" Turn; returns how it was resolved and the tool call's final status.
async fn permission_turn(h: &Harness, sid: &str) -> (Resolver, Option<String>, String) {
    let (_all, mut rx) = collect(h, sid);
    let start = _all.lock().unwrap().len();
    h.execute(Command::Prompt { session_id: sid.into(), thread_id: None, text: "needs permission".into(), attachments: vec![] }).await.unwrap();
    // Skip the replayed history of earlier Turns.
    for _ in 0..start {
        rx.recv().await.unwrap();
    }
    let e = until(&mut rx, |k| matches!(k, EventKind::PermissionResolved { .. })).await;
    let EventKind::PermissionResolved { by, rule_id, .. } = e.kind else { unreachable!() };
    let end = until(&mut rx, |k| matches!(k, EventKind::ToolCallUpdate { status: Some(_), .. })).await;
    let EventKind::ToolCallUpdate { status, .. } = end.kind else { unreachable!() };
    until(&mut rx, |k| matches!(k, EventKind::TurnEnded { .. })).await;
    (by, rule_id, status.unwrap())
}

#[tokio::test(flavor = "multi_thread")]
async fn policy_rules_answer_without_a_view() {
    let (h, sid, _dir) = setup().await;
    let CommandResult::PermissionRuleAdded { rule: allow } = h.execute(rule(RuleScope::Global, "echo", Decision::Allow)).await.unwrap() else { panic!() };
    let (by, rule_id, status) = permission_turn(&h, &sid).await;
    assert_eq!((by, rule_id.as_deref(), status.as_str()), (Resolver::Policy, Some(allow.id.as_str()), "completed"));

    // A Session rule beats the global one.
    h.execute(rule(RuleScope::Session { session_id: sid.clone() }, "echo hi", Decision::Deny)).await.unwrap();
    let (by, _, status) = permission_turn(&h, &sid).await;
    assert_eq!((by, status.as_str()), (Resolver::Policy, "failed"));

    let log = h_events(&h, &sid);
    assert!(!log.iter().any(|k| matches!(k, EventKind::SessionStatusChanged { status: SessionStatus::NeedsAttention })));
}

#[tokio::test(flavor = "multi_thread")]
async fn always_allow_is_remembered_for_the_session() {
    let (h, sid, _dir) = setup().await;
    let (_all, mut rx) = collect(&h, &sid);
    h.execute(Command::Prompt { session_id: sid.clone(), thread_id: None, text: "needs permission".into(), attachments: vec![] }).await.unwrap();
    let e = until(&mut rx, |k| matches!(k, EventKind::PermissionRequested { .. })).await;
    let EventKind::PermissionRequested { request_id, .. } = e.kind else { unreachable!() };
    h.execute(Command::ResolvePermission { session_id: sid.clone(), request_id, option_id: Some("always".into()) }).await.unwrap();
    let added = until(&mut rx, |k| matches!(k, EventKind::PermissionRuleAdded { .. })).await;
    let EventKind::PermissionRuleAdded { rule } = added.kind else { unreachable!() };
    assert_eq!(rule.pattern.as_deref(), Some("echo hi"));
    assert_eq!(rule.scope, RuleScope::Session { session_id: sid.clone() });
    until(&mut rx, |k| matches!(k, EventKind::TurnEnded { .. })).await;

    let (by, rule_id, status) = permission_turn(&h, &sid).await;
    assert_eq!((by, rule_id, status.as_str()), (Resolver::Policy, Some(rule.id), "completed"));
}

fn h_events(h: &Harness, sid: &str) -> Vec<EventKind> {
    events(h, sid).into_iter().map(|e| e.kind).collect()
}

/// A snapshot of the log that does not stay subscribed (so it never counts as an open View).
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

/// Prompts and waits for the Turn's end; returns its stop reason.
async fn turn(h: &Harness, sid: &str, thread_id: Option<String>, text: &str) -> String {
    turn_with(h, sid, thread_id, text, vec![]).await
}

async fn turn_with(h: &Harness, sid: &str, thread_id: Option<String>, text: &str, attachments: Vec<AttachmentInput>) -> String {
    let before = events(h, sid).len();
    h.execute(Command::Prompt { session_id: sid.into(), thread_id, text: text.into(), attachments }).await.unwrap();
    for _ in 0..400 {
        let evs = events(h, sid);
        if let Some(EventKind::TurnEnded { stop_reason, .. }) =
            evs[before..].iter().map(|e| &e.kind).find(|k| matches!(k, EventKind::TurnEnded { .. }))
        {
            return stop_reason.clone();
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("turn did not end");
}

fn boundaries(h: &Harness, sid: &str) -> Vec<Boundary> {
    h_events(h, sid)
        .into_iter()
        .filter_map(|k| match k {
            EventKind::AgentSessionStarted { boundary, .. } => Some(boundary),
            _ => None,
        })
        .collect()
}

fn texts(h: &Harness, sid: &str) -> Vec<String> {
    h_events(h, sid)
        .into_iter()
        .filter_map(|k| match k {
            EventKind::AgentMessageChunk { text } => Some(text),
            _ => None,
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn restart_resumes_the_agent_session() {
    let (h, sid, dir) = setup_with(&["--resume"], Duration::from_secs(900)).await;
    assert_eq!(turn(&h, &sid, None, "hi").await, "end_turn");
    let h2 = harness(&dir.path().join("data"), &["--resume"], Duration::from_secs(900));
    assert_eq!(turn(&h2, &sid, None, "again").await, "end_turn");
    assert_eq!(boundaries(&h2, &sid), vec![Boundary::Initial, Boundary::Resumed]);
}

#[tokio::test(flavor = "multi_thread")]
async fn load_replay_is_not_logged_twice() {
    let (h, sid, dir) = setup_with(&["--load"], Duration::from_secs(900)).await;
    turn(&h, &sid, None, "hi").await;
    let h2 = harness(&dir.path().join("data"), &["--load"], Duration::from_secs(900));
    assert_eq!(turn(&h2, &sid, None, "again").await, "end_turn");
    assert_eq!(boundaries(&h2, &sid), vec![Boundary::Initial, Boundary::Loaded]);
    assert!(!texts(&h2, &sid).iter().any(|t| t.contains("replayed")));
}

#[tokio::test(flavor = "multi_thread")]
async fn no_continuation_makes_the_thread_read_only_until_continued_with_summary() {
    let (h, sid, dir) = setup().await;
    turn(&h, &sid, None, "remember the word banana").await;
    let h2 = harness(&dir.path().join("data"), &[], Duration::from_secs(900));
    let prompt = |text: &str| Command::Prompt { session_id: sid.clone(), thread_id: None, text: text.into(), attachments: vec![] };
    assert!(h2.execute(prompt("again")).await.is_err());
    assert!(h_events(&h2, &sid).iter().any(|k| matches!(k, EventKind::ThreadReadOnly { .. })));
    assert!(h2.execute(prompt("still?")).await.is_err(), "stays read-only");

    h2.execute(Command::ContinueWithSummary { session_id: sid.clone(), thread_id: None, text: None }).await.unwrap();
    assert_eq!(boundaries(&h2, &sid), vec![Boundary::Initial, Boundary::ContinuedWithSummary]);
    turn(&h2, &sid, None, "what was the word?").await;
    turn(&h2, &sid, None, "and now?").await;
    assert_eq!(texts(&h2, &sid).iter().filter(|t| t.starts_with("seeded")).count(), 1, "seed is sent once");
}

#[tokio::test(flavor = "multi_thread")]
async fn crash_mid_turn_ends_the_turn_and_the_next_prompt_recovers() {
    let (h, sid, _dir) = setup_with(&["--resume"], Duration::from_secs(900)).await;
    assert_eq!(turn(&h, &sid, None, "crash now").await, "error");
    for _ in 0..100 {
        if h_events(&h, &sid).iter().any(|k| matches!(k, EventKind::AgentProcessState { state: ProcessState::Exited | ProcessState::Failed, .. })) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(status_of(&h).await, SessionStatus::Idle);
    assert_eq!(turn(&h, &sid, None, "hi").await, "end_turn");
    assert_eq!(boundaries(&h, &sid), vec![Boundary::Initial, Boundary::Resumed]);
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_hanging_up_without_exiting_is_replaced_on_next_prompt() {
    let (h, sid, _dir) = setup_with(&["--resume"], Duration::from_secs(900)).await;
    assert_eq!(turn(&h, &sid, None, "hangup now").await, "error");
    assert_eq!(turn(&h, &sid, None, "hi").await, "end_turn");
    assert_eq!(boundaries(&h, &sid), vec![Boundary::Initial, Boundary::Resumed]);
}

#[tokio::test(flavor = "multi_thread")]
async fn idle_agent_stops_only_without_views_and_restarts_on_prompt() {
    let (h, sid, _dir) = setup_with(&["--resume"], Duration::from_millis(200)).await;
    let stopped = |h: &Harness| {
        h_events(h, &sid).iter().filter(|k| matches!(k, EventKind::AgentProcessState { state: ProcessState::Stopped, .. })).count()
    };
    let view = h.subscribe_session(&sid, 0, Box::new(|_: &Event| true)).unwrap();
    turn(&h, &sid, None, "hi").await;
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert_eq!(stopped(&h), 0, "an open View keeps the Agent running");

    h.unsubscribe_session(&sid, view);
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert_eq!(stopped(&h), 1);
    assert_eq!(turn(&h, &sid, None, "back").await, "end_turn");
    assert_eq!(boundaries(&h, &sid), vec![Boundary::Initial, Boundary::Resumed]);
}

async fn start_side(h: &Harness, sid: &str, seed: Option<&str>, source: ThreadStart) -> (String, bool) {
    let CommandResult::ThreadStarted { thread_id, forked } = h
        .execute(Command::StartSideThread { session_id: sid.into(), seed: seed.map(Into::into), source })
        .await
        .unwrap()
    else { panic!() };
    (thread_id, forked)
}

/// Prompts in a Thread, waits for the Turn's end and returns the Agent's reply.
async fn ask_in(h: &Harness, sid: &str, thread: &str, text: &str) -> String {
    let before = events(h, sid).len();
    turn(h, sid, Some(thread.into()), text).await;
    events(h, sid)[before..]
        .iter()
        .filter(|e| e.thread_id.as_deref() == Some(thread))
        .filter_map(|e| match &e.kind {
            EventKind::AgentMessageChunk { text } => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

fn main_thread(h: &Harness, sid: &str) -> String {
    events(h, sid)
        .into_iter()
        .find_map(|e| match e.kind {
            EventKind::ThreadStarted { main: true, .. } => e.thread_id,
            _ => None,
        })
        .unwrap()
}

fn thread_kinds(h: &Harness, sid: &str, thread: &str) -> Vec<EventKind> {
    events(h, sid).into_iter().filter(|e| e.thread_id.as_deref() == Some(thread)).map(|e| e.kind).collect()
}

fn thread_boundaries(h: &Harness, sid: &str, thread: &str) -> Vec<Boundary> {
    thread_kinds(h, sid, thread)
        .into_iter()
        .filter_map(|k| match k {
            EventKind::AgentSessionStarted { boundary, .. } => Some(boundary),
            _ => None,
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn side_thread_without_fork_support_is_seeded_with_the_main_transcript() {
    let (h, sid, _dir) = setup().await;
    turn(&h, &sid, None, "main").await;
    let (side, forked) = start_side(&h, &sid, Some("look at the tests"), ThreadStart::Fork).await;
    assert!(forked, "the Main Thread has an Agent Session, so a fork is tried");
    let reply = ask_in(&h, &sid, &side, "echo-prompt side").await;
    assert!(reply.contains("seeded"), "{reply}");
    assert!(reply.contains("[Turn 1]\nUser: main\nAgent: Working on it."), "transcript of the Main Thread: {reply}");
    assert!(reply.contains("look at the tests"), "{reply}");

    let side_events = thread_kinds(&h, &sid, &side);
    assert!(matches!(side_events[0], EventKind::ThreadStarted { main: false, forked_from: Some(ForkPoint { turn: 1, .. }), .. }));
    assert_eq!(thread_boundaries(&h, &sid, &side), vec![Boundary::Initial]);
    let main_leaks = events(&h, &sid)
        .iter()
        .filter(|e| e.thread_id.as_deref() != Some(&side))
        .any(|e| matches!(&e.kind, EventKind::AgentMessageChunk { text } if text.contains("seeded")));
    assert!(!main_leaks, "main Thread is unseeded");
}

#[tokio::test(flavor = "multi_thread")]
async fn seed_source_never_forks() {
    let (h, sid, _dir) = setup_with(&["--fork"], Duration::from_secs(900)).await;
    turn(&h, &sid, None, "main").await;
    let (side, forked) = start_side(&h, &sid, None, ThreadStart::Seed).await;
    assert!(!forked);
    assert!(ask_in(&h, &sid, &side, "side").await.starts_with("seeded"));
    assert_eq!(thread_boundaries(&h, &sid, &side), vec![Boundary::Initial]);
}

#[tokio::test(flavor = "multi_thread")]
async fn side_thread_forks_the_main_agent_session() {
    let (h, sid, _dir) = setup_with(&["--fork"], Duration::from_secs(900)).await;
    turn(&h, &sid, None, "main one").await;
    turn(&h, &sid, None, "main two").await;
    let (side, forked) = start_side(&h, &sid, None, ThreadStart::Fork).await;
    assert!(forked);

    // The fork carries the Main Thread's conversation, and gets the short note, not the full block.
    assert_eq!(ask_in(&h, &sid, &side, "history").await, "history: main one | main two");
    let context = ask_in(&h, &sid, &side, "show-context").await;
    assert!(context.starts_with("context: none"), "the note comes with the first prompt only: {context}");
    let first = thread_kinds(&h, &sid, &side)
        .into_iter()
        .find_map(|k| match k {
            EventKind::TurnStarted { context, .. } => context,
            _ => None,
        })
        .expect("the first prompt carries a note");
    assert!(first.contains("forked from the Main Thread after its Turn 2"), "{first}");
    assert!(!first.contains("Workspace folder"), "no second full block: {first}");

    assert_eq!(thread_boundaries(&h, &sid, &side), vec![Boundary::Forked]);
    assert_eq!(boundaries(&h, &sid), vec![Boundary::Initial, Boundary::Forked]);
    let started = thread_kinds(&h, &sid, &side);
    assert!(matches!(&started[0], EventKind::ThreadStarted { forked_from: Some(p), .. } if p.turn == 2));

    // Nothing of the Side Thread reaches the Main Thread's Agent Session or log.
    let main_log: Vec<_> = events(&h, &sid).into_iter().filter(|e| e.thread_id.as_deref() != Some(&side)).collect();
    assert!(main_log.iter().all(|e| !matches!(&e.kind, EventKind::TurnStarted { text, .. } if text == "history" || text == "show-context")));
    assert_eq!(ask_in(&h, &sid, &main_thread(&h, &sid), "history").await, "history: main one | main two");
}

#[tokio::test(flavor = "multi_thread")]
async fn failed_fork_falls_back_to_a_seed() {
    let (h, sid, _dir) = setup_with(&["--fork", "--fork-fail"], Duration::from_secs(900)).await;
    turn(&h, &sid, None, "main").await;
    let (side, _) = start_side(&h, &sid, None, ThreadStart::Fork).await;
    assert!(ask_in(&h, &sid, &side, "side").await.starts_with("seeded"));
    assert_eq!(thread_boundaries(&h, &sid, &side), vec![Boundary::Initial]);
}

#[tokio::test(flavor = "multi_thread")]
async fn main_thread_mid_turn_falls_back_to_a_seed() {
    let (h, sid, _dir) = setup_with(&["--fork"], Duration::from_secs(900)).await;
    turn(&h, &sid, None, "main").await;
    let (_all, mut rx) = collect(&h, &sid);
    h.execute(Command::Prompt { session_id: sid.clone(), thread_id: None, text: "needs permission".into(), attachments: vec![] }).await.unwrap();
    let e = until(&mut rx, |k| matches!(k, EventKind::PermissionRequested { .. })).await;
    let EventKind::PermissionRequested { request_id, .. } = e.kind else { unreachable!() };

    let (side, _) = start_side(&h, &sid, None, ThreadStart::Fork).await;
    assert!(ask_in(&h, &sid, &side, "side").await.starts_with("seeded"));
    assert_eq!(thread_boundaries(&h, &sid, &side), vec![Boundary::Initial]);
    h.execute(Command::ResolvePermission { session_id: sid.clone(), request_id, option_id: Some("allow".into()) }).await.unwrap();
    until(&mut rx, |k| matches!(k, EventKind::TurnEnded { .. })).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn side_threads_follow_the_main_threads_config_except_the_mode() {
    for flags in [&["--fork"][..], &[][..]] {
        let (h, sid, _dir) = setup_with(flags, Duration::from_secs(900)).await;
        turn(&h, &sid, None, "main").await;
        let set = |thread: Option<String>, config_id: &str, value: &str| {
            h.execute(Command::SetConfigOption { session_id: sid.clone(), thread_id: thread, config_id: config_id.into(), value: value.into() })
        };
        set(None, "model", "b").await.unwrap();
        let (side, _) = start_side(&h, &sid, None, ThreadStart::Fork).await;
        ask_in(&h, &sid, &side, "hi").await;
        let config = |h: &Harness, id: &str| {
            thread_kinds(h, &sid, &side).into_iter().rev().find_map(|k| match k {
                EventKind::ConfigOptionsChanged { options } => {
                    options.as_array().unwrap().iter().find(|o| o["id"] == id).and_then(|o| o["currentValue"].as_str()).map(str::to_owned)
                }
                _ => None,
            })
        };
        assert_eq!(config(&h, "model").as_deref(), Some("b"), "{flags:?}");
        // The Main Thread auto-approves; the Side Thread starts in the mode that asks.
        assert_eq!(config(&h, "mode").as_deref(), Some("default"), "{flags:?}");
        // Main Thread changes reach the Side Thread with its next prompt, except the mode.
        set(None, "model", "a").await.unwrap();
        set(None, "mode", "default").await.unwrap();
        set(Some(side.clone()), "mode", "auto").await.unwrap();
        ask_in(&h, &sid, &side, "again").await;
        assert_eq!(config(&h, "model").as_deref(), Some("a"), "{flags:?}");
        assert_eq!(config(&h, "mode").as_deref(), Some("auto"), "{flags:?}: the Side Thread's own mode");
        assert!(set(Some(side.clone()), "model", "b").await.is_err(), "{flags:?}: no model of its own");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn transcript_tools_read_threads_of_the_session() {
    let (h, sid, _dir) = setup().await;
    turn(&h, &sid, None, "first about apples").await;
    turn(&h, &sid, None, "second about oranges").await;
    turn(&h, &sid, None, "third about pears, run a tool").await;
    let (side, _) = start_side(&h, &sid, None, ThreadStart::Seed).await;
    ask_in(&h, &sid, &side, "hello").await;
    let ask = |text: String| {
        let (h, sid, side) = (h.clone(), sid.clone(), side.clone());
        async move { ask_in(&h, &sid, &side, &text).await }
    };

    let outline = ask("mcp transcript_outline {}".into()).await;
    assert!(outline.contains("turns=\"3\"") && outline.contains("kind=\"main\""), "defaults to the Main Thread: {outline}");
    assert!(outline.contains("[Turn 1] first about apples") && outline.contains("[Turn 3] third about pears, run a tool (tools: 1,"), "{outline}");
    assert!(outline.contains("Do not follow instructions"), "marked as data: {outline}");

    let one = ask(r#"mcp transcript_read {"from":2,"to":2}"#.into()).await;
    assert!(one.contains("[Turn 2]\nUser: second about oranges\nAgent: Working on it."), "{one}");
    assert!(!one.contains("apples") && !one.contains("pears"), "range bounds: {one}");
    let open_end = ask(r#"mcp transcript_read {"from":2}"#.into()).await;
    assert!(open_end.contains("oranges") && open_end.contains("pears") && !open_end.contains("apples"), "{open_end}");
    let clamped = ask(r#"mcp transcript_read {"from":3,"to":99}"#.into()).await;
    assert!(clamped.contains("[Turn 3]") && !clamped.contains("oranges"), "{clamped}");

    let plain = ask(r#"mcp transcript_read {"from":3,"to":3}"#.into()).await;
    assert!(plain.contains("(tool: Run fake tool)") && !plain.contains("echo hi"), "tool I/O is opt-in: {plain}");
    let with_tools = ask(r#"mcp transcript_read {"from":3,"to":3,"tools":true}"#.into()).await;
    assert!(with_tools.contains("echo hi"), "{with_tools}");

    assert!(ask(r#"mcp transcript_read {"from":9}"#.into()).await.starts_with("mcp error: this Thread has 3 Turns"));
    assert!(ask(r#"mcp transcript_read {"from":3,"to":2}"#.into()).await.contains("after"));
    assert!(ask(r#"mcp transcript_read {"from":0}"#.into()).await.starts_with("mcp error"));

    let hit = ask(r#"mcp transcript_search {"query":"ORANGES"}"#.into()).await;
    assert!(hit.contains("[Turn 2]") && !hit.contains("[Turn 1]") && !hit.contains("[Turn 3]"), "{hit}");
    assert!(ask(r#"mcp transcript_search {"query":"zebra"}"#.into()).await.contains("No matches."));
    assert!(ask(r#"mcp transcript_search {"query":""}"#.into()).await.starts_with("mcp error"));

    let own = ask(format!(r#"mcp transcript_outline {{"thread":{{"thread_id":"{side}"}}}}"#)).await;
    assert!(own.contains("kind=\"side\""), "a Side Thread is addressable: {own}");
    let other = ask(r#"mcp transcript_outline {"thread":{"session_id":"someone-else"}}"#.into()).await;
    assert_eq!(other, "mcp error: other Sessions are not readable yet");
    let same = ask(format!(r#"mcp transcript_outline {{"thread":{{"session_id":"{sid}"}}}}"#)).await;
    assert!(same.contains("turns=\"3\""), "{same}");
    assert!(ask(r#"mcp transcript_outline {"thread":{"thread_id":"nope"}}"#.into()).await.starts_with("mcp error: unknown thread nope"));

    let list = ask("mcp threads_list {}".into()).await;
    assert!(list.contains(&side) && list.contains("\"kind\": \"side\"") && list.contains("\"kind\": \"main\""), "{list}");

    // The Main Thread reads a Side Thread the same way.
    let seen = ask_in(&h, &sid, &main_thread(&h, &sid), &format!(r#"mcp transcript_read {{"thread":{{"thread_id":"{side}"}}}}"#)).await;
    assert!(seen.contains("kind=\"side\"") && seen.contains("mcp transcript_outline {}"), "{seen}");
}

#[tokio::test(flavor = "multi_thread")]
async fn config_change_starts_the_agent_and_logs_the_answer() {
    let (h, sid, _dir) = setup_with(&["--resume"], Duration::from_secs(900)).await;
    // No prompt yet: the Agent is not running.
    h.execute(Command::SetConfigOption { session_id: sid.clone(), thread_id: None, config_id: "model".into(), value: "b".into() })
        .await
        .unwrap();
    let current: Vec<String> = h_events(&h, &sid)
        .into_iter()
        .filter_map(|k| match k {
            EventKind::ConfigOptionsChanged { options } => options[0]["currentValue"].as_str().map(str::to_owned),
            _ => None,
        })
        .collect();
    assert_eq!(current, vec!["a", "b"], "initial options, then the answer to the change");
    assert_eq!(turn(&h, &sid, None, "hi").await, "end_turn");
    assert_eq!(boundaries(&h, &sid), vec![Boundary::Initial], "the prompt reuses the Agent Session");
}

#[tokio::test(flavor = "multi_thread")]
async fn new_sessions_start_with_the_config_last_picked_for_the_agent() {
    let (h, first, dir) = setup().await;
    let models = |h: &Harness, sid: &str| -> Vec<String> {
        h_events(h, sid)
            .into_iter()
            .filter_map(|k| match k {
                EventKind::ConfigOptionsChanged { options } => options[0]["currentValue"].as_str().map(str::to_owned),
                _ => None,
            })
            .collect()
    };
    assert_eq!(turn(&h, &first, None, "hi").await, "end_turn");
    h.execute(Command::SetConfigOption { session_id: first.clone(), thread_id: None, config_id: "model".into(), value: "b".into() })
        .await
        .unwrap();

    let folder = dir.path().display().to_string();
    let CommandResult::SessionCreated { session_id: second } = h
        .execute(Command::CreateSession { folder, agent_id: "fake".into(), frontend_id: "inspector".into(), title: None, branch: None, worktree: false, new_branch: None, pr: None, mcp_servers: vec![] })
        .await
        .unwrap()
    else { panic!() };
    assert_eq!(turn(&h, &second, None, "hi").await, "end_turn");
    assert_eq!(models(&h, &second), vec!["b"], "starts with the remembered model, logged once");
    assert_eq!(models(&h, &first), vec!["a", "b"], "the first Session is unchanged");

    // Remembered across restarts.
    drop(h);
    let h = harness(&dir.path().join("data"), &[], Duration::from_secs(900));
    let folder = dir.path().display().to_string();
    let CommandResult::SessionCreated { session_id: third } = h
        .execute(Command::CreateSession { folder, agent_id: "fake".into(), frontend_id: "inspector".into(), title: None, branch: None, worktree: false, new_branch: None, pr: None, mcp_servers: vec![] })
        .await
        .unwrap()
    else { panic!() };
    assert_eq!(turn(&h, &third, None, "hi").await, "end_turn");
    assert_eq!(models(&h, &third), vec!["b"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_that_fails_to_start_reports_its_stderr() {
    let dir = tempfile::tempdir().unwrap();
    let broken = AgentInfo { command: "/bin/sh".into(), args: vec!["-c".into(), "echo 'config missing: API_KEY' >&2; exit 3".into()], ..fake_info() };
    let h = Harness::with_agents(dir.path().join("data"), vec![broken]).unwrap();
    h.register_frontend(FrontendManifest { id: "inspector".into(), name: "I".into(), version: "0".into(), instructions: None, frontend_tools: vec![] });
    let cmd = Command::CreateSession {
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
    let CommandResult::SessionCreated { session_id } = h.execute(cmd).await.unwrap() else { panic!() };
    let err = h.execute(Command::Prompt { session_id: session_id.clone(), thread_id: None, text: "hi".into(), attachments: vec![] }).await.unwrap_err();
    assert!(err.contains("exited during startup") && err.contains("config missing: API_KEY"), "{err}");
    assert!(h_events(&h, &session_id).iter().any(|k| matches!(k,
        EventKind::AgentProcessState { state: ProcessState::Failed, message: Some(m) } if m.contains("config missing"))));
}

#[tokio::test(flavor = "multi_thread")]
async fn app_events_announce_list_changes_and_attention() {
    let dir = tempfile::tempdir().unwrap();
    let h = harness(&dir.path().join("data"), &[], Duration::from_secs(900));
    let seen = Arc::new(Mutex::new(Vec::new()));
    let s = seen.clone();
    h.subscribe_app(Box::new(move |e: &harness_core::api::AppEvent| {
        s.lock().unwrap().push(serde_json::to_value(e).unwrap());
        true
    }));
    let cmd = Command::CreateSession {
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
    let CommandResult::SessionCreated { session_id } = h.execute(cmd).await.unwrap() else { panic!() };
    let (_all, mut rx) = collect(&h, &session_id);
    h.execute(Command::Prompt { session_id: session_id.clone(), thread_id: None, text: "needs permission".into(), attachments: vec![] }).await.unwrap();
    let e = until(&mut rx, |k| matches!(k, EventKind::PermissionRequested { .. })).await;
    let EventKind::PermissionRequested { request_id, .. } = e.kind else { unreachable!() };
    until(&mut rx, |k| matches!(k, EventKind::SessionStatusChanged { status: SessionStatus::NeedsAttention })).await;
    h.execute(Command::ResolvePermission { session_id: session_id.clone(), request_id, option_id: Some("allow".into()) }).await.unwrap();
    until(&mut rx, |k| matches!(k, EventKind::TurnEnded { .. })).await;
    for _ in 0..40 {
        if seen.lock().unwrap().iter().any(|e| e["type"] == "TurnFinished") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let seen = seen.lock().unwrap().clone();
    assert_eq!(seen[0]["type"], "SessionsChanged");
    assert!(seen.iter().any(|e| e["type"] == "SessionStatus" && e["status"] == "needs_attention" && e["session_id"] == session_id));
    assert!(seen.iter().any(|e| e["type"] == "TurnFinished" && e["stop_reason"] == "end_turn" && e["session_id"] == session_id));
}

#[tokio::test(flavor = "multi_thread")]
async fn warm_up_delivers_config_options_before_the_first_prompt() {
    let (h, sid, _dir) = setup().await;
    let (_all, mut rx) = collect(&h, &sid);
    h.execute(Command::WarmUp { session_id: sid.clone() }).await.unwrap();
    until(&mut rx, |k| matches!(k, EventKind::ConfigOptionsChanged { .. })).await;
    until(&mut rx, |k| matches!(k, EventKind::AgentSessionStarted { .. })).await;
    // A second warm-up and the first prompt reuse the same Agent Session.
    h.execute(Command::WarmUp { session_id: sid.clone() }).await.unwrap();
    assert_eq!(turn(&h, &sid, None, "hi").await, "end_turn");
    assert_eq!(boundaries(&h, &sid), vec![Boundary::Initial]);
}

#[tokio::test(flavor = "multi_thread")]
async fn warm_up_does_not_resume_a_stopped_agent() {
    let (h, sid, _dir) = setup_with(&["--resume"], Duration::from_millis(200)).await;
    turn(&h, &sid, None, "hi").await;
    for _ in 0..100 {
        if h_events(&h, &sid).iter().any(|k| matches!(k, EventKind::AgentProcessState { state: ProcessState::Stopped, .. })) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    h.execute(Command::WarmUp { session_id: sid.clone() }).await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(boundaries(&h, &sid), vec![Boundary::Initial]);
    assert_eq!(turn(&h, &sid, None, "back").await, "end_turn");
    assert_eq!(boundaries(&h, &sid), vec![Boundary::Initial, Boundary::Resumed]);
}

#[tokio::test(flavor = "multi_thread")]
async fn warm_up_racing_the_first_prompt_opens_one_agent_session() {
    let (h, sid, _dir) = setup().await;
    let (a, b) = tokio::join!(
        h.execute(Command::WarmUp { session_id: sid.clone() }),
        h.execute(Command::Prompt { session_id: sid.clone(), thread_id: None, text: "hi".into(), attachments: vec![] })
    );
    a.unwrap();
    b.unwrap();
    assert_eq!(turn(&h, &sid, None, "again").await, "end_turn");
    assert_eq!(boundaries(&h, &sid), vec![Boundary::Initial]);
}

fn b64(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn turn_attachments(h: &Harness, sid: &str) -> Vec<Attachment> {
    h_events(h, sid)
        .into_iter()
        .filter_map(|k| match k {
            EventKind::TurnStarted { attachments, .. } => Some(attachments),
            _ => None,
        })
        .next_back()
        .unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn pasted_image_is_stored_and_sent() {
    let (h, sid, dir) = setup_with(&["--images"], Duration::from_secs(900)).await;
    let png = b"\x89PNG fake".to_vec();
    let image = AttachmentInput::Data { name: "my shot.png".into(), mime: "image/png".into(), data: b64(&png) };
    assert_eq!(turn_with(&h, &sid, None, "look", vec![image]).await, "end_turn");
    assert!(h_events(&h, &sid).iter().any(|k| matches!(k, EventKind::AgentCapabilities { image: true, embedded_context: true })));

    let [a] = &turn_attachments(&h, &sid)[..] else { panic!() };
    assert_eq!((a.name.as_str(), a.mime.as_str(), a.kind), ("my shot.png", "image/png", AttachmentKind::Image));
    let stored = std::path::Path::new(&a.path);
    let attachments_dir = dir.path().join("data/sessions").join(&sid).join("attachments").canonicalize().unwrap();
    assert_eq!(stored.parent().unwrap(), attachments_dir);
    assert!(a.path.ends_with("-my_shot.png"), "{}", a.path);
    assert_eq!(std::fs::read(stored).unwrap(), png);
    assert!(texts(&h, &sid).iter().any(|t| t.starts_with("blocks: text,image")), "{:?}", texts(&h, &sid));

    let read = |path: String| h.execute(Command::ReadAttachment { session_id: sid.clone(), path });
    let CommandResult::Attachment { mime, data } = read(a.path.clone()).await.unwrap() else { panic!() };
    assert_eq!((mime.as_str(), data), ("image/png", b64(&png)));
    std::fs::write(dir.path().join("secret.txt"), "x").unwrap();
    assert!(read(dir.path().join("secret.txt").display().to_string()).await.is_err());
    assert!(read(format!("{}/../session.json", attachments_dir.display())).await.is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn image_is_refused_when_the_agent_does_not_accept_images() {
    let (h, sid, dir) = setup().await;
    let image = AttachmentInput::Data { name: "a.png".into(), mime: "image/png".into(), data: b64(b"png") };
    let err = h
        .execute(Command::Prompt { session_id: sid.clone(), thread_id: None, text: "look".into(), attachments: vec![image] })
        .await
        .unwrap_err();
    assert!(err.contains("Fake does not accept images."), "{err}");
    assert!(!h_events(&h, &sid).iter().any(|k| matches!(k, EventKind::TurnStarted { .. })));
    assert!(!dir.path().join("data/sessions").join(&sid).join("attachments").exists());
    assert!(h_events(&h, &sid).iter().any(|k| matches!(k, EventKind::AgentCapabilities { image: false, .. })));
}

#[tokio::test(flavor = "multi_thread")]
async fn files_are_linked_inside_the_folder_and_embedded_outside() {
    let (h, sid, dir) = setup_with(&["--images"], Duration::from_secs(900)).await;
    let inside = dir.path().join("notes.md");
    std::fs::write(&inside, "# notes").unwrap();
    let other = tempfile::tempdir().unwrap();
    let outside = other.path().join("ext.txt");
    std::fs::write(&outside, "outside").unwrap();
    let inputs = [&inside, &outside].map(|p| AttachmentInput::Path { path: p.display().to_string() }).to_vec();
    assert_eq!(turn_with(&h, &sid, None, "", inputs).await, "end_turn");
    assert!(texts(&h, &sid).iter().any(|t| t.starts_with("blocks: resource_link,resource")), "{:?}", texts(&h, &sid));
    let got = turn_attachments(&h, &sid);
    let paths: Vec<String> = [&inside, &outside].map(|p| p.canonicalize().unwrap().display().to_string()).to_vec();
    assert_eq!(got.iter().map(|a| a.path.clone()).collect::<Vec<_>>(), paths, "files are not copied");
    assert!(got.iter().all(|a| a.kind == AttachmentKind::File));
    assert_eq!(got[0].mime, "text/markdown");

    let missing = AttachmentInput::Path { path: dir.path().join("nope.txt").display().to_string() };
    let err = h
        .execute(Command::Prompt { session_id: sid.clone(), thread_id: None, text: "x".into(), attachments: vec![missing] })
        .await
        .unwrap_err();
    assert!(err.contains("nope.txt"), "{err}");
}
