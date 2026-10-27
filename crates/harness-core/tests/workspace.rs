//! Workspaces and git Primitives against temp repositories and the scripted `fake-agent`.

use std::path::{Path, PathBuf};
use std::process::Command as Proc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use harness_core::api::{AgentInfo, Command, CommandResult, Event, EventKind, FrontendManifest, SessionSummary};
use harness_core::Harness;

fn fake_agent_bin() -> PathBuf {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let status = Proc::new(env!("CARGO")).args(["build", "-q", "-p", "fake-agent"]).current_dir(&root).status().unwrap();
    assert!(status.success());
    root.join("target/debug/fake-agent").canonicalize().unwrap()
}

fn harness(data: &Path) -> Arc<Harness> {
    let args = vec!["--resume".to_owned()];
    let agent = AgentInfo {
        id: "fake".into(),
        name: "Fake".into(),
        command: fake_agent_bin().display().to_string(),
        args,
        env: Default::default(),
        source: Default::default(),
        version: None,
        icon: None,
    };
    let h = Harness::with_agents(data.to_owned(), vec![agent]).unwrap();
    h.register_frontend(FrontendManifest { id: "chat".into(), name: "C".into(), version: "0".into(), frontend_tools: vec![] });
    h
}

fn sh(dir: &Path, args: &[&str]) -> String {
    let out = Proc::new("git").args(args).current_dir(dir).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

/// A repo on `main` with one commit, plus the Harness data dir.
fn repo() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path().join("proj");
    std::fs::create_dir_all(&repo).unwrap();
    sh(&repo, &["init", "-q", "-b", "main"]);
    sh(&repo, &["config", "user.email", "t@example.com"]);
    sh(&repo, &["config", "user.name", "T"]);
    std::fs::write(repo.join("README.md"), "hi\n").unwrap();
    sh(&repo, &["add", "."]);
    sh(&repo, &["commit", "-q", "-m", "init"]);
    let data = dir.path().join("data");
    (dir, repo.canonicalize().unwrap(), data)
}

async fn create(h: &Harness, folder: &Path, branch: Option<&str>, worktree: bool) -> Result<String, String> {
    match h
        .execute(Command::CreateSession {
            folder: folder.display().to_string(),
            agent_id: "fake".into(),
            frontend_id: "chat".into(),
            title: Some("Fix the parser!".into()),
            branch: branch.map(Into::into),
            worktree,
            mcp_servers: vec![],
        })
        .await?
    {
        CommandResult::SessionCreated { session_id } => Ok(session_id),
        r => panic!("{r:?}"),
    }
}

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

async fn turn(h: &Harness, sid: &str, text: &str) {
    let before = events(h, sid).len();
    h.execute(Command::Prompt { session_id: sid.into(), thread_id: None, text: text.into() }).await.unwrap();
    for _ in 0..400 {
        if events(h, sid)[before..].iter().any(|e| matches!(e.kind, EventKind::TurnEnded { .. })) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("turn did not end");
}

async fn summary(h: &Harness, sid: &str) -> Option<SessionSummary> {
    let CommandResult::Sessions { sessions } = h.execute(Command::ListSessions).await.unwrap() else { panic!() };
    sessions.into_iter().find(|s| s.id == sid)
}

#[tokio::test(flavor = "multi_thread")]
async fn worktree_session_lifecycle() {
    let (_dir, repo, data) = repo();
    let h = harness(&data);
    let CommandResult::Branches { branches } =
        h.execute(Command::ListBranches { folder: repo.display().to_string() }).await.unwrap()
    else { panic!() };
    assert_eq!((branches.current.as_deref(), branches.branches.clone()), (Some("main"), vec!["main".to_owned()]));

    let sid = create(&h, &repo, None, true).await.unwrap();
    let s = summary(&h, &sid).await.unwrap();
    let branch = s.workspace.worktree_branch.clone().unwrap();
    assert!(branch.starts_with("harness/fix-the-parser-"), "{branch}");
    assert_eq!(s.workspace.base_branch.as_deref(), Some("main"));
    let wt = PathBuf::from(&s.folder);
    assert!(wt.starts_with(data.canonicalize().unwrap_or(data.clone())) || wt.starts_with(&data));
    assert_eq!(sh(&wt, &["branch", "--show-current"]), branch);

    // A Turn that edits a file reports it.
    turn(&h, &sid, "write something").await;
    let changed = events(&h, &sid).into_iter().find_map(|e| match e.kind {
        EventKind::WorkspaceChanged { files, .. } => Some(files),
        _ => None,
    });
    let changed = changed.expect("WorkspaceChanged");
    assert_eq!((changed[0].path.as_str(), changed[0].status.as_str(), changed[0].additions), ("fake.txt", "A", Some(1)));
    assert!(!repo.join("fake.txt").exists(), "the user's checkout is untouched");

    let CommandResult::GitStatus { status } = h.execute(Command::GitStatus { session_id: sid.clone() }).await.unwrap() else { panic!() };
    assert_eq!(status.files.iter().map(|f| (f.path.as_str(), f.status.as_str())).collect::<Vec<_>>(), vec![("fake.txt", "?")]);
    let CommandResult::Diff { diff } = h.execute(Command::GitDiff { session_id: sid.clone(), from: None, to: None }).await.unwrap() else { panic!() };
    assert!(diff.patch.contains("+hello"), "{}", diff.patch);
    assert_eq!(sh(&wt, &["status", "--porcelain"]), "?? fake.txt", "diffing leaves the index alone");

    let delete = |force| Command::DeleteSession { session_id: sid.clone(), force };
    let err = h.execute(delete(false)).await.unwrap_err();
    assert!(err.contains("uncommitted"), "{err}");

    // Archive: WIP commit, Worktree removed, branch kept.
    h.execute(Command::ArchiveSession { session_id: sid.clone() }).await.unwrap();
    assert!(!wt.exists());
    assert!(summary(&h, &sid).await.unwrap().archived);
    assert_eq!(sh(&repo, &["log", "-1", "--format=%s", &branch]), "WIP (archived by Harness)");
    assert!(h.execute(Command::Prompt { session_id: sid.clone(), thread_id: None, text: "hi".into() }).await.is_err());
    let err = h.execute(delete(false)).await.unwrap_err();
    assert!(err.contains("1 commit(s) not on main"), "{err}");

    // Unarchive restores the Worktree; commit from the Harness.
    h.execute(Command::UnarchiveSession { session_id: sid.clone() }).await.unwrap();
    assert_eq!(std::fs::read_to_string(wt.join("fake.txt")).unwrap(), "hello\n");
    turn(&h, &sid, "write more").await;
    let CommandResult::Committed { commit } =
        h.execute(Command::GitCommit { session_id: sid.clone(), message: "Add fake".into() }).await.unwrap()
    else { panic!() };
    assert_eq!(sh(&wt, &["rev-parse", "HEAD"]), commit);
    assert!(events(&h, &sid).iter().any(|e| matches!(&e.kind, EventKind::GitCommitted { message, .. } if message == "Add fake")));

    h.execute(delete(true)).await.unwrap();
    assert!(!wt.exists());
    assert_eq!(sh(&repo, &["branch", "--list", &branch]), "");
    assert!(summary(&h, &sid).await.is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn plain_folder_checks_out_the_branch_unless_dirty() {
    let (_dir, repo, data) = repo();
    let h = harness(&data);
    sh(&repo, &["branch", "feature"]);
    let sid = create(&h, &repo, Some("feature"), false).await.unwrap();
    assert_eq!(sh(&repo, &["branch", "--show-current"]), "feature");
    assert_eq!(summary(&h, &sid).await.unwrap().workspace.worktree_branch, None);

    std::fs::write(repo.join("README.md"), "changed\n").unwrap();
    let err = create(&h, &repo, Some("main"), false).await.unwrap_err();
    assert!(err.contains("uncommitted changes"), "{err}");
    assert_eq!(sh(&repo, &["branch", "--show-current"]), "feature");
}

#[tokio::test(flavor = "multi_thread")]
async fn worktree_from_a_chosen_base_and_push_to_origin() {
    let (dir, repo, data) = repo();
    let remote = dir.path().join("remote.git");
    sh(dir.path(), &["init", "-q", "--bare", remote.to_str().unwrap()]);
    sh(&repo, &["remote", "add", "origin", remote.to_str().unwrap()]);
    sh(&repo, &["checkout", "-q", "-b", "develop"]);
    std::fs::write(repo.join("dev.txt"), "d\n").unwrap();
    sh(&repo, &["add", "."]);
    sh(&repo, &["commit", "-q", "-m", "dev"]);
    sh(&repo, &["checkout", "-q", "main"]);

    let h = harness(&data);
    let sid = create(&h, &repo, Some("develop"), true).await.unwrap();
    let s = summary(&h, &sid).await.unwrap();
    assert_eq!(s.workspace.base_branch.as_deref(), Some("develop"));
    assert!(Path::new(&s.folder).join("dev.txt").exists());

    turn(&h, &sid, "write").await;
    h.execute(Command::GitCommit { session_id: sid.clone(), message: "x".into() }).await.unwrap();
    h.execute(Command::GitPush { session_id: sid.clone() }).await.unwrap();
    let branch = s.workspace.worktree_branch.unwrap();
    assert_eq!(sh(&remote, &["branch", "--list", &branch]).trim_start_matches("* "), branch);
    let CommandResult::GitStatus { status } = h.execute(Command::GitStatus { session_id: sid.clone() }).await.unwrap() else { panic!() };
    assert_eq!((status.ahead, status.upstream.as_deref()), (0, Some(format!("origin/{branch}").as_str())));
}

#[tokio::test(flavor = "multi_thread")]
async fn non_repo_folder_works_without_git() {
    let dir = tempfile::tempdir().unwrap();
    let h = harness(&dir.path().join("data"));
    let plain = dir.path().join("plain");
    std::fs::create_dir_all(&plain).unwrap();
    assert!(create(&h, &plain, None, true).await.unwrap_err().contains("not in a git repository"));
    let sid = create(&h, &plain, None, false).await.unwrap();
    turn(&h, &sid, "write").await;
    assert!(!events(&h, &sid).iter().any(|e| matches!(e.kind, EventKind::WorkspaceChanged { .. })));
    assert!(h.execute(Command::GitStatus { session_id: sid.clone() }).await.is_err());
    h.execute(Command::ArchiveSession { session_id: sid.clone() }).await.unwrap();
    h.execute(Command::DeleteSession { session_id: sid.clone(), force: false }).await.unwrap();
}
