//! Pins what the log projections of `session.rs` (`frontend_items`, `frontend_errors`,
//! `attached_shared`) return for small hand-built logs. They read the Session Log, so whatever
//! replaces them (projections kept up to date on append) must give the same answers.
#![allow(clippy::unwrap_used, reason = "tests fail loudly")]

use super::*;
use crate::api::{Command, CommandResult, StateWriter};
use serde_json::json;

pub(crate) async fn session() -> (Arc<Session>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let agent = AgentInfo {
        id: "a".into(),
        name: "A".into(),
        command: "true".into(),
        args: vec![],
        env: Default::default(),
        source: Default::default(),
        version: None,
        icon: None,
        install: Default::default(),
    };
    let h = crate::Harness::with_options(dir.path().join("data"), vec![agent], Default::default()).unwrap();
    h.register_frontend(crate::api::FrontendManifest { id: "chat".into(), name: "C".into(), version: "0".into(), instructions: None, frontend_tools: vec![] });
    let create = Command::CreateSession {
        folder: dir.path().display().to_string(),
        agent_id: "a".into(),
        frontend_id: "chat".into(),
        title: None,
        branch: None,
        worktree: false,
        new_branch: None,
        pr: None,
        mcp_servers: vec![],
    };
    let CommandResult::SessionCreated { session_id } = h.execute(create).await.unwrap() else { panic!() };
    (h.session(&session_id).unwrap(), dir)
}

fn call(s: &Session, tool: &str, call_id: &str, input: serde_json::Value) {
    let thread = s.meta().main_thread_id;
    let kind = EventKind::FrontendToolOutput { tool: tool.into(), call_id: call_id.into(), path: format!("{call_id}.json"), input, files: Default::default() };
    s.log.append(Some(thread), kind).unwrap();
}

/// (tool, id) of every live item, in order.
fn keys(s: &Session) -> Vec<(String, String)> {
    s.frontend_items().unwrap().into_iter().map(|i| (i.tool.clone(), i.id.clone())).collect()
}

fn key(tool: &str, id: &str) -> (String, String) {
    (tool.to_owned(), id.to_owned())
}

#[tokio::test]
async fn frontend_items_are_added_replaced_and_removed_in_first_seen_order() {
    let (s, _dir) = session().await;
    assert!(s.frontend_items().unwrap().is_empty());
    call(&s, "render_ui", "c1", json!({ "id": "a", "v": 1 }));
    call(&s, "render_ui", "c2", json!({ "id": "b", "v": 1 }));
    call(&s, "other_tool", "c3", json!({ "id": "a", "v": 1 }));
    // A call without an `id` is not an item.
    call(&s, "render_ui", "c4", json!({ "v": 9 }));
    assert_eq!(keys(&s), vec![key("render_ui", "a"), key("render_ui", "b"), key("other_tool", "a")]);

    // The same tool and id replaces the input and keeps the place; the same id of another tool
    // is a different item.
    call(&s, "render_ui", "c5", json!({ "id": "a", "v": 2 }));
    let items = s.frontend_items().unwrap();
    assert_eq!(items.len(), 3);
    assert_eq!((items[0].tool.as_str(), items[0].id.as_str(), items[0].input["v"].clone()), ("render_ui", "a", json!(2)));
    assert_eq!(items[2].input["v"], 1);
    assert_eq!(items[0].thread, Some(s.meta().main_thread_id));

    // `remove: true` drops the item; removing one that is not there changes nothing; it can be
    // added again, at the end.
    call(&s, "render_ui", "c6", json!({ "id": "b", "remove": true }));
    call(&s, "render_ui", "c7", json!({ "id": "zzz", "remove": true }));
    assert_eq!(keys(&s), vec![key("render_ui", "a"), key("other_tool", "a")]);
    call(&s, "render_ui", "c8", json!({ "id": "b", "v": 3 }));
    assert_eq!(keys(&s), vec![key("render_ui", "a"), key("other_tool", "a"), key("render_ui", "b")]);
}

#[tokio::test]
async fn frontend_errors_are_reported_once_and_cleared_by_a_new_call_or_removal() {
    let (s, _dir) = session().await;
    call(&s, "render_ui", "c1", json!({ "id": "a" }));
    assert!(s.frontend_errors().unwrap().is_empty());

    s.report_frontend_error("render_ui", "a", "  boom  ").unwrap();
    let errors = s.frontend_errors().unwrap();
    assert_eq!(errors.len(), 1);
    assert_eq!((errors[0].tool.as_str(), errors[0].item.as_str(), errors[0].message.as_str()), ("render_ui", "a", "boom"));
    assert_eq!(errors[0].thread, s.meta().main_thread_id);

    // The same message again is not recorded; other ones are, up to the cap.
    s.report_frontend_error("render_ui", "a", "boom").unwrap();
    assert_eq!(s.frontend_errors().unwrap().len(), 1);
    for i in 0..MAX_FRONTEND_ERRORS + 3 {
        s.report_frontend_error("render_ui", "a", &format!("other {i}")).unwrap();
    }
    let errors = s.frontend_errors().unwrap();
    assert_eq!(errors.len(), MAX_FRONTEND_ERRORS);
    assert!(errors.windows(2).all(|w| w[0].seq < w[1].seq), "oldest first");

    // An item that does not exist takes no errors; an empty message is refused.
    s.report_frontend_error("render_ui", "nope", "x").unwrap();
    assert!(s.frontend_errors().unwrap().iter().all(|e| e.item == "a"));
    assert!(s.report_frontend_error("render_ui", "a", "   ").is_err());

    // A new call with the item's id clears its errors, and only its.
    call(&s, "render_ui", "c2", json!({ "id": "b" }));
    s.report_frontend_error("render_ui", "b", "b broke").unwrap();
    call(&s, "render_ui", "c3", json!({ "id": "a", "v": 2 }));
    let errors = s.frontend_errors().unwrap();
    assert_eq!(errors.len(), 1);
    assert_eq!(errors[0].item, "b");

    // Removing the item drops its errors.
    call(&s, "render_ui", "c4", json!({ "id": "b", "remove": true }));
    assert!(s.frontend_errors().unwrap().is_empty());
}

#[tokio::test]
async fn long_frontend_error_messages_are_cut() {
    let (s, _dir) = session().await;
    call(&s, "render_ui", "c1", json!({ "id": "a" }));
    s.report_frontend_error("render_ui", "a", &"x".repeat(MAX_FRONTEND_ERROR_LEN * 2)).unwrap();
    let message = s.frontend_errors().unwrap().remove(0).message;
    assert_eq!(message.chars().count(), MAX_FRONTEND_ERROR_LEN + 1);
    assert!(message.ends_with('…'));
}

#[tokio::test]
async fn frontend_calls_without_an_id_are_reportable_by_their_call_id() {
    let (s, _dir) = session().await;
    call(&s, "render_ui", "call-9", json!({ "v": 1 }));
    s.report_frontend_error("render_ui", "call-9", "no id").unwrap();
    assert_eq!(s.frontend_errors().unwrap().len(), 1);
    assert!(s.frontend_items().unwrap().is_empty(), "still not an item");
}

#[tokio::test]
async fn attached_shared_follows_attach_and_detach_in_order() {
    let (s, _dir) = session().await;
    let attach = |id: &str| s.log.append(None, EventKind::ArtifactAttached { id: id.into(), by: StateWriter::Agent }).unwrap();
    let detach = |id: &str| s.log.append(None, EventKind::ArtifactDetached { id: id.into(), by: StateWriter::User }).unwrap();
    assert!(s.attached_shared().unwrap().is_empty());
    attach("a");
    attach("b");
    attach("a");
    assert_eq!(s.attached_shared().unwrap(), vec!["a", "b"], "attaching twice keeps one");
    detach("a");
    assert_eq!(s.attached_shared().unwrap(), vec!["b"]);
    detach("nope");
    assert_eq!(s.attached_shared().unwrap(), vec!["b"]);
    attach("a");
    assert_eq!(s.attached_shared().unwrap(), vec!["b", "a"], "re-attached goes last");
    // Another kind of Event in between changes nothing.
    s.log.append(None, EventKind::ArtifactStateChanged { id: "b".into(), ops: vec![], by: StateWriter::Agent }).unwrap();
    assert_eq!(s.attached_shared().unwrap(), vec!["b", "a"]);
    // Folders only for artifacts that still exist (none of these were created).
    assert!(s.attached_shared_dirs().is_empty());
}
