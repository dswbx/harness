//! What an earlier run left open (killed mid-Turn, closing Events dropped by a failing disk) is
//! closed when the Session is opened again, once, and only for a log that is written to.
#![allow(clippy::unwrap_used, reason = "tests fail loudly")]

use super::projection_tests::session;
use super::*;
use crate::api::{PermissionOption, Resolver};

fn started(turn: &str) -> EventKind {
    EventKind::TurnStarted { turn_id: turn.into(), text: "go".into(), attachments: vec![], context: None, origin: None }
}

fn asked(id: &str) -> EventKind {
    EventKind::PermissionRequested {
        request_id: id.into(),
        tool_call: serde_json::json!({}),
        options: vec![PermissionOption { option_id: "allow".into(), name: "Allow".into(), kind: "allow_once".into(), plan_mode: None, clears_context: false }],
        harness_tool: None,
        plan: None,
        commit_message: None,
        frontend_tool: None,
        mode_before: None,
    }
}

/// A Session whose log ends mid-Turn with an unanswered permission request, as after a kill.
/// Returns it closed, so it can be opened again.
async fn killed_mid_turn() -> (Arc<Session>, tempfile::TempDir, ThreadId) {
    let (s, dir) = session().await;
    let main = s.meta().main_thread_id;
    s.log.append(Some(main.clone()), started("t1")).unwrap();
    s.log.append(Some(main.clone()), asked("r1")).unwrap();
    s.log.sync().unwrap();
    s.log.close();
    (s, dir, main)
}

fn reopen(s: &Session) -> Session {
    Session::open(s.dir(), s.shared.clone()).unwrap()
}

fn kinds(s: &Session) -> Vec<String> {
    s.log.events().unwrap().iter().map(|e| format!("{:?}", e.kind).split([' ', '{', '(']).next().unwrap().to_owned()).collect()
}

#[tokio::test]
async fn a_kill_mid_turn_reopens_idle_with_the_request_cancelled() {
    let (s, _dir, main) = killed_mid_turn().await;
    let r = reopen(&s);
    assert!(!r.thread_working(&main).unwrap());
    let events = r.log.events().unwrap();
    let tail: Vec<_> = events.iter().rev().take(2).map(|e| &e.kind).collect();
    assert!(matches!(tail[0], EventKind::TurnEnded { turn_id, stop_reason } if turn_id == "t1" && stop_reason == "cancelled"), "{tail:?}");
    assert!(matches!(tail[1], EventKind::PermissionResolved { request_id, option_id: None, by: Resolver::Cancelled, .. } if request_id == "r1"), "{tail:?}");
    assert_eq!(events.last().unwrap().thread_id.as_ref(), Some(&main));
}

#[tokio::test]
async fn the_repair_is_done_once() {
    let (s, _dir, _main) = killed_mid_turn().await;
    let first = reopen(&s);
    first.log.sync().unwrap();
    let n = kinds(&first).len();
    first.log.close();
    let second = reopen(&s);
    assert_eq!(kinds(&second).len(), n, "a second open appends nothing");
}

#[tokio::test]
async fn a_new_turn_after_the_repair_is_not_closed_by_it() {
    let (s, _dir, main) = killed_mid_turn().await;
    let r = reopen(&s);
    // The first append of this run loads the log, closes the old Turn, then takes its own seq.
    r.log.append(Some(main.clone()), started("t2")).unwrap();
    assert!(r.thread_working(&main).unwrap());
    let seqs: Vec<u64> = r.log.events().unwrap().iter().map(|e| e.seq).collect();
    assert!(seqs.windows(2).all(|w| w[0] + 1 == w[1]), "{seqs:?}");
    assert!(matches!(r.log.events().unwrap().last().unwrap().kind, EventKind::TurnStarted { .. }));
}

#[tokio::test]
async fn a_read_only_or_archived_log_is_not_written_and_does_not_report_working() {
    // Archived.
    let (s, _dir, main) = killed_mid_turn().await;
    let before = std::fs::read(s.dir().join("log.jsonl")).unwrap();
    s.update_meta(|m| m.archived = true).unwrap();
    let r = reopen(&s);
    assert!(!r.thread_working(&main).unwrap());
    r.log.events().unwrap();
    r.log.close();
    assert_eq!(std::fs::read(s.dir().join("log.jsonl")).unwrap(), before);

    // Written by a newer Harness.
    let (s, _dir, main) = killed_mid_turn().await;
    let path = s.dir().join("log.jsonl");
    let mut text = std::fs::read_to_string(&path).unwrap();
    text.push_str("{\"v\":999,\"seq\":99,\"session_id\":\"x\",\"thread_id\":null,\"ts_ms\":1,\"kind\":{\"type\":\"Error\",\"message\":\"x\"}}\n");
    std::fs::write(&path, &text).unwrap();
    let r = reopen(&s);
    assert!(r.log.read_only_reason().is_some());
    assert!(!r.thread_working(&main).unwrap());
    r.log.close();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), text);
}
