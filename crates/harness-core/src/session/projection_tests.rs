//! Pins what the log projections (`frontend_items`, `frontend_errors` in `session/frontend.rs`,
//! `attached_shared` in `session/artifacts.rs`) return for small hand-built logs. They read the Session Log, so whatever
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
        task: None,
    };
    let CommandResult::SessionCreated { session_id } = h.execute(create).await.unwrap() else { panic!() };
    (h.session(&session_id).unwrap(), dir)
}

pub(crate) fn call(s: &Session, tool: &str, call_id: &str, input: serde_json::Value) {
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

#[tokio::test]
async fn a_panel_override_survives_the_agent_calling_again_and_deleting_and_reviving_keeps_it() {
    let (s, _dir) = session().await;
    call(&s, "render_ui", "c1", json!({ "id": "a", "title": "Agent title", "root": {} }));
    s.edit_panel("a", Some("  My   panel \n".into()), Some("star".into())).unwrap();
    let item = s.frontend_item("render_ui", "a").unwrap().unwrap();
    assert_eq!((item.display_title(), item.display_icon()), (Some("My panel"), Some("star")));
    call(&s, "render_ui", "c2", json!({ "id": "a", "title": "Agent again", "root": {} }));
    let item = s.frontend_item("render_ui", "a").unwrap().unwrap();
    assert_eq!(item.display_title(), Some("My panel"), "the override survives a re-send");
    assert_eq!(item.input["title"], "Agent again");

    s.delete_panel("a").unwrap();
    assert!(s.frontend_items().unwrap().is_empty());
    assert!(s.frontend_item("render_ui", "a").unwrap().is_none());
    assert!(s.edit_panel("a", None, None).is_err(), "a deleted panel cannot be edited");
    call(&s, "render_ui", "c3", json!({ "id": "a", "title": "Back", "root": {} }));
    let item = s.frontend_item("render_ui", "a").unwrap().unwrap();
    assert_eq!(item.display_title(), Some("My panel"), "revived with the override");

    s.edit_panel("a", Some("   ".into()), None).unwrap();
    let item = s.frontend_item("render_ui", "a").unwrap().unwrap();
    assert_eq!((item.display_title(), item.display_icon()), (Some("Back"), None), "empty goes back to the Agent's");
    let long = "x".repeat(200);
    s.edit_panel("a", Some(long), None).unwrap();
    assert_eq!(s.frontend_item("render_ui", "a").unwrap().unwrap().title.as_ref().unwrap().chars().count(), 80);
}

#[tokio::test]
async fn delete_panel_removes_its_file_and_refuses_shared_and_unknown_items() {
    let (s, _dir) = session().await;
    std::fs::create_dir_all(s.panels_dir()).unwrap();
    let file = s.panels_dir().join("notes.md");
    std::fs::write(&file, "# Hi").unwrap();
    call(&s, "render_ui", "c1", json!({ "id": "a", "source": "notes.md" }));
    call(&s, "render_ui", "c2", json!({ "id": "sh", "source": "shared:map-a1b2c3" }));
    call(&s, "render_ui", "c3", json!({ "id": "esc", "source": "../outside.md" }));
    assert!(s.delete_panel("sh").is_err(), "shared is detached, not deleted");
    assert!(s.edit_panel("sh", Some("x".into()), None).is_err());
    assert!(s.delete_panel("nope").is_err());
    assert_eq!(s.frontend_items().unwrap().len(), 3);
    s.delete_panel("a").unwrap();
    assert!(!file.exists());
    assert_eq!(s.frontend_items().unwrap().len(), 2);
    // A source outside panels/ deletes the panel and touches no file.
    std::fs::write(s.panels_dir().join("../outside.md"), "keep").unwrap();
    s.delete_panel("esc").unwrap();
    assert!(s.panels_dir().join("../outside.md").exists());
    assert_eq!(s.frontend_items().unwrap().len(), 1);
    // A panel whose file is already gone still deletes.
    call(&s, "render_ui", "c4", json!({ "id": "gone", "source": "gone.md" }));
    s.delete_panel("gone").unwrap();
}

#[tokio::test]
async fn sharing_a_panel_takes_the_users_title_and_icon() {
    let (s, _dir) = session().await;
    std::fs::create_dir_all(s.panels_dir()).unwrap();
    std::fs::write(s.panels_dir().join("notes.md"), "# Hi").unwrap();
    call(&s, "render_ui", "c1", json!({ "id": "a", "title": "Agent title", "icon": "file", "source": "notes.md" }));
    s.edit_panel("a", Some("Mine".into()), Some("star".into())).unwrap();
    let meta = s.share_item("a", StateWriter::User).unwrap();
    assert_eq!((meta.title.as_str(), meta.icon.as_deref()), ("Mine", Some("star")));
    assert_eq!(s.shared.artifacts.get(&meta.id).unwrap().icon.as_deref(), Some("star"));
    // The override is spent: the item follows the artifact from now on, and a rename shows.
    let item = s.frontend_item("render_ui", "a").unwrap().unwrap();
    assert_eq!((item.title.as_deref(), item.icon.as_deref()), (None, None));
    // Even a stray override is not carried by an item that shows a Shared Artifact.
    s.log.append(None, EventKind::PanelEdited { tool: "render_ui".into(), id: "a".into(), title: Some("Stale".into()), icon: None }).unwrap();
    let item = s.frontend_item("render_ui", "a").unwrap().unwrap();
    assert_eq!(item.title, None);
    let source = item.input["source"].clone();
    call(&s, "render_ui", "c9", json!({ "id": "a", "source": source }));
    assert_eq!(s.frontend_item("render_ui", "a").unwrap().unwrap().title, None);
}

#[tokio::test]
async fn reset_title_falls_back_to_the_created_title_then_the_first_prompt() {
    let (s, _dir) = session().await;
    let created = s.meta().title;
    s.set_title("Mine").unwrap();
    assert!(s.meta().title_explicit);
    // No Agent title, no prompt: back to the title it was created with.
    s.reset_title().unwrap();
    let m = s.meta();
    assert_eq!((m.title.as_str(), m.title_explicit), (created.as_str(), false));

    // A Session from before `agent_title` existed (none recorded) with a prompt: the prompt's title.
    let main = s.meta().main_thread_id;
    let started = EventKind::TurnStarted { turn_id: "t1".into(), text: "say hello\nmore".into(), attachments: vec![], context: None, origin: None };
    s.log.append(Some(main), started).unwrap();
    s.set_title("Mine").unwrap();
    assert_eq!(s.meta().agent_title, None);
    s.reset_title().unwrap();
    assert_eq!(s.meta().title, "say hello");
}

#[cfg(unix)]
#[tokio::test]
async fn delete_panel_unlinks_a_symlink_and_never_follows_it() {
    use std::os::unix::fs::symlink;
    let (s, dir) = session().await;
    let panels = s.panels_dir();
    std::fs::create_dir_all(&panels).unwrap();
    // A link to another file in panels/: only the link goes.
    std::fs::write(panels.join("b.md"), "b").unwrap();
    symlink(panels.join("b.md"), panels.join("a.md")).unwrap();
    call(&s, "render_ui", "c1", json!({ "id": "a", "source": "a.md" }));
    s.delete_panel("a").unwrap();
    assert!(std::fs::symlink_metadata(panels.join("a.md")).is_err(), "the link is gone");
    assert_eq!(std::fs::read_to_string(panels.join("b.md")).unwrap(), "b", "its target stays");

    // A link to a file outside panels/: the panel deletes (it did not fail forever), the target stays.
    let outside = dir.path().join("outside.md");
    std::fs::write(&outside, "out").unwrap();
    symlink(&outside, panels.join("o.md")).unwrap();
    call(&s, "render_ui", "c2", json!({ "id": "o", "source": "o.md" }));
    s.delete_panel("o").unwrap();
    assert!(s.frontend_item("render_ui", "o").unwrap().is_none());
    assert_eq!(std::fs::read_to_string(&outside).unwrap(), "out");

    // A folder that is a link out of panels/: nothing is removed through it.
    let elsewhere = dir.path().join("elsewhere");
    std::fs::create_dir_all(&elsewhere).unwrap();
    std::fs::write(elsewhere.join("x.md"), "x").unwrap();
    symlink(&elsewhere, panels.join("sub")).unwrap();
    call(&s, "render_ui", "c3", json!({ "id": "x", "source": "sub/x.md" }));
    s.delete_panel("x").unwrap();
    assert!(elsewhere.join("x.md").exists());
}

#[tokio::test]
async fn delete_panel_keeps_a_file_another_live_panel_still_names() {
    let (s, _dir) = session().await;
    std::fs::create_dir_all(s.panels_dir()).unwrap();
    let file = s.panels_dir().join("shared.md");
    std::fs::write(&file, "s").unwrap();
    call(&s, "render_ui", "c1", json!({ "id": "one", "source": "shared.md" }));
    call(&s, "render_ui", "c2", json!({ "id": "two", "source": "shared.md" }));
    s.delete_panel("one").unwrap();
    assert!(file.exists(), "panel two still shows it");
    assert!(s.frontend_item("render_ui", "one").unwrap().is_none());
    s.delete_panel("two").unwrap();
    assert!(!file.exists(), "the last one takes the file with it");
}

#[tokio::test]
async fn a_revived_panel_returns_to_its_place_but_a_removed_one_goes_last() {
    let (s, _dir) = session().await;
    for (i, id) in ["a", "b", "c"].into_iter().enumerate() {
        call(&s, "render_ui", &format!("c{i}"), json!({ "id": id }));
    }
    // Deleted by the user, then called again: its first-seen place, as the Frontend's slots keep it.
    s.delete_panel("a").unwrap();
    call(&s, "render_ui", "c4", json!({ "id": "a", "v": 2 }));
    assert_eq!(keys(&s), vec![key("render_ui", "a"), key("render_ui", "b"), key("render_ui", "c")]);
    // Removed by the Agent (`remove: true`): it comes back last (the Frontend drops it from its slot too).
    call(&s, "render_ui", "c5", json!({ "id": "a", "remove": true }));
    call(&s, "render_ui", "c6", json!({ "id": "a", "v": 3 }));
    assert_eq!(keys(&s), vec![key("render_ui", "b"), key("render_ui", "c"), key("render_ui", "a")]);
}
