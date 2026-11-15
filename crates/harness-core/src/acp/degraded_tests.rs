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
