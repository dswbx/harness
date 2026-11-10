//! Failures of `Harness::execute` carry the right `ErrorCode`.
#![allow(clippy::unwrap_used, reason = "tests fail loudly")]

mod common;
use common::fake_agent_bin;
use std::sync::Arc;
use std::time::Duration;

use harness_core::Harness;
use harness_core::api::{AgentInfo, Command, CommandResult, ErrorCode, FrontendManifest};

fn harness(data: &std::path::Path, flags: &[&str]) -> Arc<Harness> {
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
    let options =
        harness_core::host::Options { idle_timeout: Duration::from_secs(900), restore_retries: vec![Duration::from_millis(1); 3], ..Default::default() };
    let h = Harness::with_options(data.to_owned(), vec![agent], options).unwrap();
    h.register_frontend(FrontendManifest { id: "inspector".into(), name: "I".into(), version: "0".into(), instructions: None, frontend_tools: vec![] });
    h
}

fn create(folder: &std::path::Path, agent_id: &str) -> Command {
    Command::CreateSession {
        folder: folder.display().to_string(),
        agent_id: agent_id.into(),
        frontend_id: "inspector".into(),
        title: None,
        branch: None,
        worktree: false,
        new_branch: None,
        pr: None,
        mcp_servers: vec![],
    }
}

async fn session(h: &Harness, folder: &std::path::Path) -> String {
    let CommandResult::SessionCreated { session_id } = h.execute(create(folder, "fake")).await.unwrap() else { panic!() };
    session_id
}

fn prompt(session_id: &str, thread_id: Option<&str>) -> Command {
    Command::Prompt { session_id: session_id.into(), thread_id: thread_id.map(Into::into), text: "hi".into(), attachments: vec![] }
}

#[tokio::test]
async fn unknown_ids_are_not_found() {
    let dir = tempfile::tempdir().unwrap();
    let h = harness(&dir.path().join("data"), &[]);
    let e = h.execute(prompt("nope", None)).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::NotFound, "{e}");
    let e = h.execute(create(dir.path(), "nope")).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::NotFound, "{e}");

    let sid = session(&h, dir.path()).await;
    let e = h.execute(prompt(&sid, Some("no-such-thread"))).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::NotFound, "{e}");
}

#[tokio::test]
async fn state_conflicts() {
    let dir = tempfile::tempdir().unwrap();
    let h = harness(&dir.path().join("data"), &[]);
    let sid = session(&h, dir.path()).await;
    h.execute(Command::ArchiveSession { session_id: sid.clone() }).await.unwrap();
    let e = h.execute(Command::ArchiveSession { session_id: sid.clone() }).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict, "{e}");
    let e = h.execute(prompt(&sid, None)).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict, "{e}");
}

#[tokio::test]
async fn sign_in_needed_is_auth_required() {
    let dir = tempfile::tempdir().unwrap();
    let h = harness(&dir.path().join("data"), &["--auth"]);
    let sid = session(&h, dir.path()).await;
    let e = h.execute(prompt(&sid, None)).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::AuthRequired, "{e}");
}

#[tokio::test]
async fn other_failures_are_internal() {
    let dir = tempfile::tempdir().unwrap();
    let h = harness(&dir.path().join("data"), &[]);
    let sid = session(&h, dir.path()).await;
    // Not a git repository: a plain failure.
    let e = h.execute(Command::GitStatus { session_id: sid }).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::Internal, "{e}");
}

#[test]
fn the_wire_shape_is_code_and_message() {
    let e = harness_core::api::HarnessError { code: ErrorCode::AuthRequired, message: "sign in".into() };
    assert_eq!(serde_json::to_value(&e).unwrap(), serde_json::json!({ "code": "auth_required", "message": "sign in" }));
}
