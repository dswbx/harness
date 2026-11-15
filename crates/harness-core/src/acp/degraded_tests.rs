//! Answering a permission request while the Session Log cannot be written: the answer still
//! reaches whoever waits, and a request that could not be asked leaves nothing pending.
#![allow(clippy::unwrap_used, reason = "tests fail loudly")]

use super::process::{Answer, Pending};
use crate::api::PermissionOption;
use crate::session::projection_tests::session;
use std::time::Duration;

fn options() -> Vec<PermissionOption> {
    vec![PermissionOption { option_id: "allow".into(), name: "Allow".into(), kind: "allow_once".into(), plan_mode: None, clears_context: false }]
}

async fn eventually(what: &str, mut cond: impl FnMut() -> bool) {
    for _ in 0..2000 {
        if cond() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("timed out: {what}");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_answer_reaches_the_agent_while_the_log_is_degraded() {
    let (s, _dir) = session().await;
    let main = s.meta().main_thread_id;
    let (tx, rx) = tokio::sync::oneshot::channel();
    s.agent_slot().add_pending(
        &s,
        "r1".into(),
        Pending { thread: Some(main), responder: Answer::Local(tx), options: options(), facts: Default::default() },
        || {},
    );
    s.log().inject_write_failure(true);
    // Something that fails to write: the log is degraded, and so is every sync.
    s.log().append(None, crate::api::EventKind::Error { message: "x".into() }).unwrap();
    eventually("degraded", || s.log().degraded().is_some()).await;
    assert!(s.log().sync().is_err());

    // The awaited sync fails too: the answer still arrives and nothing stays pending.
    s.agent_slot().resolve_permission(&s, "r1", Some("allow".into()), false).await.unwrap();
    assert!(s.agent_slot().state.lock().pending.is_empty());
    assert_eq!(rx.await.unwrap().as_deref(), Some("allow"));
    assert!(s.log().degraded().is_some(), "still reported");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_harness_tool_request_is_asked_and_answered_while_the_log_is_degraded() {
    let (s, _dir) = session().await;
    let main = s.meta().main_thread_id;
    s.log().inject_write_failure(true);
    s.log().append(None, crate::api::EventKind::Error { message: "x".into() }).unwrap();
    eventually("degraded", || s.log().degraded().is_some()).await;

    let (s2, main2) = (s.clone(), main.clone());
    let asking =
        tokio::spawn(async move { super::authorize(&s2, &main2, "git_commit", "Commit", "execute", &serde_json::json!({ "command": "git commit" })).await });
    eventually("asked", || s.agent_slot().state.lock().pending.len() == 1).await;
    let id = s.agent_slot().state.lock().pending.keys().next().unwrap().clone();
    s.agent_slot().resolve_permission(&s, &id, Some("allow".into()), false).await.unwrap();
    asking.await.unwrap().unwrap();
    assert!(s.agent_slot().state.lock().pending.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_request_that_cannot_be_logged_leaves_nothing_pending() {
    let (s, _dir) = session().await;
    let main = s.meta().main_thread_id;
    s.log().close();
    let r = super::authorize(&s, &main, "git_commit", "Commit", "execute", &serde_json::json!({ "command": "git commit" })).await;
    assert!(r.is_err());
    assert!(s.agent_slot().state.lock().pending.is_empty(), "no dead entry for a request nobody was asked");
}

/// Holds every sync of the log until the returned sender is used.
fn hold_syncs(s: &crate::session::Session) -> std::sync::mpsc::Sender<()> {
    let (release, wait) = std::sync::mpsc::channel::<()>();
    let wait = std::sync::Mutex::new(wait);
    s.log().set_sync_hook(move || {
        let _ = wait.lock().unwrap().recv_timeout(Duration::from_secs(10));
    });
    release
}

/// The Agent is answered only after the sync of the resolution completed: while the sync is held
/// the answer does not arrive, once it is released it does.
#[tokio::test(flavor = "multi_thread")]
async fn a_view_answer_waits_for_the_sync() {
    let (s, _dir) = session().await;
    let main = s.meta().main_thread_id;
    let (tx, mut rx) = tokio::sync::oneshot::channel();
    s.agent_slot().add_pending(
        &s,
        "r1".into(),
        Pending { thread: Some(main), responder: Answer::Local(tx), options: options(), facts: Default::default() },
        || {},
    );
    let release = hold_syncs(&s);
    let s2 = s.clone();
    let task = tokio::spawn(async move { s2.agent_slot().resolve_permission(&s2, "r1", Some("allow".into()), false).await });
    assert!(tokio::time::timeout(Duration::from_millis(300), &mut rx).await.is_err(), "answered before the sync finished");
    release.send(()).unwrap();
    task.await.unwrap().unwrap();
    assert_eq!(rx.await.unwrap().as_deref(), Some("allow"));
}

/// A Policy pass or deny of a Harness tool call returns only after its Events were synced.
#[tokio::test(flavor = "multi_thread")]
async fn a_policy_decision_waits_for_the_sync() {
    use crate::api::{Decision, NewPermissionRule, RuleScope};
    let (s, _dir) = session().await;
    let main = s.meta().main_thread_id;
    for (decision, expect_ok) in [(Decision::Allow, true), (Decision::Deny, false)] {
        s.policy()
            .add(NewPermissionRule { scope: RuleScope::Global, tool_kind: Some("execute".into()), pattern: Some("git commit".into()), decision })
            .unwrap();
        let release = hold_syncs(&s);
        let (s2, m2) = (s.clone(), main.clone());
        let mut call =
            tokio::spawn(async move { super::authorize(&s2, &m2, "git_commit", "Commit", "execute", &serde_json::json!({ "command": "git commit" })).await });
        assert!(tokio::time::timeout(Duration::from_millis(300), &mut call).await.is_err(), "returned before the sync finished");
        release.send(()).unwrap();
        assert_eq!(call.await.unwrap().is_ok(), expect_ok);
        for rule in s.policy().list() {
            s.policy().remove(&rule.id).unwrap();
        }
    }
}
