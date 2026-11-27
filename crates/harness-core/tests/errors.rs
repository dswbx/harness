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
        task: None,
    }
}

async fn session(h: &Harness, folder: &std::path::Path) -> String {
    let CommandResult::SessionCreated { session_id } = h.execute(create(folder, "fake")).await.unwrap() else { panic!() };
    session_id
}

fn prompt(session_id: &str, thread_id: Option<&str>) -> Command {
    Command::Prompt { session_id: session_id.into(), thread_id: thread_id.map(Into::into), text: "hi".into(), attachments: vec![], comment_ids: vec![] }
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
    // An unreadable image: a plain failure (no code the caller could act on).
    let e = h.execute(Command::ReadImageFile { path: dir.path().join("nope.png").display().to_string() }).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::Internal, "{e}");
}

/// A git repository on `main` with one commit and a `README.md`.
fn git_repo(dir: &std::path::Path) -> std::path::PathBuf {
    let repo = dir.join("proj");
    std::fs::create_dir_all(&repo).unwrap();
    let git = |args: &[&str]| {
        let out = std::process::Command::new("git").args(args).current_dir(&repo).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    };
    git(&["init", "-q", "-b", "main"]);
    git(&["config", "user.email", "t@example.com"]);
    git(&["config", "user.name", "T"]);
    git(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.join("README.md"), "hi\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "-q", "-m", "init"]);
    repo.canonicalize().unwrap()
}

fn mcp_server(name: &str) -> harness_core::api::McpServerDef {
    harness_core::api::McpServerDef {
        id: String::new(),
        name: name.into(),
        transport: harness_core::api::McpTransport::Stdio { command: "x".into(), args: vec![], env: Default::default() },
        secret_keys: vec![],
    }
}

fn code(r: Result<CommandResult, harness_core::api::HarnessError>) -> ErrorCode {
    r.unwrap_err().code
}

#[tokio::test]
async fn unknown_agents_servers_frontends_and_folders_are_not_found() {
    let dir = tempfile::tempdir().unwrap();
    let h = harness(&dir.path().join("data"), &[]);
    assert_eq!(code(h.execute(Command::RollbackAgent { agent_id: "nope".into() }).await), ErrorCode::NotFound);
    assert_eq!(code(h.execute(Command::RemoveAgent { agent_id: "nope".into() }).await), ErrorCode::NotFound);
    assert_eq!(code(h.execute(Command::HoldAgentVersion { agent_id: "nope".into(), hold: true }).await), ErrorCode::NotFound);
    assert_eq!(code(h.execute(Command::RemoveMcpServer { server_id: "nope".into() }).await), ErrorCode::NotFound);
    let mut c = create(dir.path(), "fake");
    if let Command::CreateSession { frontend_id, .. } = &mut c {
        *frontend_id = "nope".into();
    }
    assert_eq!(code(h.execute(c).await), ErrorCode::NotFound);
    assert_eq!(code(h.execute(create(&dir.path().join("missing"), "fake")).await), ErrorCode::NotFound);
    let sid = session(&h, dir.path()).await;
    let e = h.execute(Command::ReadAttachment { session_id: sid.clone(), path: "../elsewhere.png".into() }).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::NotFound, "{e}");
    let e = h.execute(Command::PanelSourceRead { session_id: sid, name: "none.md".into() }).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::NotFound, "{e}");
}

#[tokio::test]
async fn input_the_command_cannot_use_is_invalid() {
    let dir = tempfile::tempdir().unwrap();
    let h = harness(&dir.path().join("data"), &[]);
    let sid = session(&h, dir.path()).await;
    // Not a git repository, where the Command needs one.
    assert_eq!(code(h.execute(Command::GitStatus { session_id: sid.clone() }).await), ErrorCode::Invalid);
    let mut c = create(dir.path(), "fake");
    if let Command::CreateSession { worktree, .. } = &mut c {
        *worktree = true;
    }
    assert_eq!(code(h.execute(c).await), ErrorCode::Invalid);
    assert_eq!(code(h.execute(Command::SaveMcpServer { server: mcp_server("  "), secrets: Default::default() }).await), ErrorCode::Invalid);
    assert_eq!(code(h.execute(Command::PatchState { session_id: sid, ops: vec![] }).await), ErrorCode::Invalid);
}

#[tokio::test]
async fn an_empty_commit_message_is_invalid() {
    let dir = tempfile::tempdir().unwrap();
    let repo = git_repo(dir.path());
    let h = harness(&dir.path().join("data"), &[]);
    let sid = session(&h, &repo).await;
    std::fs::write(repo.join("README.md"), "changed\n").unwrap();
    let e = h.execute(Command::GitCommit { session_id: sid, message: String::new() }).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::Invalid, "{e}");
    assert!(e.message.starts_with("git commit"), "the message stays git's: {e}");
}

#[tokio::test]
async fn state_in_the_way_is_a_conflict() {
    let dir = tempfile::tempdir().unwrap();
    let repo = git_repo(dir.path());
    let h = harness(&dir.path().join("data"), &[]);
    let add = |id: &str| Command::AddCustomAgent { name: id.into(), command: "x".into(), args: vec![], env: Default::default() };
    h.execute(add("twin")).await.unwrap();
    assert_eq!(code(h.execute(add("twin")).await), ErrorCode::Conflict);
    // A branch that exists.
    let mut c = create(&repo, "fake");
    if let Command::CreateSession { new_branch, .. } = &mut c {
        *new_branch = Some("main".into());
    }
    let e = h.execute(c).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict, "{e}");
    // Uncommitted changes in the way of a checkout.
    assert!(std::process::Command::new("git").args(["branch", "other"]).current_dir(&repo).status().unwrap().success());
    std::fs::write(repo.join("README.md"), "changed\n").unwrap();
    let mut c = create(&repo, "fake");
    if let Command::CreateSession { branch, .. } = &mut c {
        *branch = Some("other".into());
    }
    let e = h.execute(c).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict, "{e}");
}

#[test]
fn the_wire_shape_is_code_and_message() {
    let e = harness_core::api::HarnessError { code: ErrorCode::AuthRequired, message: "sign in".into(), path: None };
    assert_eq!(serde_json::to_value(&e).unwrap(), serde_json::json!({ "code": "auth_required", "message": "sign in" }));
    let e = harness_core::api::HarnessError { code: ErrorCode::NeedsApproval, message: "a hidden file".into(), path: Some("~/.a".into()) };
    let v = serde_json::json!({ "code": "needs_approval", "message": "a hidden file", "path": "~/.a" });
    assert_eq!(serde_json::to_value(&e).unwrap(), v);
    // The shape older builds sent (no `path`) still reads.
    let old: harness_core::api::HarnessError = serde_json::from_value(serde_json::json!({ "code": "invalid", "message": "m" })).unwrap();
    assert_eq!(old.path, None);
}
