//! Harness MCP end to end: the scripted `fake-agent` is the MCP client (HTTP and stdio shim).
#![allow(clippy::unwrap_used, reason = "tests fail loudly")]

mod common;
use common::fake_agent_bin;
use std::path::{Path, PathBuf};
use std::process::Command as Proc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use harness_core::Harness;
use harness_core::api::{
    AgentInfo, AppEvent, Command, CommandResult, Decision, Event, EventKind, FrontendAnswer, FrontendImage, FrontendManifest, FrontendToolDecl,
    InstructionsScope, McpServerDef, McpTransport, NewPermissionRule, Resolver, RuleScope, StatePatchOp, StateWriter,
};
use harness_core::host::Options;

fn harness(data: &Path, flags: &[&str]) -> Arc<Harness> {
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
    let options = Options {
        secrets: Box::new(harness_core::library::MemorySecrets::default()),
        mcp_shim: Some((env!("CARGO_BIN_EXE_harness-mcp-shim").to_owned(), vec![])),
        ..Default::default()
    };
    // A second Agent, for Sub Sessions on another Agent.
    let other = AgentInfo { id: "other".into(), name: "Other".into(), ..agent.clone() };
    let h = Harness::with_options(data.to_owned(), vec![agent, other], options).unwrap();
    h.register_frontend(FrontendManifest {
        id: "chat".into(),
        name: "Chat".into(),
        version: "0".into(),
        instructions: Some("Use json_render for results.".into()),
        frontend_tools: vec![FrontendToolDecl {
            name: "json_render".into(),
            description: "Render a card".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "title": { "type": "string" },
                    "items": { "type": "array", "items": { "type": "string" } },
                    "image": { "type": "string", "format": "harness-image" },
                    "id": { "type": "string" },
                    "placement": { "type": "string" },
                    "remove": { "type": "boolean" }
                },
                "required": ["title"],
                "additionalProperties": false
            }),
            replies: false,
        }],
    });
    h
}

fn git(dir: &Path, args: &[&str]) {
    let out = Proc::new("git").args(args).current_dir(dir).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

fn repo(dir: &Path) -> PathBuf {
    let repo = dir.join("proj");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["config", "user.email", "t@example.com"]);
    git(&repo, &["config", "user.name", "T"]);
    std::fs::write(repo.join("a.txt"), "a\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-q", "-m", "init"]);
    repo
}

async fn create(h: &Harness, folder: &Path, mcp_servers: Vec<String>) -> String {
    let cmd = Command::CreateSession {
        folder: folder.display().to_string(),
        agent_id: "fake".into(),
        frontend_id: "chat".into(),
        title: None,
        branch: None,
        worktree: false,
        new_branch: None,
        pr: None,
        mcp_servers,
        task: None,
    };
    match h.execute(cmd).await {
        Ok(CommandResult::SessionCreated { session_id }) => session_id,
        r => panic!("{r:?}"),
    }
}

fn events(h: &Harness, sid: &str) -> Vec<Event> {
    h.session_events(sid).unwrap()
}

/// Sends `text`, answering permission prompts with `answer`, and returns the Agent's reply.
async fn ask(h: &Harness, sid: &str, text: &str, answer: Option<&str>) -> String {
    let before = events(h, sid).len();
    h.execute(Command::Prompt { session_id: sid.into(), thread_id: None, text: text.into(), attachments: vec![], comment_ids: vec![] }).await.unwrap();
    let mut answered = std::collections::HashSet::new();
    for _ in 0..800 {
        let evs = events(h, sid);
        for e in &evs[before..] {
            if let EventKind::PermissionRequested { request_id, .. } = &e.kind
                && let Some(a) = answer
                && answered.insert(request_id.clone())
            {
                let _ = h
                    .execute(Command::ResolvePermission { session_id: sid.into(), request_id: request_id.clone(), option_id: Some(a.into()), global: false })
                    .await;
            }
        }
        if own_turn_ended(&evs[before..], text, None) {
            return evs[before..]
                .iter()
                .filter_map(|e| match &e.kind {
                    EventKind::AgentMessageChunk { text, .. } => Some(text.as_str()),
                    _ => None,
                })
                .collect();
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("turn did not end");
}

/// The Turn started by the user prompt `text` (in `thread`, when given) has ended. Another Turn of the
/// Thread may run beside it (a notice Turn, say), so its `TurnEnded` does not count. Chunks carry no
/// turn id: callers find their text in the joined reply, not at its start.
fn own_turn_ended(evs: &[Event], text: &str, thread: Option<&str>) -> bool {
    let id = evs.iter().find_map(|e| match &e.kind {
        EventKind::TurnStarted { turn_id, text: t, origin: None, .. } if t == text && thread.is_none_or(|th| e.thread_id.as_deref() == Some(th)) => {
            Some(turn_id)
        }
        _ => None,
    });
    id.is_some_and(|id| evs.iter().any(|e| matches!(&e.kind, EventKind::TurnEnded { turn_id, .. } if turn_id == id)))
}

#[tokio::test(flavor = "multi_thread")]
async fn primitives_over_http() {
    let dir = tempfile::tempdir().unwrap();
    let repo = repo(dir.path());
    let h = harness(&dir.path().join("data"), &[]);
    let sid = create(&h, &repo, vec![]).await;
    // The fake Agent starts in its auto mode; push asks in the asking mode.
    set_mode(&h, &sid, "default").await;

    let tools = ask(&h, &sid, "mcp-list", None).await;
    assert_eq!(
        tools,
        "tools: git_status,git_diff,list_branches,git_commit,git_push,pr_create,state_get,state_patch,harness_info,set_title,ui_get,artifact_search,artifact_share,artifact_attach,artifact_detach,task_add,task_update,task_list,task_get,comment_list,comment_add,comment_resolve,threads_list,transcript_outline,transcript_read,transcript_search,session_start,session_send,session_wait,session_list,json_render"
    );

    std::fs::write(repo.join("b.txt"), "b\n").unwrap();
    let status = ask(&h, &sid, "mcp git_status {}", None).await;
    assert!(status.starts_with("mcp: {") && status.contains("b.txt"), "{status}");
    let diff = ask(&h, &sid, "mcp git_diff {}", None).await;
    assert!(diff.contains("+b"), "{diff}");

    // Commit is allowed by default; push asks, and a denial reaches the Agent.
    let commit = ask(&h, &sid, r#"mcp git_commit {"message":"Add b"}"#, None).await;
    assert!(commit.starts_with("mcp: Committed "), "{commit}");
    let push = ask(&h, &sid, "mcp git_push {}", Some("reject")).await;
    assert_eq!(push, "mcp error: the user denied this");
    let asked = events(&h, &sid).into_iter().any(|e| matches!(&e.kind, EventKind::PermissionRequested { tool_call, .. } if tool_call["kind"] == "git_push"));
    assert!(asked);
}

/// Guards the catalog/dispatch pairing in `mcp.rs`: every tool the server lists must be handled.
/// Each is called with no arguments and must answer with a result or a normal tool error: not
/// "unknown tool" (listed but not dispatched), not a dropped connection or a panic.
#[tokio::test(flavor = "multi_thread")]
async fn every_listed_tool_is_dispatched_and_answers_without_panicking() {
    let dir = tempfile::tempdir().unwrap();
    let repo = repo(dir.path());
    let h = harness(&dir.path().join("data"), &[]);
    let sid = create(&h, &repo, vec![]).await;

    let listed = ask(&h, &sid, "mcp-list", None).await;
    let tools: Vec<&str> = listed.strip_prefix("tools: ").unwrap().split(',').collect();
    assert!(tools.len() > 20 && tools.contains(&"git_status") && tools.contains(&"json_render"), "{listed}");

    let mut answers = Vec::new();
    for tool in &tools {
        // A request for permission (git_push) is answered with a denial: still a normal error.
        let reply = ask(&h, &sid, &format!("mcp {tool} {{}}"), Some("reject")).await;
        assert!(reply.starts_with("mcp: ") || reply.starts_with("mcp error: "), "{tool}: {reply}");
        assert!(!reply.contains("unknown tool"), "{tool} is listed but not dispatched: {reply}");
        let lower = reply.to_lowercase();
        assert!(!lower.contains("panicked") && !lower.contains("transport closed") && !lower.contains("connection closed"), "{tool}: {reply}");
        answers.push((tool, reply));
    }
    // The tools that need arguments say so; the ones that do not, work.
    let reply = |name: &str| answers.iter().find(|(t, _)| **t == name).unwrap().1.clone();
    assert!(reply("git_status").starts_with("mcp: "), "{}", reply("git_status"));
    assert!(reply("session_list").starts_with("mcp: "), "{}", reply("session_list"));
    assert!(reply("git_commit").starts_with("mcp error: "), "{}", reply("git_commit"));
    assert!(reply("json_render").starts_with("mcp error: "), "{}", reply("json_render"));
}

#[tokio::test(flavor = "multi_thread")]
async fn git_diff_refuses_option_like_revisions() {
    let dir = tempfile::tempdir().unwrap();
    let repo = repo(dir.path());
    let h = harness(&dir.path().join("data"), &[]);
    let sid = create(&h, &repo, vec![]).await;
    let out = dir.path().join("out.txt");
    let call = format!(r#"mcp git_diff {{"from":"--output={}","to":"HEAD"}}"#, out.display());
    let reply = ask(&h, &sid, &call, None).await;
    assert!(reply.starts_with("mcp error:"), "{reply}");
    assert!(!out.exists(), "git wrote the file");
    let call = format!(r#"mcp git_diff {{"from":"HEAD","to":"--output={}"}}"#, out.display());
    let reply = ask(&h, &sid, &call, None).await;
    assert!(reply.starts_with("mcp error:"), "{reply}");
    assert!(!out.exists(), "git wrote the file");
    // Normal revisions still work.
    std::fs::write(repo.join("b.txt"), "b\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-q", "-m", "b"]);
    let reply = ask(&h, &sid, r#"mcp git_diff {"from":"HEAD~1","to":"HEAD"}"#, None).await;
    assert!(reply.contains("+b"), "{reply}");
}

fn pushed_asks(h: &Harness, sid: &str) -> bool {
    events(h, sid).into_iter().any(|e| matches!(&e.kind, EventKind::PermissionRequested { tool_call, .. } if tool_call["kind"] == "git_push"))
}

/// The (resolver, rule id, option) of every resolved git_push request.
fn push_resolutions(h: &Harness, sid: &str) -> Vec<(Resolver, Option<String>, Option<String>)> {
    let log = events(h, sid);
    let ids: Vec<String> = log
        .iter()
        .filter_map(|e| match &e.kind {
            EventKind::PermissionRequested { request_id, tool_call, .. } if tool_call["kind"] == "git_push" => Some(request_id.clone()),
            _ => None,
        })
        .collect();
    log.into_iter()
        .filter_map(|e| match e.kind {
            EventKind::PermissionResolved { request_id, option_id, by, rule_id } if ids.contains(&request_id) => Some((by, rule_id, option_id)),
            _ => None,
        })
        .collect()
}

async fn set_mode(h: &Harness, sid: &str, value: &str) {
    h.execute(Command::SetConfigOption { session_id: sid.into(), thread_id: None, config_id: "mode".into(), value: value.into() }).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn push_does_not_ask_in_an_auto_mode() {
    let dir = tempfile::tempdir().unwrap();
    let repo = repo(dir.path());
    let h = harness(&dir.path().join("data"), &[]);
    let sid = create(&h, &repo, vec![]).await;
    // Start the Agent, then switch to its auto mode.
    ask(&h, &sid, "mcp-list", None).await;
    set_mode(&h, &sid, "auto").await;

    let push = ask(&h, &sid, "mcp git_push {}", None).await;
    assert!(!push.contains("denied") && !push.contains("cancelled"), "{push}");
    assert_eq!(push_resolutions(&h, &sid), vec![(Resolver::Policy, None, Some("allow".into()))], "auto mode passes, logged as Policy");

    // Back in the asking mode it asks again.
    set_mode(&h, &sid, "default").await;
    let push = ask(&h, &sid, "mcp git_push {}", Some("reject")).await;
    assert_eq!(push, "mcp error: the user denied this");
    assert!(pushed_asks(&h, &sid));
    let last = push_resolutions(&h, &sid).pop().unwrap();
    assert_eq!(last, (Resolver::View, None, Some("reject".into())));
}

#[tokio::test(flavor = "multi_thread")]
async fn explicit_allow_rule_passes_and_is_logged() {
    let dir = tempfile::tempdir().unwrap();
    let repo = repo(dir.path());
    let h = harness(&dir.path().join("data"), &[]);
    let sid = create(&h, &repo, vec![]).await;
    let CommandResult::PermissionRuleAdded { rule } = h
        .execute(Command::AddPermissionRule {
            rule: NewPermissionRule { scope: RuleScope::Global, tool_kind: Some("git_push".into()), pattern: None, decision: Decision::Allow },
        })
        .await
        .unwrap()
    else {
        panic!()
    };
    let push = ask(&h, &sid, "mcp git_push {}", None).await;
    assert!(!push.contains("denied") && !push.contains("cancelled"), "{push}");
    assert_eq!(push_resolutions(&h, &sid), vec![(Resolver::Policy, Some(rule.id), Some("allow".into()))]);
}

#[tokio::test(flavor = "multi_thread")]
async fn frontend_tool_is_validated_and_stored() {
    let dir = tempfile::tempdir().unwrap();
    let h = harness(&dir.path().join("data"), &[]);
    let sid = create(&h, dir.path(), vec![]).await;

    let bad = ask(&h, &sid, r#"mcp json_render {"items":[1]}"#, None).await;
    assert!(bad.starts_with("mcp error: invalid input for json_render"), "{bad}");
    assert!(bad.contains("title"), "names the missing property: {bad}");
    assert!(bad.contains("How to call json_render:\nRender a card"), "teaches the input format: {bad}");

    let missing = ask(&h, &sid, r#"mcp json_render {"title":"Hi","image":"nope.png"}"#, None).await;
    assert!(missing.starts_with("mcp error: nope.png"), "{missing}");

    std::fs::write(dir.path().join("shot.png"), b"png").unwrap();
    let ok = ask(&h, &sid, r#"mcp json_render {"title":"Hi","items":["x"],"image":"shot.png"}"#, None).await;
    assert!(ok.starts_with("mcp: Done."), "{ok}");
    let (path, input, files) = events(&h, &sid)
        .into_iter()
        .find_map(|e| match e.kind {
            EventKind::FrontendToolOutput { path, input, files, .. } => Some((path, input, files)),
            _ => None,
        })
        .expect("FrontendToolOutput");
    assert_eq!(input["title"], "Hi");
    assert_eq!(input["image"], "shot.png", "the input stays as the Agent sent it");
    assert!(path.starts_with("tools/json_render/") && path.ends_with(".json"));
    let copy = files.get("shot.png").expect("copied image").clone();
    let CommandResult::Attachment { mime, data } = h.execute(Command::FrontendReadImage { session_id: sid.clone(), path: copy.clone() }).await.unwrap() else {
        panic!()
    };
    assert_eq!((mime.as_str(), data.as_str()), ("image/png", "cG5n"));
    assert!(h.execute(Command::FrontendReadImage { session_id: sid.clone(), path: path.clone() }).await.is_err(), "not an image");

    let CommandResult::FileContent { content } = h.execute(Command::FrontendRead { session_id: sid.clone(), path: path.clone() }).await.unwrap() else {
        panic!()
    };
    assert_eq!(serde_json::from_str::<serde_json::Value>(&content).unwrap()["title"], "Hi");
    let CommandResult::Files { files } = h.execute(Command::FrontendList { session_id: sid.clone(), dir: String::new() }).await.unwrap() else { panic!() };
    assert_eq!(files, vec![copy, path]);
    h.execute(Command::FrontendWrite { session_id: sid.clone(), path: "state/view.json".into(), content: "{}".into() }).await.unwrap();
    assert!(h.execute(Command::FrontendRead { session_id: sid.clone(), path: "../session.json".into() }).await.is_err());
    assert!(h.execute(Command::FrontendWrite { session_id: sid.clone(), path: "/tmp/x".into(), content: "".into() }).await.is_err());
}

/// Registers a Frontend Tool that `replies`, and answers each `FrontendRequest` with all of `answers`
/// in order (several windows). Returns the requests seen and the newest log `seq` at each of them.
fn answer_requests(h: &Arc<Harness>, answers: Vec<FrontendAnswer>) -> Arc<Mutex<Vec<(AppEvent, u64)>>> {
    h.register_frontend(FrontendManifest {
        id: "chat".into(),
        name: "Chat".into(),
        version: "0".into(),
        instructions: None,
        frontend_tools: vec![FrontendToolDecl {
            name: "snapshot".into(),
            description: "Render to an image".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": { "id": { "type": "string" } },
                "required": ["id"],
                "additionalProperties": false
            }),
            replies: true,
        }],
    });
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    h.subscribe_app(Box::new(move |e: &AppEvent| {
        if matches!(e, AppEvent::FrontendRequest { .. }) {
            let _ = tx.send(e.clone());
        }
        true
    }));
    let seen = Arc::new(Mutex::new(Vec::new()));
    let (h, log) = (h.clone(), seen.clone());
    tokio::spawn(async move {
        while let Some(e) = rx.recv().await {
            let AppEvent::FrontendRequest { session_id, request_id, .. } = &e else { unreachable!() };
            let newest = events(&h, session_id).last().unwrap().seq;
            for answer in &answers {
                let cmd = Command::AnswerFrontendRequest { session_id: session_id.clone(), request_id: request_id.clone(), answer: answer.clone() };
                assert!(matches!(h.execute(cmd).await, Ok(CommandResult::Ok)));
            }
            log.lock().unwrap().push((e, newest));
        }
    });
    seen
}

#[tokio::test(flavor = "multi_thread")]
async fn frontend_answer_returns_to_the_agent_without_a_log_entry() {
    let dir = tempfile::tempdir().unwrap();
    let h = harness(&dir.path().join("data"), &[]);
    let sid = create(&h, dir.path(), vec![]).await;
    let image = FrontendImage { mime: "image/png".into(), data: "cG5n".into() };
    let first = FrontendAnswer { text: Some("Rendered.".into()), image: Some(image), error: None };
    let second = FrontendAnswer { text: Some("Too late.".into()), ..Default::default() };
    let seen = answer_requests(&h, vec![first, second]);

    let bad = ask(&h, &sid, "mcp snapshot {}", None).await;
    assert!(bad.starts_with("mcp error: invalid input for snapshot") && bad.contains("How to call snapshot:\nRender to an image"), "{bad}");
    assert!(seen.lock().unwrap().is_empty(), "invalid input asks no window");

    let reply = ask(&h, &sid, r#"mcp snapshot {"id":"chart"}"#, None).await;
    assert_eq!(reply, "mcp: Rendered.\nimage image/png cG5n", "text, then the image; the second answer is ignored");

    {
        let seen = seen.lock().unwrap();
        let [(AppEvent::FrontendRequest { session_id, tool, input, last_seq, .. }, newest)] = seen.as_slice() else { panic!("{seen:?}") };
        assert_eq!((session_id, tool.as_str(), input), (&sid, "snapshot", &serde_json::json!({ "id": "chart" })));
        assert_eq!(last_seq, newest);
    }
    let logged = events(&h, &sid);
    assert!(!logged.iter().any(|e| matches!(e.kind, EventKind::FrontendToolOutput { .. })));
    assert!(!logged.iter().any(|e| matches!(e.kind, EventKind::PermissionRequested { .. })), "no prompt for the user");

    let unknown = Command::AnswerFrontendRequest { session_id: sid.clone(), request_id: "nope".into(), answer: FrontendAnswer::default() };
    assert!(matches!(h.execute(unknown).await, Ok(CommandResult::Ok)));
}

#[tokio::test(flavor = "multi_thread")]
async fn frontend_error_answer_is_a_tool_error() {
    let dir = tempfile::tempdir().unwrap();
    let h = harness(&dir.path().join("data"), &[]);
    let sid = create(&h, dir.path(), vec![]).await;
    answer_requests(&h, vec![FrontendAnswer { error: Some("no such artifact".into()), text: Some("ignored".into()), image: None }]);
    assert_eq!(ask(&h, &sid, r#"mcp snapshot {"id":"chart"}"#, None).await, "mcp error: no such artifact");
}

#[tokio::test(flavor = "multi_thread")]
async fn editor_setting_and_open_guard() {
    use harness_core::api::Editor;
    let dir = tempfile::tempdir().unwrap();
    let h = harness(&dir.path().join("data"), &[]);
    let sid = create(&h, &repo(dir.path()), vec![]).await;
    let open = |path: &str| Command::OpenInEditor { session_id: sid.clone(), path: Some(path.into()), line: Some(3) };

    let CommandResult::Editor { editor } = h.execute(Command::GetEditor).await.unwrap() else { panic!() };
    assert_eq!(editor, None);
    assert!(h.execute(open("a.txt")).await.unwrap_err().message.contains("choose an editor"));

    let custom = Editor::Custom { template: "x://{path}:{line}".into() };
    h.execute(Command::SetEditor { editor: Some(custom.clone()) }).await.unwrap();
    let CommandResult::Editor { editor } = h.execute(Command::GetEditor).await.unwrap() else { panic!() };
    assert_eq!(editor, Some(custom));
    // Checked before anything opens.
    assert!(h.execute(open("../outside.txt")).await.is_err());
    assert!(h.execute(open("missing.txt")).await.is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn approving_a_secret_file_outside_the_folder_survives_a_restart() {
    use harness_core::api::{ErrorCode, FileScope};
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let repo = repo(dir.path());
    // An `.env` file can hold secrets wherever it is.
    std::fs::write(dir.path().join(".env"), "TOKEN=made-up\n").unwrap();
    let h = harness(&data, &[]);
    let sid = create(&h, &repo, vec![]).await;
    let read = |sid: &str| Command::ReadSessionFile { session_id: sid.into(), path: "../.env".into(), start: None, end: None };
    let e = h.execute(read(&sid)).await.unwrap_err();
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::NeedsApproval, "an .env file"));
    h.execute(Command::ApproveSessionFile { session_id: sid.clone(), path: "../.env".into() }).await.unwrap();
    drop(h);

    let h = harness(&data, &[]);
    let Ok(CommandResult::FileLines { lines, scope, .. }) = h.execute(read(&sid)).await else { panic!() };
    assert_eq!((lines, scope), (vec!["TOKEN=made-up".to_string()], FileScope::Allowed));
    h.execute(Command::RevokeSessionFile { session_id: sid.clone(), path: "../.env".into() }).await.unwrap();
    assert_eq!(h.execute(read(&sid)).await.unwrap_err().code, ErrorCode::NeedsApproval);
    // The folder's own files need no approval.
    let Ok(CommandResult::FileLines { scope, .. }) =
        h.execute(Command::ReadSessionFile { session_id: sid.clone(), path: "a.txt".into(), start: None, end: None }).await
    else {
        panic!()
    };
    assert_eq!(scope, FileScope::Inside);
}

#[tokio::test(flavor = "multi_thread")]
async fn set_title_tool_names_the_session() {
    let dir = tempfile::tempdir().unwrap();
    let h = harness(&dir.path().join("data"), &[]);
    let sid = create(&h, dir.path(), vec![]).await;
    let r = ask(&h, &sid, r#"mcp set_title {"title":"Repo line count"}"#, None).await;
    assert_eq!(r, "mcp: Session titled: Repo line count");
    let CommandResult::Sessions { sessions } = h.execute(Command::ListSessions).await.unwrap() else { panic!() };
    assert_eq!(sessions.iter().find(|s| s.id == sid).unwrap().title, "Repo line count");
}

#[tokio::test(flavor = "multi_thread")]
async fn session_state_and_harness_info() {
    let dir = tempfile::tempdir().unwrap();
    let h = harness(&dir.path().join("data"), &[]);
    let sid = create(&h, dir.path(), vec![]).await;

    let r =
        ask(&h, &sid, r#"mcp state_patch {"ops":[{"op":"add","path":"/quiz/score","value":0},{"op":"add","path":"/quiz/answers","value":[]}]}"#, None).await;
    assert!(r.starts_with("mcp: {") && r.contains("\"score\": 0"), "{r}");
    let bad =
        ask(&h, &sid, r#"mcp state_patch {"ops":[{"op":"replace","path":"/quiz/score","value":9},{"op":"test","path":"/quiz/score","value":0}]}"#, None).await;
    assert!(bad.starts_with("mcp error: test failed at /quiz/score"), "{bad}");
    // The user (a bound UI component) changes it too.
    h.execute(Command::PatchState { session_id: sid.clone(), ops: vec![StatePatchOp::Add { path: "/quiz/answers/-".into(), value: serde_json::json!("B") }] })
        .await
        .unwrap();
    let got = ask(&h, &sid, r#"mcp state_get {"statePath":"/quiz"}"#, None).await;
    assert!(got.contains("\"answers\": [\n    \"B\"\n  ]") && got.contains("\"score\": 0"), "{got}");
    let CommandResult::State { state } = h.execute(Command::GetState { session_id: sid.clone() }).await.unwrap() else { panic!() };
    assert_eq!(state, serde_json::json!({ "quiz": { "score": 0, "answers": ["B"] } }));
    let writers: Vec<StateWriter> = events(&h, &sid)
        .into_iter()
        .filter_map(|e| match e.kind {
            EventKind::StateChanged { by, .. } => Some(by),
            _ => None,
        })
        .collect();
    assert_eq!(writers, vec![StateWriter::Agent, StateWriter::User], "a failed patch logs nothing");

    // Frontend Tool calls with an id are live items until removed.
    ask(&h, &sid, r#"mcp json_render {"title":"a","id":"score","placement":"bottom"}"#, None).await;
    let done = ask(&h, &sid, r#"mcp json_render {"title":"b","id":"q","placement":"right"}"#, None).await;
    let live: serde_json::Value = serde_json::from_str(done.split_once("Live items: ").unwrap().1).unwrap();
    let updated: Vec<i64> = live.as_array().unwrap().iter().map(|x| x["updated_ms"].as_i64().unwrap()).collect();
    assert!(updated[0] > 0 && updated[1] >= updated[0], "updated_ms: the logged time of each item's latest call: {done}");
    let without: Vec<serde_json::Value> = live
        .as_array()
        .unwrap()
        .iter()
        .map(|x| {
            let mut x = x.clone();
            x.as_object_mut().unwrap().remove("updated_ms");
            x
        })
        .collect();
    assert_eq!(
        serde_json::Value::Array(without),
        serde_json::json!([{"tool":"json_render","id":"score","placement":"bottom","title":"a"},{"tool":"json_render","id":"q","placement":"right","title":"b"}]),
        "{done}"
    );
    ask(&h, &sid, r#"mcp json_render {"title":"c","id":"score","remove":true}"#, None).await;
    let info = ask(&h, &sid, "mcp harness_info {}", None).await;
    assert!(info.contains("\"id\": \"q\"") && !info.contains("\"score\"") && info.contains("\"quiz\""), "{info}");
}

#[tokio::test(flavor = "multi_thread")]
async fn frontend_errors_reach_the_agent() {
    let dir = tempfile::tempdir().unwrap();
    let h = harness(&dir.path().join("data"), &[]);
    let sid = create(&h, dir.path(), vec![]).await;
    let shown = |a: String| a.split_once("Working on it.").map(|(c, _)| c.to_owned()).unwrap_or(a);
    ask(&h, &sid, "show-context", None).await;
    ask(&h, &sid, r#"mcp json_render {"title":"a","id":"chart"}"#, None).await;
    let report = |item: &str, message: &str| Command::ReportFrontendError {
        session_id: sid.clone(),
        tool: "json_render".into(),
        item: item.into(),
        message: message.into(),
    };
    h.execute(report("chart", "TypeError: x is undefined")).await.unwrap();
    h.execute(report("chart", "TypeError: x is undefined")).await.unwrap();
    h.execute(report("gone", "ignored: no such item")).await.unwrap();
    for i in 0..10 {
        h.execute(report("chart", &format!("{i}{}", "y".repeat(400)))).await.unwrap();
    }
    let logged: Vec<String> = events(&h, &sid)
        .into_iter()
        .filter_map(|e| match e.kind {
            EventKind::FrontendError { message, .. } => Some(message),
            _ => None,
        })
        .collect();
    assert_eq!(logged.len(), 5, "repeats and unknown items are dropped, at most 5 per item: {logged:?}");
    assert!(logged[1].len() < 310 && logged[1].ends_with('…'), "long messages are cut");

    // The next prompt starts with them, once; harness_info lists them while they last.
    let next = shown(ask(&h, &sid, "show-context", None).await);
    assert!(next.starts_with("context: <harness_context>\n## Frontend errors") && next.contains("- json_render `chart`: TypeError: x is undefined"), "{next}");
    assert_eq!(shown(ask(&h, &sid, "show-context", None).await), "context: none", "only errors since the last Turn");
    let info = ask(&h, &sid, "mcp harness_info {}", None).await;
    assert!(info.contains("\"errors\": [\n") && info.contains("TypeError: x is undefined"), "{info}");

    // A new call with the id clears them; the same error may then be reported again.
    ask(&h, &sid, r#"mcp json_render {"title":"b","id":"chart"}"#, None).await;
    let info = ask(&h, &sid, "mcp harness_info {}", None).await;
    assert!(!info.contains("errors"), "{info}");
    h.execute(report("chart", "TypeError: x is undefined")).await.unwrap();
    let info = ask(&h, &sid, "mcp harness_info {}", None).await;
    assert!(info.contains("TypeError: x is undefined"), "{info}");
}

#[tokio::test(flavor = "multi_thread")]
async fn harness_context_starts_each_agent_session() {
    let dir = tempfile::tempdir().unwrap();
    let repo = repo(dir.path());
    let data = dir.path().join("data");
    let h = harness(&data, &[]);
    let sid = create(&h, &repo, vec![]).await;

    // The fake Agent always adds "Working on it. Done." after its answer.
    let shown = |a: String| a.split_once("Working on it.").map(|(c, _)| c.to_owned()).unwrap_or(a);
    let first = shown(ask(&h, &sid, "show-context", None).await);
    assert!(first.starts_with("context: <harness_context>\nYou run inside Harness"), "{first}");
    assert!(first.contains("## Frontend: Chat\n\nUse json_render for results."), "{first}");
    assert!(first.contains(&format!("- Repository: {}", repo.canonicalize().unwrap().display())) && first.contains("- Worktree: no"), "{first}");
    assert!(first.ends_with("</harness_context>"), "{first}");
    let logged: Vec<Option<String>> = events(&h, &sid)
        .into_iter()
        .filter_map(|e| match e.kind {
            EventKind::TurnStarted { context, .. } => Some(context),
            _ => None,
        })
        .collect();
    assert_eq!(logged.len(), 1);
    assert_eq!(logged[0].as_deref(), first.strip_prefix("context: "), "the log records what was sent");

    assert_eq!(shown(ask(&h, &sid, "show-context", None).await), "context: none", "only the first prompt");

    // A new Agent Session (continue with a summary) gets it again; the data dir file overrides.
    std::fs::create_dir_all(data.join("prompts")).unwrap();
    std::fs::write(data.join("prompts/harness.md"), "Custom core text.").unwrap();
    std::fs::write(data.join("prompts/chat.md"), "Custom chat text.").unwrap();
    h.execute(Command::ContinueWithSummary { session_id: sid.clone(), thread_id: None, text: None, attachments: vec![] }).await.unwrap();
    let again = shown(ask(&h, &sid, "show-context", None).await);
    assert!(again.starts_with("seededcontext: <harness_context>\nCustom core text.\n\n## Frontend: Chat\n\nCustom chat text."), "{again}");

    // Custom Instructions follow the Frontend's part, from the next Agent Session on. A Worktree
    // of the repository uses the main checkout's.
    let root = repo.canonicalize().unwrap().display().to_string();
    let repo_scope = InstructionsScope::Repo { path: root.clone() };
    h.execute(Command::SetInstructions { scope: InstructionsScope::Global, text: "Answer briefly.".into() }).await.unwrap();
    h.execute(Command::SetInstructions { scope: repo_scope.clone(), text: "Run the tests first.\n".into() }).await.unwrap();
    let CommandResult::InstructionsText { text } = h.execute(Command::GetInstructions { scope: repo_scope.clone() }).await.unwrap() else { panic!() };
    assert_eq!(text, "Run the tests first.");
    let CommandResult::Instructions { entries } = h.execute(Command::ListInstructions).await.unwrap() else { panic!() };
    assert_eq!(entries.iter().map(|e| (e.name.as_str(), e.lines, e.folder_exists)).collect::<Vec<_>>(), [("Global", 1, true), ("proj", 1, true)]);
    assert_eq!(entries[1].scope, repo_scope);
    let wt = Command::CreateSession {
        folder: repo.display().to_string(),
        agent_id: "fake".into(),
        frontend_id: "chat".into(),
        title: None,
        branch: None,
        worktree: true,
        new_branch: None,
        pr: None,
        mcp_servers: vec![],
        task: None,
    };
    let CommandResult::SessionCreated { session_id: wt_sid } = h.execute(wt).await.unwrap() else { panic!() };
    let first = shown(ask(&h, &wt_sid, "show-context", None).await);
    assert!(
        first.contains(
            "Custom chat text.\n\n## Your instructions for all Sessions\n\nAnswer briefly.\n\n## Your instructions (proj)\n\nRun the tests first.\n\n## This Session"
        ),
        "{first}"
    );
    assert!(first.contains("- Worktree: yes"), "{first}");
    assert!(first.contains(&format!("- Instructions folder: {root}\n")), "{first}");

    // A Worktree cut from that Worktree keeps the main checkout's, also once the first is gone.
    let list = std::process::Command::new("git").args(["worktree", "list", "--porcelain"]).current_dir(&repo).output().unwrap();
    let wt_dir = String::from_utf8(list.stdout)
        .unwrap()
        .lines()
        .filter_map(|l| l.strip_prefix("worktree "))
        .map(std::path::PathBuf::from)
        .find(|p| p.canonicalize().unwrap().display().to_string() != root)
        .unwrap();
    // Outside the first one, as `~/.harness/worktrees` is, so removing it keeps this one.
    let outside = dir.path().join("wts");
    h.execute(Command::SetWorktreeDir { dir: Some(outside.display().to_string()) }).await.unwrap();
    let nested = Command::CreateSession {
        folder: wt_dir.display().to_string(),
        agent_id: "fake".into(),
        frontend_id: "chat".into(),
        title: None,
        branch: None,
        worktree: true,
        new_branch: None,
        pr: None,
        mcp_servers: vec![],
        task: None,
    };
    let CommandResult::SessionCreated { session_id: nested_sid } = h.execute(nested).await.unwrap() else { panic!() };
    git(&repo, &["worktree", "remove", "--force", wt_dir.to_str().unwrap()]);
    let ctx = shown(ask(&h, &nested_sid, "show-context", None).await);
    assert!(ctx.contains(&format!("- Instructions folder: {root}\n")), "{ctx}");

    // A linked worktree the user made: the Repository line is its own folder, the key line names
    // the main checkout (the UI's "Edit … instructions" link reads it).
    let linked = dir.path().join("proj-side");
    git(&repo, &["worktree", "add", "-q", "-b", "side", linked.to_str().unwrap()]);
    let linked_sid = create(&h, &linked, vec![]).await;
    let ctx = shown(ask(&h, &linked_sid, "show-context", None).await);
    let linked_root = linked.canonicalize().unwrap().display().to_string();
    assert!(ctx.contains(&format!("- Repository: {linked_root}\n")), "{ctx}");
    assert!(ctx.contains("## Your instructions (proj)\n\nRun the tests first."), "{ctx}");
    assert!(ctx.contains(&format!("- Instructions folder: {root}\n")), "{ctx}");

    // A Quick Session's folder is scratch space, also for a Session its Agent starts there
    // (a Sub Session is not Quick itself): no repository instructions, no list entry.
    let quick = Command::CreateQuickSession { agent_id: "fake".into(), frontend_id: "chat".into(), title: None, mcp_servers: vec![] };
    let CommandResult::SessionCreated { session_id: quick_sid } = h.execute(quick).await.unwrap() else { panic!() };
    let quick_folder = data.join("quick").join(&quick_sid).canonicalize().unwrap().display().to_string();
    let sub_sid = create(&h, Path::new(&quick_folder), vec![]).await;
    let ctx = shown(ask(&h, &sub_sid, "show-context", None).await);
    assert!(ctx.contains("## Your instructions for all Sessions") && !ctx.contains("- Instructions folder:"), "{ctx}");
    let CommandResult::Instructions { entries } = h.execute(Command::ListInstructions).await.unwrap() else { panic!() };
    assert!(!entries.iter().any(|e| e.scope == InstructionsScope::Repo { path: quick_folder.clone() }), "{entries:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn stdio_shim_for_agents_without_http_mcp() {
    let dir = tempfile::tempdir().unwrap();
    let repo = repo(dir.path());
    let h = harness(&dir.path().join("data"), &["--no-http-mcp"]);
    let sid = create(&h, &repo, vec![]).await;
    let servers = ask(&h, &sid, "mcp-servers", None).await;
    assert!(servers.starts_with("servers: harness:stdio:HARNESS_MCP_URL=http://127.0.0.1:"), "{servers}");
    let status = ask(&h, &sid, "mcp git_status {}", None).await;
    assert!(status.starts_with("mcp: {") && status.contains("\"branch\": \"main\""), "{status}");
}

#[tokio::test(flavor = "multi_thread")]
async fn library_servers_are_given_to_the_agent_with_secrets() {
    let dir = tempfile::tempdir().unwrap();
    let h = harness(&dir.path().join("data"), &["--no-http-mcp"]);
    let def = McpServerDef {
        id: String::new(),
        name: "Docs".into(),
        transport: McpTransport::Stdio { command: "/usr/bin/true".into(), args: vec![], env: [("PLAIN".to_owned(), "1".to_owned())].into() },
        secret_keys: vec!["API_KEY".into()],
    };
    let save = Command::SaveMcpServer { server: def, secrets: [("API_KEY".to_owned(), "s3cret".to_owned())].into() };
    let CommandResult::McpServerSaved { server } = h.execute(save).await.unwrap() else { panic!() };
    assert_eq!(server.id, "docs");
    assert!(!std::fs::read_to_string(dir.path().join("data/mcp.json")).unwrap().contains("s3cret"));

    let sid = create(&h, dir.path(), vec!["docs".into()]).await;
    let servers = ask(&h, &sid, "mcp-servers", None).await;
    assert!(servers.ends_with(" docs:stdio:API_KEY=s3cret&PLAIN=1"), "{servers}");

    let bad = Command::CreateSession {
        folder: dir.path().display().to_string(),
        agent_id: "fake".into(),
        frontend_id: "chat".into(),
        title: None,
        branch: None,
        worktree: false,
        new_branch: None,
        pr: None,
        mcp_servers: vec!["nope".into()],
        task: None,
    };
    assert!(h.execute(bad).await.is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn server_refuses_missing_tokens_and_browser_origins() {
    let dir = tempfile::tempdir().unwrap();
    let h = harness(&dir.path().join("data"), &[]);
    let url = h.mcp_url().await.unwrap();
    let code = |extra: &[&str]| {
        let out = Proc::new("curl")
            .args(["-s", "-o", "/dev/null", "-w", "%{http_code}", "-X", "POST", "-H", "content-type: application/json"])
            .args(extra)
            .args(["--data", "{}", &url])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).into_owned()
    };
    assert_eq!(code(&[]), "401");
    assert_eq!(code(&["-H", "Authorization: Bearer nope"]), "401");
    assert_eq!(code(&["-H", "Origin: http://evil.example"]), "403");
}

/// The chat Frontend's manifest is generated from jsonv-ts; the core's validator must accept it and
/// its errors must tell an Agent what to fix.
#[test]
fn generated_chat_manifest_validates_in_core() {
    use serde_json::json;
    let manifest: FrontendManifest = serde_json::from_str(include_str!("../../../packages/frontend-chat/manifest.json")).unwrap();
    let tool = manifest.frontend_tools.iter().find(|t| t.name == "render_ui").expect("render_ui");
    let v = jsonschema::options().with_format("harness-image", |_: &str| true).should_validate_formats(true).build(&tool.input_schema).unwrap();
    let errors = |i: serde_json::Value| v.iter_errors(&i).map(|e| format!("{}: {e}", e.instance_path)).collect::<Vec<_>>().join("\n");
    assert_eq!(
        errors(json!({ "root": { "type": "Stack", "children": [
        { "type": "Card", "props": { "title": "Done", "tone": "success" }, "children": [{ "type": "Markdown", "props": { "text": "ok" } }] },
        { "type": "Carousel", "props": { "images": [{ "src": "a.png", "alt": "A" }] } }
    ] } })),
        ""
    );
    let e = errors(json!({ "root": { "type": "Stack", "children": [{ "type": "Image", "props": { "alt": "x" } }] } }));
    assert!(e.contains("/root/children/0/props") && e.contains("\"src\" is a required property"), "{e}");
    let e = errors(json!({ "root": { "type": "Badge", "props": { "text": "x", "tone": "loud" } } }));
    assert!(e.contains("/root/props/tone"), "{e}");
    let e = errors(json!({ "root": { "type": "Nope" } }));
    assert!(e.contains("/root/type"), "{e}");
    let e = errors(json!({ "root": { "type": "Markdown", "props": { "text": "x" }, "children": [{ "type": "Markdown", "props": { "text": "y" } }] } }));
    assert!(e.contains("/root/children"), "{e}");
    // Placements, bindings and actions.
    assert_eq!(
        errors(
            json!({ "id": "score", "placement": "bottom", "root": { "type": "Stat", "props": { "label": "Score", "value": { "$template": "${/quiz/score} / 5" } } } })
        ),
        ""
    );
    assert_eq!(errors(json!({ "id": "score", "remove": true })), "");
    // File-backed panels (ADR 0023): exactly one of root or source, a relative .md or .html name.
    assert_eq!(errors(json!({ "id": "p", "placement": "right", "title": "P", "source": "plan/progress.md" })), "");
    assert_ne!(errors(json!({ "id": "p", "source": "p.md", "root": { "type": "Markdown", "props": { "text": "x" } } })), "");
    assert_ne!(errors(json!({ "id": "p", "placement": "right" })), "");
    assert_eq!(errors(json!({ "id": "p", "source": "p.html" })), "");
    assert_ne!(errors(json!({ "id": "p", "source": "p.txt" })), "");
    assert_ne!(errors(json!({ "id": "p", "source": "p.htm" })), "");
    assert_ne!(errors(json!({ "id": "p", "source": "/etc/p.md" })), "");
    assert_eq!(
        errors(json!({ "root": { "type": "Choice", "props": { "value": { "$bindState": "/a/q1" }, "options": [{ "value": "a", "label": "A" }] },
        "on": { "change": { "action": "sendMessage", "params": { "text": { "$template": "Answer: ${/a/q1}" } } } } } })),
        ""
    );
    assert!(errors(json!({ "placement": "right", "root": { "type": "Markdown", "props": { "text": "x" } } })).contains("\"id\" is a required property"));
    assert_eq!(
        errors(json!({ "id": "test", "placement": "right", "title": "Test", "root": { "type": "Stepper", "props": { "steps": ["Q1"] },
        "on": { "finish": { "action": "sendMessage", "params": { "text": "done" } } },
        "children": [{ "type": "Choice", "props": { "value": { "$bindState": "/q/a1" }, "result": { "$bindState": "/q/r/q1" }, "answer": "a", "options": [{ "value": "a", "label": "A" }] } }] } })),
        ""
    );
    assert_eq!(
        errors(
            json!({ "root": { "type": "Stat", "props": { "label": "Score", "value": { "$computed": "count", "args": { "values": { "$state": "/q/r" }, "eq": true } } } } })
        ),
        ""
    );
    assert!(
        !errors(json!({ "root": { "type": "Stat", "props": { "label": "S", "value": { "$computed": "average", "args": { "values": [] } } } } })).is_empty()
    );
    assert_eq!(
        errors(
            json!({ "root": { "type": "Button", "props": { "label": "Continue" }, "visible": { "$and": [{ "$state": "/q/a1" }, { "$state": "/q/step", "eq": 0 }] } } })
        ),
        ""
    );
    assert!(!errors(json!({ "root": { "type": "Button", "props": { "label": "x" }, "visible": { "$state": 1 } } })).is_empty());
    assert!(
        !errors(json!({ "root": { "type": "Button", "props": { "label": "x" }, "on": { "press": { "action": "setState", "params": { "value": 1 } } } } }))
            .is_empty()
    );
    // Repeat scope (json-render's $item, $index, $bindItem) and rich Table rows.
    assert_eq!(
        errors(json!({ "root": { "type": "Repeat", "props": { "items": { "$state": "/t" } }, "children": [
        { "type": "Checkbox", "props": { "label": { "$item": "title" }, "value": { "$bindItem": "done" } }, "visible": { "$item": "open" } },
        { "type": "Button", "props": { "label": "x" }, "on": { "press": { "action": "removeState", "params": { "statePath": "/t", "index": { "$index": true } } } } }
    ] } })),
        ""
    );
    assert_eq!(
        errors(
            json!({ "root": { "type": "Table", "props": { "columns": ["A"], "rows": [["x"], { "cells": [{ "text": "y", "tone": "error" }], "tone": "warning" }] } } })
        ),
        ""
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn ui_get_returns_latest_panel_input() {
    let dir = tempfile::tempdir().unwrap();
    let h = harness(&dir.path().join("data"), &[]);
    h.register_frontend(FrontendManifest {
        id: "chat".into(),
        name: "Chat".into(),
        version: "0".into(),
        instructions: None,
        frontend_tools: vec![FrontendToolDecl {
            name: "render_ui".into(),
            description: "Render a panel".into(),
            input_schema: serde_json::json!({ "type": "object", "properties": { "id": { "type": "string" } } }),
            replies: false,
        }],
    });
    let sid = create(&h, dir.path(), vec![]).await;
    ask(&h, &sid, r#"mcp state_patch {"ops":[{"op":"add","path":"/quiz/score","value":3},{"op":"add","path":"/n","value":1}]}"#, None).await;
    ask(&h, &sid, r#"mcp render_ui {"id":"a","title":"one","root":{"type":"Stat","props":{"value":{"$state":"/quiz/score"}}}}"#, None).await;
    ask(&h, &sid, r#"mcp render_ui {"id":"b","title":"two","root":{"type":"Stat","props":{"value":{"$template":"${/n} of ${/missing}"}}}}"#, None).await;
    ask(&h, &sid, r#"mcp render_ui {"id":"a","title":"one v2","root":{"type":"Stat","props":{"value":{"$state":"/quiz/score"}}}}"#, None).await;

    let got = ask(&h, &sid, r#"mcp ui_get {"id":"a"}"#, None).await;
    let v: serde_json::Value = serde_json::from_str(got.strip_prefix("mcp: ").unwrap().split("Working on it.").next().unwrap().trim()).unwrap();
    assert_eq!(v["input"]["title"], "one v2");
    assert_eq!(v["state"], serde_json::json!({ "/quiz/score": 3 }));
    let got = ask(&h, &sid, r#"mcp ui_get {"id":"b"}"#, None).await;
    assert!(got.contains("\"/n\": 1") && got.contains("\"/missing\": null"), "{got}");

    ask(&h, &sid, r#"mcp render_ui {"id":"b","remove":true}"#, None).await;
    let err = ask(&h, &sid, r#"mcp ui_get {"id":"b"}"#, None).await;
    assert!(err.starts_with("mcp error:") && err.contains("Known ids: a"), "{err}");
}

#[tokio::test(flavor = "multi_thread")]
async fn file_backed_panels() {
    let dir = tempfile::tempdir().unwrap();
    let h = harness(&dir.path().join("data"), &[]);
    h.register_frontend(FrontendManifest {
        id: "chat".into(),
        name: "Chat".into(),
        version: "0".into(),
        instructions: None,
        frontend_tools: vec![FrontendToolDecl {
            name: "render_ui".into(),
            description: "Render a panel".into(),
            input_schema: serde_json::json!({ "type": "object", "properties": { "id": { "type": "string" }, "source": { "type": "string" } } }),
            replies: false,
        }],
    });
    let sid = create(&h, dir.path(), vec![]).await;
    let info = ask(&h, &sid, "mcp harness_info {}", None).await;
    let panels = dir.path().join("data/sessions").join(&sid).join("panels");
    assert!(info.contains(&format!("\"panels_dir\": \"{}\"", panels.display())), "{info}");
    assert!(panels.is_dir());

    // The file must exist and stay inside panels_dir.
    let missing = ask(&h, &sid, r#"mcp render_ui {"id":"p","placement":"right","source":"plan/progress.md"}"#, None).await;
    assert!(missing.starts_with("mcp error:") && missing.contains("does not exist") && missing.contains("Write the file first"), "{missing}");
    let outside = ask(&h, &sid, r#"mcp render_ui {"id":"p","source":"../state.json"}"#, None).await;
    assert!(outside.starts_with("mcp error:"), "{outside}");

    std::fs::create_dir_all(panels.join("plan")).unwrap();
    std::fs::write(panels.join("plan/progress.md"), "# Progress\n\n- [x] one").unwrap();
    let done = ask(&h, &sid, r#"mcp render_ui {"id":"p","placement":"right","title":"Progress","source":"plan/progress.md"}"#, None).await;
    assert!(done.contains(r#""source":"plan/progress.md""#), "{done}");
    // The log keeps the name, never the content: replay shows the file as it is now.
    let logged: Vec<serde_json::Value> = events(&h, &sid)
        .into_iter()
        .filter_map(|e| match e.kind {
            EventKind::FrontendToolOutput { input, .. } => Some(input),
            _ => None,
        })
        .collect();
    assert_eq!(logged, vec![serde_json::json!({"id": "p", "placement": "right", "title": "Progress", "source": "plan/progress.md"})]);

    let changed = Arc::new(Mutex::new(Vec::new()));
    let c = changed.clone();
    h.subscribe_app(Box::new(move |e: &AppEvent| {
        if let AppEvent::PanelSourceChanged { name, .. } = e {
            c.lock().unwrap().push(name.clone());
        }
        true
    }));
    let read = |name: &str| Command::PanelSourceRead { session_id: sid.clone(), name: name.into() };
    let CommandResult::PanelSource { content, hash, mtime_ms, path } = h.execute(read("plan/progress.md")).await.unwrap() else { panic!() };
    assert_eq!(content, "# Progress\n\n- [x] one");
    assert_eq!(std::path::Path::new(&path), panels.canonicalize().unwrap().join("plan/progress.md"));
    assert_eq!(hash.len(), 64);
    assert!(mtime_ms > 0);
    assert!(h.execute(read("../session.json")).await.is_err());

    std::thread::sleep(Duration::from_millis(150));
    std::fs::write(panels.join("plan/progress.md"), "# Progress\n\n- [x] one\n- [ ] two").unwrap();
    tokio::time::sleep(Duration::from_millis(900)).await;
    assert_eq!(*changed.lock().unwrap(), vec!["plan/progress.md".to_owned()]);
    // An .html source: same checks and reads; other types are refused.
    std::fs::write(panels.join("board.html"), "<p>board</p>").unwrap();
    let html = ask(&h, &sid, r#"mcp render_ui {"id":"b","placement":"left","title":"Board","source":"board.html"}"#, None).await;
    assert!(html.contains(r#""source":"board.html""#), "{html}");
    let CommandResult::PanelSource { content, .. } = h.execute(read("board.html")).await.unwrap() else { panic!() };
    assert_eq!(content, "<p>board</p>");
    tokio::time::sleep(Duration::from_millis(900)).await;
    assert_eq!(changed.lock().unwrap().last().map(String::as_str), Some("board.html"), "the watcher reports .html files");
    std::fs::write(panels.join("notes.txt"), "x").unwrap();
    assert!(h.execute(read("notes.txt")).await.is_err());
    let _ = ask(&h, &sid, r#"mcp render_ui {"id":"b","remove":true}"#, None).await;

    let got = ask(&h, &sid, r#"mcp ui_get {"id":"p"}"#, None).await;
    assert!(got.contains(r##""content": "# Progress\n\n- [x] one\n- [ ] two""##) && got.contains(r#""source": "plan/progress.md""#), "{got}");

    // updated_ms: the file's write, as it is later than the render_ui call.
    let info = ask(&h, &sid, "mcp harness_info {}", None).await;
    let info: serde_json::Value = serde_json::Deserializer::from_str(&info[info.find('{').unwrap()..]).into_iter().next().unwrap().unwrap();
    let updated = info["items"][0]["updated_ms"].as_i64().unwrap();
    let mtime = std::fs::metadata(panels.join("plan/progress.md")).unwrap().modified().unwrap();
    assert_eq!(updated, mtime.duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64);

    // A deleted file: harness_info names it, ui_get says so.
    std::fs::remove_file(panels.join("plan/progress.md")).unwrap();
    let info = ask(&h, &sid, "mcp harness_info {}", None).await;
    assert!(info.contains("Source missing: source \\\"plan/progress.md\\\" does not exist"), "{info}");
    let got = ask(&h, &sid, r#"mcp ui_get {"id":"p"}"#, None).await;
    assert!(got.contains("\"error\": \"source"), "{got}");
}

#[tokio::test(flavor = "multi_thread")]
async fn json_panel_sources_are_checked_trees() {
    let dir = tempfile::tempdir().unwrap();
    let h = harness(&dir.path().join("data"), &[]);
    let node = serde_json::json!({ "type": "object", "required": ["type"], "properties": { "type": { "enum": ["Markdown"] }, "src": { "type": "string", "format": "harness-image" } } });
    h.register_frontend(FrontendManifest {
        id: "chat".into(),
        name: "Chat".into(),
        version: "0".into(),
        instructions: None,
        frontend_tools: vec![FrontendToolDecl {
            name: "render_ui".into(),
            description: "Render a panel".into(),
            input_schema: serde_json::json!({ "type": "object", "properties": { "id": { "type": "string" }, "source": { "type": "string" }, "root": node } }),
            replies: false,
        }],
    });
    let sid = create(&h, dir.path(), vec![]).await;
    let panels = dir.path().join("data/sessions").join(&sid).join("panels");
    let _ = ask(&h, &sid, "mcp harness_info {}", None).await;
    let call = r#"mcp render_ui {"id":"t","placement":"right","title":"Tree","source":"tree.json"}"#;

    // Refused at the call: not JSON, no root, a root the schema refuses, a local image.
    for (bad, says) in [
        ("{", "is not JSON"),
        (r#"{"type":"Markdown"}"#, "must be {\"root\": node}"),
        (r#"{"root":{"type":"Nope"}}"#, "invalid tree"),
        (r#"{"root":{"type":"Markdown","src":"shot.png"}}"#, "local images (shot.png)"),
    ] {
        std::fs::write(panels.join("tree.json"), bad).unwrap();
        let err = ask(&h, &sid, call, None).await;
        assert!(err.starts_with("mcp error:") && err.contains(says) && err.contains("Fix the file"), "{bad}: {err}");
    }

    std::fs::write(panels.join("tree.json"), r#"{"root":{"type":"Markdown","src":"https://x.test/a.png"}}"#).unwrap();
    let done = ask(&h, &sid, call, None).await;
    assert!(done.contains(r#""source":"tree.json""#), "{done}");
    assert!(!ask(&h, &sid, "mcp harness_info {}", None).await.contains("invalid tree"));

    // A later edit that breaks the tree: harness_info lists it on the item.
    std::fs::write(panels.join("tree.json"), r#"{"root":{"type":"Nope"}}"#).unwrap();
    let info = ask(&h, &sid, "mcp harness_info {}", None).await;
    assert!(info.contains("invalid tree"), "{info}");
}

// ---------- Shared Artifacts (ADR 0024) ----------

/// A Harness whose chat Frontend has a `render_ui` that takes `source`, a `root` with an image, and an id.
fn shared_harness(data: &Path) -> Arc<Harness> {
    let h = harness(data, &[]);
    h.register_frontend(FrontendManifest {
        id: "chat".into(),
        name: "Chat".into(),
        version: "0".into(),
        instructions: None,
        frontend_tools: vec![FrontendToolDecl {
            name: "render_ui".into(),
            description: "Render a panel".into(),
            input_schema: serde_json::json!({ "type": "object", "properties": {
                "id": { "type": "string" },
                "title": { "type": "string" },
                "placement": { "type": "string" },
                "remove": { "type": "boolean" },
                "source": { "type": "string" },
                "root": { "type": "object", "properties": { "image": { "type": "string", "format": "harness-image" } } }
            } }),
            replies: false,
        }],
    });
    h
}

/// Calls a Harness MCP tool and parses the JSON it returns.
async fn mcp_json(h: &Harness, sid: &str, call: &str) -> serde_json::Value {
    let reply = ask(h, sid, &format!("mcp {call}"), None).await;
    // Text of a Turn running beside this one may come first.
    let body = reply.rsplit_once("mcp: ").map(|(_, b)| b).unwrap_or_else(|| panic!("{call}: {reply}"));
    serde_json::Deserializer::from_str(body).into_iter().next().unwrap().unwrap_or_else(|e| panic!("{call}: {e}: {reply}"))
}

fn shared_events(h: &Harness, sid: &str) -> Vec<EventKind> {
    events(h, sid)
        .into_iter()
        .map(|e| e.kind)
        .filter(|k| matches!(k, EventKind::ArtifactAttached { .. } | EventKind::ArtifactDetached { .. } | EventKind::ArtifactStateChanged { .. }))
        .collect()
}

fn shared_meta(h: &Harness, id: &str) -> harness_core::api::SharedArtifactMeta {
    let rt = tokio::runtime::Handle::current();
    let r = tokio::task::block_in_place(|| rt.block_on(h.execute(Command::SharedArtifactRead { id: id.into() })));
    match r {
        Ok(CommandResult::SharedArtifact { meta, .. }) => meta,
        r => panic!("{r:?}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn share_attach_and_search() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let h = shared_harness(&data);
    let a = create(&h, dir.path(), vec![]).await;
    let b = create(&h, dir.path(), vec![]).await;
    let panels = data.join("sessions").join(&a).join("panels");
    std::fs::write(panels.join("plan.md"), "# Release plan\n\n- [ ] ship it").unwrap();
    ask(&h, &a, r#"mcp render_ui {"id":"p","placement":"right","title":"Release checklist","source":"plan.md"}"#, None).await;

    let shared = mcp_json(&h, &a, r#"artifact_share {"id":"p"}"#).await;
    let id = shared["id"].as_str().unwrap().to_owned();
    assert!(id.starts_with("release-checklist-"), "{shared}");
    let folder = data.join("shared").join(&id);
    assert_eq!(shared["dir"], folder.display().to_string());
    assert_eq!(std::fs::read_to_string(folder.join("content.md")).unwrap(), "# Release plan\n\n- [ ] ship it");
    assert!(!panels.join("plan.md").exists(), "the file moved out of the Session");
    // The item now shows the shared artifact, in the same place; the Session is attached.
    let inputs: Vec<serde_json::Value> = events(&h, &a)
        .into_iter()
        .filter_map(|e| match e.kind {
            EventKind::FrontendToolOutput { input, .. } => Some(input),
            _ => None,
        })
        .collect();
    assert_eq!(inputs.last().unwrap(), &serde_json::json!({ "id": "p", "placement": "right", "title": "Release checklist", "source": format!("shared:{id}") }));
    assert!(matches!(&shared_events(&h, &a)[..], [EventKind::ArtifactAttached { id: x, by: StateWriter::Agent }] if *x == id));
    let again = ask(&h, &a, r#"mcp artifact_share {"id":"p"}"#, None).await;
    assert!(again.starts_with("mcp error:") && again.contains("already shared"), "{again}");

    // Another Session finds it by content and attaches it.
    let found = mcp_json(&h, &b, r#"artifact_search {"query":"SHIP IT"}"#).await;
    assert_eq!((found[0]["id"].as_str(), found[0]["attached"].as_bool()), (Some(id.as_str()), Some(false)), "{found}");
    assert!(found[0]["snippet"].as_str().unwrap().contains("ship it"));
    let attached = mcp_json(&h, &b, &format!(r#"artifact_attach {{"id":"{id}"}}"#)).await;
    assert_eq!((attached["file"].as_str(), attached["kind"].as_str()), (Some("content.md"), Some("md")));
    let found = mcp_json(&h, &b, r#"artifact_search {"query":"release"}"#).await;
    assert_eq!(found[0]["attached"], true);
    assert_eq!(shared_meta(&h, &id).attached, vec![a.clone(), b.clone()]);
    // The no-Session list has it.
    let CommandResult::SharedArtifactList { artifacts } = h.execute(Command::ListSharedArtifacts { query: None }).await.unwrap() else { panic!() };
    assert_eq!(artifacts.len(), 1);

    // Detach, then the source is refused until attached again.
    ask(&h, &b, &format!(r#"mcp artifact_detach {{"id":"{id}"}}"#), None).await;
    assert_eq!(shared_meta(&h, &id).attached, vec![a.clone()]);
    let refused = ask(&h, &b, &format!(r#"mcp render_ui {{"id":"x","source":"shared:{id}"}}"#), None).await;
    assert!(refused.starts_with("mcp error:") && refused.contains("not attached"), "{refused}");
    let unknown = ask(&h, &b, r#"mcp render_ui {"id":"x","source":"shared:nope-000000"}"#, None).await;
    assert!(unknown.starts_with("mcp error:") && unknown.contains("no shared artifact"), "{unknown}");
    h.execute(Command::AttachSharedArtifact { session_id: b.clone(), id: id.clone() }).await.unwrap();
    let ok = ask(&h, &b, &format!(r#"mcp render_ui {{"id":"x","placement":"left","source":"shared:{id}"}}"#), None).await;
    assert!(ok.starts_with("mcp: Done."), "{ok}");
    let kinds: Vec<&str> = shared_events(&h, &b)
        .iter()
        .map(|k| match k {
            EventKind::ArtifactAttached { .. } => "attached",
            EventKind::ArtifactDetached { .. } => "detached",
            _ => "state",
        })
        .collect();
    assert_eq!(kinds, vec!["attached", "detached", "attached"]);

    // Markdown from a message becomes its own artifact.
    let CommandResult::SharedArtifactInfo { meta } = h
        .execute(Command::ShareMarkdown {
            session_id: a.clone(),
            markdown: "```mermaid\ngraph TD; A-->B\n```".into(),
            title: None,
            origin: Some("r1:diagram:0".into()),
        })
        .await
        .unwrap()
    else {
        panic!()
    };
    assert_eq!((meta.title.as_str(), meta.kind), ("Diagram", harness_core::api::SharedKind::Md));
    assert_eq!(meta.created_by.origin.as_deref(), Some("r1:diagram:0"));
    assert_eq!(shared_meta(&h, &meta.id).created_by.origin.as_deref(), Some("r1:diagram:0"), "read back");
}

fn file_requests(h: &Harness, sid: &str) -> Vec<(serde_json::Value, Vec<String>)> {
    events(h, sid)
        .into_iter()
        .filter_map(|e| match e.kind {
            EventKind::PermissionRequested { tool_call, options, .. } if tool_call["kind"] == "frontend_file" => {
                Some((tool_call, options.into_iter().map(|o| o.option_id).collect()))
            }
            _ => None,
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn an_image_outside_the_folder_needs_approval_of_that_file() {
    let dir = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let h = harness(&dir.path().join("data"), &[]);
    let sid = create(&h, dir.path(), vec![]).await;
    std::fs::write(other.path().join("shot.png"), b"png").unwrap();
    let outside = other.path().join("shot.png");
    let real = outside.canonicalize().unwrap();
    let call = format!(r#"mcp json_render {{"title":"Hi","items":["x"],"image":{}}}"#, serde_json::to_string(&outside.display().to_string()).unwrap());
    // A rule for Frontend Tools in general does not cover a file outside the folder.
    h.execute(Command::AddPermissionRule {
        rule: NewPermissionRule { scope: RuleScope::Global, tool_kind: Some("frontend_tool".into()), pattern: None, decision: Decision::Allow },
    })
    .await
    .unwrap();

    let denied = ask(&h, &sid, &call, Some("reject")).await;
    assert!(denied.contains("the user denied this"), "{denied}");
    let requests = file_requests(&h, &sid);
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].0["locations"][0]["path"], real.display().to_string(), "the resolved path is shown");
    assert_eq!(requests[0].1, vec!["allow", "reject"], "no 'always' answer");
    assert!(!events(&h, &sid).iter().any(|e| matches!(e.kind, EventKind::FrontendToolOutput { .. })));

    let ok = ask(&h, &sid, &call, Some("allow")).await;
    assert!(ok.starts_with("mcp: Done."), "{ok}");
    assert_eq!(file_requests(&h, &sid).len(), 2, "asked again for the next call");
    let files = events(&h, &sid)
        .into_iter()
        .find_map(|e| match e.kind {
            EventKind::FrontendToolOutput { files, .. } => Some(files),
            _ => None,
        })
        .unwrap();
    let CommandResult::Attachment { data, .. } =
        h.execute(Command::FrontendReadImage { session_id: sid.clone(), path: files[&outside.display().to_string()].clone() }).await.unwrap()
    else {
        panic!()
    };
    assert_eq!(data, "cG5n");
}

#[tokio::test(flavor = "multi_thread")]
async fn shared_tree_takes_its_state_and_images_and_a_new_root() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let h = shared_harness(&data);
    let a = create(&h, dir.path(), vec![]).await;
    std::fs::write(dir.path().join("shot.png"), b"png").unwrap();
    ask(&h, &a, r#"mcp state_patch {"ops":[{"op":"add","path":"/quiz/score","value":3},{"op":"add","path":"/other","value":1}]}"#, None).await;
    ask(&h, &a, r#"mcp render_ui {"id":"t","title":"Quiz","root":{"type":"Stat","image":"shot.png","props":{"value":{"$state":"/quiz/score"}}}}"#, None).await;

    let CommandResult::SharedArtifactInfo { meta } = h.execute(Command::ShareArtifact { session_id: a.clone(), item_id: "t".into() }).await.unwrap() else {
        panic!()
    };
    let id = meta.id.clone();
    assert_eq!(meta.kind, harness_core::api::SharedKind::Ui);
    let folder = data.join("shared").join(&id);
    let ui: serde_json::Value = serde_json::from_slice(&std::fs::read(folder.join("ui.json")).unwrap()).unwrap();
    assert_eq!(ui["root"]["image"], "shot.png");
    let copy = ui["files"]["shot.png"].as_str().unwrap();
    assert_eq!(std::fs::read(folder.join(copy)).unwrap(), b"png");
    let CommandResult::SharedArtifact { state, .. } = h.execute(Command::SharedArtifactRead { id: id.clone() }).await.unwrap() else { panic!() };
    assert_eq!(state, serde_json::json!({ "quiz": { "score": 3 } }), "only the paths the tree binds");
    assert!(matches!(&shared_events(&h, &a)[..], [EventKind::ArtifactAttached { by: StateWriter::User, .. }]));

    // A new root replaces ui.json and is not logged.
    let before = events(&h, &a).iter().filter(|e| matches!(e.kind, EventKind::FrontendToolOutput { .. })).count();
    let done = ask(&h, &a, &format!(r#"mcp render_ui {{"id":"shared:{id}","root":{{"type":"Markdown","props":{{"text":"v2"}}}}}}"#), None).await;
    assert!(done.starts_with("mcp: Done. Shared artifact"), "{done}");
    let ui: serde_json::Value = serde_json::from_slice(&std::fs::read(folder.join("ui.json")).unwrap()).unwrap();
    assert_eq!(ui["root"]["props"]["text"], "v2");
    assert_eq!(events(&h, &a).iter().filter(|e| matches!(e.kind, EventKind::FrontendToolOutput { .. })).count(), before);
    let bad = ask(&h, &a, &format!(r#"mcp render_ui {{"id":"shared:{id}","remove":true}}"#), None).await;
    assert!(bad.starts_with("mcp error:"), "{bad}");

    // ui_get reads it by shared id and through the item.
    let got = mcp_json(&h, &a, &format!(r#"ui_get {{"id":"shared:{id}"}}"#)).await;
    assert_eq!(got["tree"]["root"]["props"]["text"], "v2");
    let got = mcp_json(&h, &a, r#"ui_get {"id":"t"}"#).await;
    assert_eq!((got["input"]["source"].as_str(), got["id"].as_str()), (Some(format!("shared:{id}").as_str()), Some(id.as_str())));

    // A file artifact takes no tree.
    std::fs::write(data.join("sessions").join(&a).join("panels/n.md"), "n").unwrap();
    ask(&h, &a, r#"mcp render_ui {"id":"n","source":"n.md"}"#, None).await;
    let CommandResult::SharedArtifactInfo { meta: md } = h.execute(Command::ShareArtifact { session_id: a.clone(), item_id: "n".into() }).await.unwrap() else {
        panic!()
    };
    let refused = ask(&h, &a, &format!(r#"mcp render_ui {{"id":"shared:{}","root":{{"type":"Markdown"}}}}"#, md.id), None).await;
    assert!(refused.starts_with("mcp error:") && refused.contains("not a render_ui tree"), "{refused}");
}

#[tokio::test(flavor = "multi_thread")]
async fn artifact_state_is_logged_only_in_the_acting_session() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let h = shared_harness(&data);
    let a = create(&h, dir.path(), vec![]).await;
    let b = create(&h, dir.path(), vec![]).await;
    let CommandResult::SharedArtifactInfo { meta } =
        h.execute(Command::ShareMarkdown { session_id: a.clone(), markdown: "# Notes".into(), title: Some("Notes".into()), origin: None }).await.unwrap()
    else {
        panic!()
    };
    let id = meta.id;
    let denied = ask(&h, &b, &format!(r#"mcp state_get {{"artifact":"{id}"}}"#), None).await;
    assert!(denied.starts_with("mcp error:") && denied.contains("not attached"), "{denied}");
    h.execute(Command::AttachSharedArtifact { session_id: b.clone(), id: id.clone() }).await.unwrap();

    let r = ask(&h, &a, &format!(r#"mcp state_patch {{"artifact":"{id}","ops":[{{"op":"add","path":"/done","value":true}}]}}"#), None).await;
    assert!(r.contains("\"done\": true"), "{r}");
    let got = ask(&h, &b, &format!(r#"mcp state_get {{"artifact":"{id}","statePath":"/done"}}"#), None).await;
    assert!(got.starts_with("mcp: true"), "{got}");
    let CommandResult::State { state } = h.execute(Command::GetState { session_id: a.clone() }).await.unwrap() else { panic!() };
    assert_eq!(state, serde_json::json!({}), "the Session State is untouched");

    let changes = |sid: &str| shared_events(&h, sid).into_iter().filter(|k| matches!(k, EventKind::ArtifactStateChanged { .. })).count();
    assert_eq!((changes(&a), changes(&b)), (1, 0));
    // The user, in Session B, then with no Session.
    let op = |v: i64| vec![StatePatchOp::Add { path: "/n".into(), value: serde_json::json!(v) }];
    h.execute(Command::PatchArtifactState { id: id.clone(), ops: op(1), session_id: Some(b.clone()) }).await.unwrap();
    let CommandResult::State { state } = h.execute(Command::PatchArtifactState { id: id.clone(), ops: op(2), session_id: None }).await.unwrap() else {
        panic!()
    };
    assert_eq!(state, serde_json::json!({ "done": true, "n": 2 }));
    assert_eq!((changes(&a), changes(&b)), (1, 1));
}

#[tokio::test(flavor = "multi_thread")]
async fn harness_info_lists_shared_artifacts_and_deleting_a_session_detaches_it() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let h = shared_harness(&data);
    let a = create(&h, dir.path(), vec![]).await;
    let b = create(&h, dir.path(), vec![]).await;
    let CommandResult::SharedArtifactInfo { meta } = h
        .execute(Command::ShareMarkdown { session_id: a.clone(), markdown: "# Map".into(), title: Some("Architecture map".into()), origin: None })
        .await
        .unwrap()
    else {
        panic!()
    };
    h.execute(Command::AttachSharedArtifact { session_id: b.clone(), id: meta.id.clone() }).await.unwrap();
    let context = ask(&h, &b, "show-context", None).await;
    assert!(context.contains(&format!("- Attached Shared Artifact: \"Architecture map\" (`{}`", meta.id)), "{context}");
    let info = mcp_json(&h, &b, "harness_info {}").await;
    let folder = data.join("shared").join(&meta.id);
    assert_eq!(
        info["shared"],
        serde_json::json!([{ "id": meta.id, "title": "Architecture map", "kind": "md", "dir": folder.display().to_string(), "file": "content.md" }])
    );

    let changed = Arc::new(Mutex::new(0));
    let c = changed.clone();
    h.subscribe_app(Box::new(move |e: &AppEvent| {
        if matches!(e, AppEvent::SharedArtifactsChanged) {
            *c.lock().unwrap() += 1;
        }
        true
    }));
    h.execute(Command::DeleteSession { session_id: a.clone(), force: true }).await.unwrap();
    assert_eq!(shared_meta(&h, &meta.id).attached, vec![b.clone()], "the artifact stays, without the deleted Session");
    assert!(*changed.lock().unwrap() >= 1);

    // Deleting the artifact: the item's Session sees it missing.
    h.execute(Command::DeleteSharedArtifact { id: meta.id.clone() }).await.unwrap();
    assert!(!folder.exists());
    let info = mcp_json(&h, &b, "harness_info {}").await;
    assert!(info["shared"][0]["errors"][0].as_str().unwrap().contains("missing"), "{info}");
    h.execute(Command::DetachSharedArtifact { session_id: b.clone(), id: meta.id.clone() }).await.unwrap();
    assert_eq!(mcp_json(&h, &b, "harness_info {}").await["shared"], serde_json::json!([]));
}

#[tokio::test(flavor = "multi_thread")]
async fn task_commands_send_tasks_changed_with_the_changed_ids_and_summaries() {
    use harness_core::api::{TaskPatch, TaskStatus};
    let dir = tempfile::tempdir().unwrap();
    let h = shared_harness(&dir.path().join("data"));
    let a = create(&h, dir.path(), vec![]).await;
    // Per event: the ids, then (id, title, status, parent) of each summary.
    type Row = (String, String, TaskStatus, Option<String>);
    type Seen = Vec<(Vec<String>, Vec<Row>)>;
    let seen: Arc<Mutex<Seen>> = Arc::new(Mutex::new(Vec::new()));
    let s = seen.clone();
    h.subscribe_app(Box::new(move |e: &AppEvent| {
        if let AppEvent::TasksChanged { ids, tasks } = e {
            let rows = tasks.iter().map(|t| (t.id.clone(), t.title.clone(), t.status, t.parent_id.clone())).collect();
            s.lock().unwrap().push((ids.clone(), rows));
        }
        true
    }));
    let new_task = |title: &str, parent: Option<&str>, session: Option<&str>| Command::CreateTask {
        title: title.into(),
        body: None,
        parent_id: parent.map(Into::into),
        session_id: session.map(Into::into),
        status: None,
        priority: None,
        due: None,
        upstream: None,
        deps: Vec::new(),
        props: Default::default(),
    };
    let row = |id: &str, title: &str, status: TaskStatus, parent: Option<&str>| (id.to_owned(), title.to_owned(), status, parent.map(Into::into));
    let CommandResult::Task { task: topic } = h.execute(new_task("Topic", None, Some(&a))).await.unwrap() else { panic!() };
    assert_eq!(topic.origin_session_id.as_deref(), Some(a.as_str()));
    assert!(topic.origin_title.is_some(), "the origin title is cached");
    let CommandResult::Task { task: child } = h.execute(new_task("Child", Some(&topic.id), None)).await.unwrap() else { panic!() };
    let CommandResult::Task { task: other } = h.execute(new_task("Other", None, None)).await.unwrap() else { panic!() };
    let patch = TaskPatch { title: Some("Topic 2".into()), status: Some(TaskStatus::Done), ..Default::default() };
    h.execute(Command::UpdateTask { id: topic.id.clone(), patch, base_updated_ms: None }).await.unwrap();
    h.execute(Command::MoveTask { id: other.id.clone(), parent_id: Some(topic.id.clone()), before: None }).await.unwrap();
    h.execute(Command::DeleteTask { id: topic.id.clone() }).await.unwrap();
    assert!(h.execute(Command::ReadTask { id: "t99".into() }).await.is_err());
    let CommandResult::Tasks { tasks } = h.execute(Command::ListTasks).await.unwrap() else { panic!() };
    assert_eq!(tasks.iter().map(|t| (t.id.as_str(), t.parent_id.as_deref())).collect::<Vec<_>>(), [(child.id.as_str(), None), (other.id.as_str(), None)]);
    let (t, c, o) = (topic.id.as_str(), child.id.as_str(), other.id.as_str());
    let todo = TaskStatus::Todo;
    assert_eq!(
        *seen.lock().unwrap(),
        [
            (vec![t.to_owned()], vec![row(t, "Topic", todo, None)]),
            (vec![c.to_owned()], vec![row(c, "Child", todo, Some(t))]),
            (vec![o.to_owned()], vec![row(o, "Other", todo, None)]),
            (vec![t.to_owned()], vec![row(t, "Topic 2", TaskStatus::Done, None)]),
            (vec![o.to_owned()], vec![row(o, "Other", todo, Some(t))]),
            // The deleted Task has no summary; its children moved to its parent (top level).
            (vec![t.to_owned(), c.to_owned(), o.to_owned()], vec![row(c, "Child", todo, None), row(o, "Other", todo, None)]),
        ]
    );
    // A deleted Session cannot be an origin.
    h.execute(Command::DeleteSession { session_id: a.clone(), force: true }).await.unwrap();
    assert!(h.execute(new_task("Gone", None, Some(&a))).await.is_err(), "an unknown Session");
}

#[tokio::test(flavor = "multi_thread")]
async fn task_tools_add_with_this_origin_and_change_only_own_tasks() {
    let dir = tempfile::tempdir().unwrap();
    let h = shared_harness(&dir.path().join("data"));
    let a = create(&h, dir.path(), vec![]).await;
    let b = create(&h, dir.path(), vec![]).await;
    let seen = Arc::new(Mutex::new(Vec::new()));
    let s = seen.clone();
    h.subscribe_app(Box::new(move |e: &AppEvent| {
        if let AppEvent::TasksChanged { ids, tasks } = e {
            s.lock().unwrap().push((ids.clone(), tasks.iter().map(|t| (t.id.clone(), t.status)).collect::<Vec<_>>()));
        }
        true
    }));
    let added = mcp_json(&h, &a, r#"task_add {"tasks":[{"title":"Cache target","priority":"high"},{"title":"Skip install","status":"in_progress"}]}"#).await;
    assert_eq!(
        added,
        serde_json::json!({ "tasks": [{ "id": "t1", "title": "Cache target", "status": "todo" }, { "id": "t2", "title": "Skip install", "status": "in_progress" }] })
    );
    let read = |id: &str| {
        let rt = tokio::runtime::Handle::current();
        match tokio::task::block_in_place(|| rt.block_on(h.execute(Command::ReadTask { id: id.into() }))) {
            Ok(CommandResult::Task { task }) => task,
            r => panic!("{r:?}"),
        }
    };
    let t1 = read("t1");
    assert_eq!(t1.origin_session_id.as_deref(), Some(a.as_str()), "the origin is the calling Session");
    assert_eq!((t1.activity[0].by, t1.activity[0].session_id.as_deref()), (StateWriter::Agent, Some(a.as_str())));
    use harness_core::api::TaskStatus;
    let ids = vec!["t1".to_owned(), "t2".to_owned()];
    assert_eq!(*seen.lock().unwrap(), [(ids, vec![("t1".to_owned(), TaskStatus::Todo), ("t2".to_owned(), TaskStatus::InProgress)])]);
    // A bad item creates none.
    let bad = ask(&h, &a, r#"mcp task_add {"tasks":[{"title":"ok"},{"title":" "}]}"#, None).await;
    assert!(bad.contains("mcp error:") && bad.contains("task 2"), "{bad}");
    assert!(h.execute(Command::ReadTask { id: "t3".into() }).await.is_err());
    // An unknown dep id keeps its not_found code, with the position.
    let unknown = ask(&h, &a, r#"mcp task_add {"tasks":[{"title":"ok"},{"title":"x","deps":{"add":[{"id":"t99"}]}}]}"#, None).await;
    assert!(unknown.contains("task 2") && unknown.contains("t99"), "{unknown}");
    // null for an optional field means absent.
    mcp_json(&h, &a, r#"task_add {"tasks":[{"title":"Nulls","due":null,"body":null,"status":null,"priority":null}]}"#).await;
    mcp_json(&h, &a, r#"task_update {"id":"t3","status":"done","due":null,"title":null,"body":null,"priority":null}"#).await;

    // Session b cannot change a's Task; a can, and a move under its own subtask is refused.
    let refused = ask(&h, &b, r#"mcp task_update {"id":"t1","status":"done"}"#, None).await;
    assert!(refused.contains("mcp error:") && refused.contains("Ask the user"), "{refused}");
    assert_eq!(read("t1").status, harness_core::api::TaskStatus::Todo);
    let get = mcp_json(&h, &b, r#"task_get {"id":"t1"}"#).await;
    assert_eq!(get["can_update"], false);
    let updated = mcp_json(&h, &a, r#"task_update {"id":"t2","status":"done","parent":"t1"}"#).await;
    assert_eq!(updated, serde_json::json!({ "tasks": [{ "id": "t2", "title": "Skip install", "status": "done" }] }));
    assert_eq!(read("t2").parent_id.as_deref(), Some("t1"));
    assert_eq!(seen.lock().unwrap().last().unwrap().1, [("t2".to_owned(), TaskStatus::Done)]);
    let cycle = ask(&h, &a, r#"mcp task_update {"id":"t1","parent":"t2"}"#, None).await;
    assert!(cycle.contains("mcp error:") && cycle.contains("subtasks"), "{cycle}");
    // A bad field refuses the whole call: the move in it is not done either, and no event is sent.
    let sent = seen.lock().unwrap().len();
    let bad_due = ask(&h, &a, r#"mcp task_update {"id":"t2","parent":null,"due":"tomorrow"}"#, None).await;
    assert!(bad_due.contains("mcp error:") && bad_due.contains("not a date"), "{bad_due}");
    assert_eq!(read("t2").parent_id.as_deref(), Some("t1"), "the move is not done");
    assert_eq!(seen.lock().unwrap().len(), sent);
    let get = mcp_json(&h, &a, r#"task_get {"id":"t1"}"#).await;
    assert_eq!((get["can_update"].clone(), get["subtasks"][0]["id"].clone()), (serde_json::json!(true), serde_json::json!("t2")));

    // Lists: this Session's by default, all with scope all; harness_info has them and the note path.
    let mine = mcp_json(&h, &b, "task_list {}").await;
    assert_eq!(mine["tasks"], serde_json::json!([]));
    let all = mcp_json(&h, &b, r#"task_list {"scope":"all","status":"open"}"#).await;
    assert_eq!(all["tasks"].as_array().unwrap().iter().map(|t| t["id"].clone()).collect::<Vec<_>>(), [serde_json::json!("t1")]);
    let info = mcp_json(&h, &a, "harness_info {}").await;
    assert_eq!(info["tasks"].as_array().unwrap().len(), 3);
    assert_eq!(info["tasks"][0]["session"], "created_here");
    assert!(info["note_path"].as_str().unwrap().ends_with(&format!("{a}/note.md")), "{info}");

    // A Session started from t1: the link decides, for harness_info, task_list and task_update.
    let start = harness_core::api::TaskStart { id: "t1".into(), include: Default::default(), set_status: None };
    let cmd = Command::CreateSession {
        folder: dir.path().display().to_string(),
        agent_id: "fake".into(),
        frontend_id: "chat".into(),
        title: None,
        branch: None,
        worktree: false,
        new_branch: None,
        pr: None,
        mcp_servers: vec![],
        task: Some(start),
    };
    let Ok(CommandResult::SessionCreated { session_id: c }) = h.execute(cmd).await else { panic!() };
    let info = mcp_json(&h, &c, "harness_info {}").await;
    assert_eq!(info["tasks"], serde_json::json!([{ "id": "t1", "title": "Cache target", "status": "todo", "priority": "high", "session": "started_from" }]));
    assert_eq!(mcp_json(&h, &c, "task_list {}").await["tasks"][0]["session"], "started_from");
    mcp_json(&h, &c, r#"task_update {"id":"t1","status":"in_review"}"#).await;
    assert_eq!(read("t1").status, TaskStatus::InReview);
}

/// Reads a Task through the Command API.
async fn read_task(h: &Harness, id: &str) -> harness_core::api::Task {
    match h.execute(Command::ReadTask { id: id.into() }).await {
        Ok(CommandResult::Task { task }) => task,
        r => panic!("{r:?}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn task_tools_set_deps_and_props_as_changes() {
    use harness_core::api::{TaskDep, TaskDepKind as Kind};
    use serde_json::json;
    let dep = |id: &str, kind| TaskDep { id: id.into(), kind };
    let dir = tempfile::tempdir().unwrap();
    let h = shared_harness(&dir.path().join("data"));
    let a = create(&h, dir.path(), vec![]).await;
    let b = create(&h, dir.path(), vec![]).await;

    // task_add: deps (kind blocks by default) and props.
    mcp_json(&h, &a, r#"task_add {"tasks":[{"title":"Design"}]}"#).await;
    mcp_json(&h, &a, r#"task_add {"tasks":[{"title":"Build","deps":{"add":[{"id":"t1"}]},"props":{"component":"api","risk":"yes","gone":null}}]}"#).await;
    let t2 = read_task(&h, "t2").await;
    assert_eq!(t2.deps, [dep("t1", Kind::Blocks)]);
    assert_eq!(serde_json::to_value(&t2.props).unwrap(), json!({ "component": "api", "risk": "yes" }));
    // A Task of another Session: a's Tasks may depend on it.
    mcp_json(&h, &b, r#"task_add {"tasks":[{"title":"Docs"}]}"#).await;
    mcp_json(&h, &a, r#"task_update {"id":"t2","deps":{"add":[{"id":"t3","kind":"follow_up"}]}}"#).await;
    assert_eq!(read_task(&h, "t2").await.deps, [dep("t1", Kind::Blocks), dep("t3", Kind::FollowUp)]);

    // task_get: both directions, and how many open Tasks it waits on.
    let get = mcp_json(&h, &a, r#"task_get {"id":"t2"}"#).await;
    assert_eq!(get["blocked_by"], json!([{ "id": "t1", "title": "Design", "status": "todo" }]));
    assert_eq!(get["waits_on"], 1);
    assert_eq!(get["follows"], json!([{ "id": "t3", "title": "Docs", "status": "todo" }]));
    assert_eq!((get["blocks"].clone(), get["followed_by"].clone()), (json!([]), json!([])));
    assert_eq!(get["props"], json!({ "component": "api", "risk": "yes" }));
    let get = mcp_json(&h, &a, r#"task_get {"id":"t1"}"#).await;
    assert_eq!((get["blocks"].clone(), get["waits_on"].clone()), (json!([{ "id": "t2", "title": "Build", "status": "todo" }]), json!(0)));
    assert_eq!(mcp_json(&h, &b, r#"task_get {"id":"t3"}"#).await["followed_by"], json!([{ "id": "t2", "title": "Build", "status": "todo" }]));
    // task_list rows: waits_on only while above 0, props when there are any.
    let row = |list: &serde_json::Value, id: &str| list["tasks"].as_array().unwrap().iter().find(|t| t["id"] == id).unwrap().clone();
    let list = mcp_json(&h, &a, "task_list {}").await;
    assert_eq!((row(&list, "t2")["waits_on"].clone(), row(&list, "t2")["props"]["component"].clone()), (json!(1), json!("api")));
    assert!(row(&list, "t1").get("waits_on").is_none() && row(&list, "t1").get("props").is_none(), "{list}");
    mcp_json(&h, &a, r#"task_update {"id":"t1","status":"done"}"#).await;
    assert!(row(&mcp_json(&h, &a, "task_list {}").await, "t2").get("waits_on").is_none(), "a done blocker holds nothing up");
    assert_eq!(mcp_json(&h, &a, r#"task_get {"id":"t2"}"#).await["waits_on"], 0);

    // task_update: a dep added again takes the new kind; remove drops one; props merge, null removes.
    mcp_json(&h, &a, r#"task_update {"id":"t2","deps":{"add":[{"id":"t1","kind":"follow_up"}],"remove":["t3"]},"props":{"risk":null,"owner":"ana"}}"#).await;
    let t2 = read_task(&h, "t2").await;
    assert_eq!(t2.deps, [dep("t1", Kind::FollowUp)]);
    assert_eq!(serde_json::to_value(&t2.props).unwrap(), json!({ "component": "api", "owner": "ana" }));

    // Refused, and nothing written: a loop, removing a dep that is not there, a bad prop key.
    let before = read_task(&h, "t1").await;
    let looped = ask(&h, &a, r#"mcp task_update {"id":"t1","deps":{"add":[{"id":"t2"}]}}"#, None).await;
    assert!(looped.contains("mcp error:") && looped.contains("loop"), "{looped}");
    let missing = ask(&h, &a, r#"mcp task_update {"id":"t2","deps":{"remove":["t3"]},"status":"done"}"#, None).await;
    assert!(missing.contains("mcp error:") && missing.contains("not a dependency"), "{missing}");
    let bad_key = ask(&h, &a, r#"mcp task_update {"id":"t2","props":{"Bad Key":"x"}}"#, None).await;
    assert!(bad_key.contains("mcp error:") && bad_key.contains("prop key"), "{bad_key}");
    assert_eq!(read_task(&h, "t1").await, before);
    assert_eq!(read_task(&h, "t2").await, t2);

    // Input that does not match the schema is refused with the path, not ignored.
    for (call, path) in [
        (r#"task_update {"id":"t2","parent":5}"#, "/parent"),
        (r#"task_update {"id":"t2","deps":{"add":["t1"]}}"#, "/deps/add/0"),
        (r#"task_update {"id":"t2","deps":{"add":[{"id":"t1","kind":"after"}]}}"#, "/deps/add/0/kind"),
        (r#"task_update {"id":"t2","deps":["t1"]}"#, "/deps"),
        (r#"task_update {"id":"t2","props":{"risk":5}}"#, "/props/risk"),
        (r#"task_add {"tasks":[{"title":"x","deps":{"remove":["t1"]}}]}"#, "/tasks/0/deps"),
        (r#"task_get {"id":3}"#, "/id"),
    ] {
        let reply = ask(&h, &a, &format!("mcp {call}"), None).await;
        assert!(reply.contains("mcp error:") && reply.contains("invalid input for") && reply.contains(path), "{call}: {reply}");
    }
    // H15: a parent that is not a string no longer moves the Task to the top level.
    mcp_json(&h, &a, r#"task_update {"id":"t2","parent":"t1"}"#).await;
    let reply = ask(&h, &a, r#"mcp task_update {"id":"t2","parent":true}"#, None).await;
    assert!(reply.contains("mcp error:"), "{reply}");
    assert_eq!(read_task(&h, "t2").await.parent_id.as_deref(), Some("t1"));
    assert!(h.execute(Command::ReadTask { id: "t4".into() }).await.is_err(), "the refused task_add created nothing");
}

/// The ids of each `TasksChanged`, with (id, parent) of each summary.
type TaskEvents = Arc<Mutex<Vec<(Vec<String>, Vec<(String, Option<String>)>)>>>;

fn task_events(h: &Harness) -> TaskEvents {
    let seen: TaskEvents = Arc::new(Mutex::new(Vec::new()));
    let s = seen.clone();
    h.subscribe_app(Box::new(move |e: &AppEvent| {
        if let AppEvent::TasksChanged { ids, tasks } = e {
            s.lock().unwrap().push((ids.clone(), tasks.iter().map(|t| (t.id.clone(), t.parent_id.clone())).collect()));
        }
        true
    }));
    seen
}

#[tokio::test(flavor = "multi_thread")]
async fn a_task_add_stopped_by_a_write_error_tells_the_windows_about_the_tasks_it_created() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let h = shared_harness(&data);
    let a = create(&h, dir.path(), vec![]).await;
    let seen = task_events(&h);
    // A file where the second Task's folder goes: its write fails.
    std::fs::write(data.join("tasks").join("t2"), "").unwrap();
    let reply = ask(&h, &a, r#"mcp task_add {"tasks":[{"title":"one"},{"title":"two"},{"title":"three"}]}"#, None).await;
    assert!(reply.contains("mcp error:") && reply.contains("created t1 before this error") && reply.contains("task 2"), "{reply}");
    assert!(h.execute(Command::ReadTask { id: "t1".into() }).await.is_ok());
    assert_eq!(*seen.lock().unwrap(), [(vec!["t1".to_owned()], vec![("t1".to_owned(), None)])]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failed_delete_still_tells_the_windows_about_the_moved_children() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let h = shared_harness(&data);
    let new_task = |title: &str, parent: Option<&str>| Command::CreateTask {
        title: title.into(),
        body: None,
        parent_id: parent.map(Into::into),
        session_id: None,
        status: None,
        priority: None,
        due: None,
        upstream: None,
        deps: Vec::new(),
        props: Default::default(),
    };
    let CommandResult::Task { task: top } = h.execute(new_task("top", None)).await.unwrap() else { panic!() };
    let CommandResult::Task { task: child } = h.execute(new_task("child", Some(&top.id))).await.unwrap() else { panic!() };
    let seen = task_events(&h);
    // The child's folder stays writable; removing the Task's own folder fails.
    let tasks_dir = data.join("tasks");
    std::fs::set_permissions(&tasks_dir, std::fs::Permissions::from_mode(0o555)).unwrap();
    let deleted = h.execute(Command::DeleteTask { id: top.id.clone() }).await;
    std::fs::set_permissions(&tasks_dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(deleted.is_err());
    let events = seen.lock().unwrap().clone();
    assert_eq!(events.len(), 1, "{events:?}");
    assert_eq!(events[0].0, [top.id.clone(), child.id.clone()]);
    assert!(events[0].1.contains(&(child.id.clone(), None)), "the child moved to the top level: {events:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_session_note_sends_note_changed_and_goes_with_its_session() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let h = shared_harness(&data);
    let a = create(&h, dir.path(), vec![]).await;
    let seen = Arc::new(Mutex::new(Vec::new()));
    let s = seen.clone();
    h.subscribe_app(Box::new(move |e: &AppEvent| {
        if let AppEvent::NoteChanged { session_id } = e {
            s.lock().unwrap().push(session_id.clone());
        }
        true
    }));
    let CommandResult::Note { note } = h.execute(Command::ReadNote { session_id: a.clone() }).await.unwrap() else { panic!() };
    let write = Command::WriteNote { session_id: a.clone(), content: "notes".into(), base_hash: Some(note.hash) };
    let CommandResult::Note { note } = h.execute(write).await.unwrap() else { panic!() };
    assert_eq!(note.content, "notes");
    let session_dir = data.join("sessions").join(&a);
    assert!(session_dir.join("note.md").is_file());
    assert_eq!(*seen.lock().unwrap(), std::slice::from_ref(&a));
    let png = harness_core::api::AttachmentInput::Data { name: "a.png".into(), mime: "image/png".into(), data: "eA==".into() };
    let CommandResult::Note { note } = h.execute(Command::AddNoteImages { session_id: a.clone(), files: vec![png] }).await.unwrap() else { panic!() };
    let remove = Command::RemoveNoteImage { session_id: a.clone(), path: note.images[0].clone() };
    let CommandResult::Note { note } = h.execute(remove).await.unwrap() else { panic!() };
    assert!(note.images.is_empty());
    assert_eq!(seen.lock().unwrap().len(), 3, "written, image added, image removed");
    h.execute(Command::DeleteSession { session_id: a.clone(), force: true }).await.unwrap();
    assert!(!session_dir.join("note.md").exists(), "the note is deleted with its Session");
    assert!(h.execute(Command::ReadNote { session_id: a.clone() }).await.is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_watcher_reports_shared_artifact_changes() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let h = shared_harness(&data);
    let a = create(&h, dir.path(), vec![]).await;
    let CommandResult::SharedArtifactInfo { meta } =
        h.execute(Command::ShareMarkdown { session_id: a.clone(), markdown: "# One".into(), title: Some("Notes".into()), origin: None }).await.unwrap()
    else {
        panic!()
    };
    tokio::time::sleep(Duration::from_millis(900)).await;
    let seen = Arc::new(Mutex::new(Vec::new()));
    let s = seen.clone();
    h.subscribe_app(Box::new(move |e: &AppEvent| {
        if let AppEvent::SharedArtifactChanged { id } = e {
            s.lock().unwrap().push(id.clone());
        }
        true
    }));
    // An edit from outside (the Agent's Edit tool, an editor).
    std::fs::write(data.join("shared").join(&meta.id).join("content.md"), "# Two").unwrap();
    tokio::time::sleep(Duration::from_millis(900)).await;
    assert_eq!(*seen.lock().unwrap(), vec![meta.id.clone()]);
    let CommandResult::SharedArtifact { content, .. } = h.execute(Command::SharedArtifactRead { id: meta.id.clone() }).await.unwrap() else { panic!() };
    assert_eq!(content, "# Two");
}

// ---------- Sub Sessions ----------

fn summary(h: &Harness, sid: &str) -> Option<harness_core::api::SessionSummary> {
    let rt = tokio::runtime::Handle::current();
    let CommandResult::Sessions { sessions } = tokio::task::block_in_place(|| rt.block_on(h.execute(Command::ListSessions))).unwrap() else { panic!() };
    sessions.into_iter().find(|s| s.id == sid)
}

/// The Agent's reply to a Thread's prompt.
async fn ask_on(h: &Harness, sid: &str, thread: &str, text: &str) -> String {
    let before = events(h, sid).len();
    h.execute(Command::Prompt { session_id: sid.into(), thread_id: Some(thread.into()), text: text.into(), attachments: vec![], comment_ids: vec![] })
        .await
        .unwrap();
    for _ in 0..800 {
        let evs = events(h, sid);
        let mine = || evs[before..].iter().filter(|e| e.thread_id.as_deref() == Some(thread));
        if own_turn_ended(&evs[before..], text, Some(thread)) {
            return mine()
                .filter_map(|e| match &e.kind {
                    EventKind::AgentMessageChunk { text, .. } => Some(text.as_str()),
                    _ => None,
                })
                .collect();
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("turn did not end");
}

#[tokio::test(flavor = "multi_thread")]
async fn sub_session_start_send_and_wait() {
    let dir = tempfile::tempdir().unwrap();
    let repo = repo(dir.path());
    let h = harness(&dir.path().join("data"), &[]);
    let sid = create(&h, &repo, vec![]).await;

    let started = mcp_json(&h, &sid, r#"session_start {"prompt":"hello","title":"Child","notify":false}"#).await;
    let child = started["session_id"].as_str().unwrap().to_owned();
    assert_eq!(started["title"], "Child");
    assert!(started["branch"].as_str().unwrap().starts_with("harness/"), "a repo folder gets a worktree by default: {started}");
    assert_eq!(started["model"], "a", "the parent's model");
    let parent = summary(&h, &child).unwrap().parent.expect("parent");
    assert_eq!(parent.session_id, sid);
    assert!(summary(&h, &sid).unwrap().parent.is_none());
    let (origin, context) = events(&h, &child)
        .into_iter()
        .find_map(|e| match e.kind {
            EventKind::TurnStarted { origin, context, .. } => Some((origin, context)),
            _ => None,
        })
        .expect("the first prompt is logged before session_start returns");
    assert_eq!(origin.map(|o| o.session_id), Some(sid.clone()));
    let context = context.unwrap();
    assert!(context.contains("Sub Session: the agent of Session") && context.contains("not from the user"), "{context}");

    let done = mcp_json(&h, &sid, &format!(r#"session_wait {{"id":"{child}"}}"#)).await;
    assert_eq!(done["status"], "idle", "{done}");
    assert_eq!(done["stop_reason"], "end_turn");
    assert_eq!(done["reply"], "Working on it. Done.");

    let sent = mcp_json(&h, &sid, &format!(r#"session_send {{"id":"{child}","text":"history"}}"#)).await;
    assert_eq!(sent["session_id"], child.as_str());
    let done = mcp_json(&h, &sid, &format!(r#"session_wait {{"id":"{child}"}}"#)).await;
    assert_eq!(done["reply"], "history: hello");

    // Not offered to a Sub Session (depth 1), nor to a Side Thread.
    let tools = ask(&h, &child, "mcp-list", None).await;
    assert!(!tools.contains("session_"), "{tools}");
    let refused = ask(&h, &child, &format!(r#"mcp session_wait {{"id":"{child}"}}"#), None).await;
    assert!(refused.starts_with("mcp error: session_wait is only available"), "{refused}");
    let CommandResult::ThreadStarted { thread_id, .. } =
        h.execute(Command::StartSideThread { session_id: sid.clone(), seed: None, source: harness_core::api::ThreadStart::Fresh, mode: None }).await.unwrap()
    else {
        panic!()
    };
    let tools = ask_on(&h, &sid, &thread_id, "mcp-list").await;
    assert!(tools.starts_with("tools: ") && !tools.contains("session_"), "{tools}");

    // Only its own children.
    let other = create(&h, &repo, vec![]).await;
    let foreign = ask(&h, &sid, &format!(r#"mcp session_wait {{"id":"{other}"}}"#), None).await;
    assert_eq!(foreign, format!("mcp error: Session {other} is not a Sub Session of this Session"));
    let foreign = ask(&h, &sid, &format!(r#"mcp session_send {{"id":"{other}","text":"x"}}"#), None).await;
    assert!(foreign.contains("is not a Sub Session"), "{foreign}");
}

/// A Sub Session killed mid-Turn (its log ends open) is idle again after a restart, so its parent can send to it.
#[tokio::test(flavor = "multi_thread")]
async fn a_sub_session_killed_mid_turn_can_be_sent_to_after_a_restart() {
    use std::io::Write;
    let dir = tempfile::tempdir().unwrap();
    let repo = repo(dir.path());
    let data = dir.path().join("data");
    let h = harness(&data, &["--resume"]);
    let sid = create(&h, &repo, vec![]).await;
    let started = mcp_json(&h, &sid, r#"session_start {"prompt":"hello","title":"Child","notify":false}"#).await;
    let child = started["session_id"].as_str().unwrap().to_owned();
    mcp_json(&h, &sid, &format!(r#"session_wait {{"id":"{child}"}}"#)).await;
    let evs = events(&h, &child);
    let (seq, thread) = (evs.last().unwrap().seq, evs.iter().find_map(|e| e.thread_id.clone()).unwrap());
    drop(h);
    // The run died right after a Turn started: the log ends open.
    let line = serde_json::json!({
        "v": 1, "seq": seq + 1, "session_id": child, "thread_id": thread,
        "ts_ms": 1, "kind": { "type": "TurnStarted", "turn_id": "killed", "text": "lost", "attachments": [] }
    });
    let mut f = std::fs::OpenOptions::new().append(true).open(data.join("sessions").join(&child).join("log.jsonl")).unwrap();
    writeln!(f, "{line}").unwrap();
    drop(f);

    let h = harness(&data, &["--resume"]);
    let sent = mcp_json(&h, &sid, &format!(r#"session_send {{"id":"{child}","text":"history"}}"#)).await;
    assert_eq!(sent["session_id"], child.as_str(), "{sent}");
    let done = mcp_json(&h, &sid, &format!(r#"session_wait {{"id":"{child}"}}"#)).await;
    assert_eq!(done["status"], "idle", "{done}");
}

#[tokio::test(flavor = "multi_thread")]
async fn sub_session_rules_cap_and_cascade() {
    let dir = tempfile::tempdir().unwrap();
    let repo = repo(dir.path());
    let h = harness(&dir.path().join("data"), &[]);
    let sid = create(&h, &repo, vec![]).await;

    // A call made before the schema was loaded learns the arguments from the error.
    let refused = ask(&h, &sid, r#"mcp session_start {}"#, None).await;
    assert!(refused.starts_with(r#"mcp error: "prompt" is missing. session_start needs "prompt""#), "{refused}");
    let refused = ask(&h, &sid, r#"mcp session_send {"text":"hi"}"#, None).await;
    assert!(refused.starts_with(r#"mcp error: "id" is missing. session_send needs "id""#), "{refused}");
    let refused = ask(&h, &sid, r#"mcp session_start {"prompt":"x","worktree":false,"branch":"main"}"#, None).await;
    assert_eq!(refused, "mcp error: branch needs a worktree: omit worktree or pass worktree: true");
    let refused = ask(&h, &sid, r#"mcp session_start {"prompt":"x","model":"gpt"}"#, None).await;
    assert_eq!(refused, "mcp error: unknown model \"gpt\". Valid: A (a), B (b)");

    let mut children = vec![];
    for _ in 0..4 {
        let started = mcp_json(&h, &sid, r#"session_start {"prompt":"fault-hang","worktree":false,"notify":false}"#).await;
        children.push(started["session_id"].as_str().unwrap().to_owned());
    }
    let child = children[0].clone();
    let busy = ask(&h, &sid, &format!(r#"mcp session_send {{"id":"{child}","text":"hi"}}"#), None).await;
    assert!(busy.starts_with("mcp error: Sub Session") && busy.contains("is still working"), "{busy}");
    let waited = mcp_json(&h, &sid, &format!(r#"session_wait {{"id":"{child}","timeout_s":1}}"#)).await;
    assert_eq!(waited["status"], "working", "{waited}");
    assert!(waited.get("stop_reason").is_none());
    // timeout_s 0 only checks.
    let t = std::time::Instant::now();
    let checked = mcp_json(&h, &sid, &format!(r#"session_wait {{"id":"{child}","timeout_s":0}}"#)).await;
    assert_eq!(checked["status"], "working", "{checked}");
    assert!(t.elapsed() < std::time::Duration::from_millis(900), "{:?}", t.elapsed());
    let listed = mcp_json(&h, &sid, "session_list {}").await;
    let rows = listed["sub_sessions"].as_array().unwrap();
    assert_eq!(rows.iter().map(|r| r["session_id"].as_str().unwrap()).collect::<Vec<_>>(), children, "oldest first");
    assert!(rows.iter().all(|r| r["status"] == "working" && r["archived"] == false), "{listed}");
    let capped = ask(&h, &sid, r#"mcp session_start {"prompt":"x","worktree":false}"#, None).await;
    assert!(capped.starts_with("mcp error: 4 Sub Sessions of this Session are running"), "{capped}");
    assert!(capped.contains("the limit is 4") && capped.contains("Settings"), "{capped}");

    // The limit is a setting: 4 by default, raised, 0 for no limit, lowered.
    use harness_core::api::SubSessionSettings;
    let CommandResult::SubSessionSettings { settings } = h.execute(Command::GetSubSessionSettings).await.unwrap() else { panic!() };
    assert_eq!(settings.max_running, 4);
    let set = |max_running| Command::SetSubSessionSettings { settings: Some(SubSessionSettings { max_running }) };
    assert!(h.execute(set(33)).await.is_err());
    h.execute(set(5)).await.unwrap();
    let started = mcp_json(&h, &sid, r#"session_start {"prompt":"fault-hang","worktree":false,"notify":false}"#).await;
    children.push(started["session_id"].as_str().unwrap().to_owned());
    let capped = ask(&h, &sid, r#"mcp session_start {"prompt":"x","worktree":false}"#, None).await;
    assert!(capped.starts_with("mcp error: 5 Sub Sessions of this Session are running"), "{capped}");
    h.execute(set(0)).await.unwrap();
    let started = mcp_json(&h, &sid, r#"session_start {"prompt":"fault-hang","worktree":false,"notify":false}"#).await;
    children.push(started["session_id"].as_str().unwrap().to_owned());
    h.execute(set(2)).await.unwrap();
    let capped = ask(&h, &sid, r#"mcp session_start {"prompt":"x","worktree":false}"#, None).await;
    assert!(capped.starts_with("mcp error: 6 Sub Sessions of this Session are running") && capped.contains("the limit is 2"), "{capped}");
    h.execute(Command::SetSubSessionSettings { settings: None }).await.unwrap();
    let CommandResult::SubSessionSettings { settings } = h.execute(Command::GetSubSessionSettings).await.unwrap() else { panic!() };
    assert_eq!(settings.max_running, 4, "reset");

    // Archiving, unarchiving and deleting the parent takes its children along.
    h.execute(Command::ArchiveSession { session_id: sid.clone() }).await.unwrap();
    assert!(children.iter().all(|c| summary(&h, c).unwrap().archived));
    h.execute(Command::UnarchiveSession { session_id: sid.clone() }).await.unwrap();
    assert!(children.iter().all(|c| !summary(&h, c).unwrap().archived));
    let other = create(&h, &repo, vec![]).await;
    h.execute(Command::DeleteSession { session_id: sid.clone(), force: false }).await.unwrap();
    assert!(children.iter().all(|c| summary(&h, c).is_none()));
    assert!(summary(&h, &other).is_some(), "other Sessions stay");
}

#[tokio::test(flavor = "multi_thread")]
async fn sub_session_model_overrides_remembered_config_without_saving_it() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let h = harness(&data, &[]);
    let sid = create(&h, dir.path(), vec![]).await;
    ask(&h, &sid, "hi", None).await;
    h.execute(Command::SetConfigOption { session_id: sid.clone(), thread_id: None, config_id: "model".into(), value: "b".into() }).await.unwrap();
    let saved = || std::fs::read_to_string(data.join("agent-config.json")).unwrap();
    let before = saved();
    assert!(before.contains(r#""model": "b""#), "{before}");

    let model_of = |sid: &str| {
        events(&h, sid).into_iter().rev().find_map(|e| match e.kind {
            EventKind::ConfigOptionsChanged { options, .. } => {
                options.as_array().unwrap().iter().find(|o| o["id"] == "model").map(|o| o["currentValue"].clone())
            }
            _ => None,
        })
    };
    let started = mcp_json(&h, &sid, r#"session_start {"prompt":"hi","model":"A","notify":false}"#).await;
    assert_eq!(started["model"], "a");
    let child = started["session_id"].as_str().unwrap().to_owned();
    assert_eq!(model_of(&child), Some(serde_json::json!("a")), "initial_config wins over the remembered model");
    let started = mcp_json(&h, &sid, r#"session_start {"prompt":"hi","notify":false}"#).await;
    assert_eq!(started["model"], "b", "defaults to the parent's model");
    assert_eq!(saved(), before, "agent-config.json is unchanged");
}

#[tokio::test(flavor = "multi_thread")]
async fn sub_session_on_another_agent() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let h = harness(&data, &[]);
    let sid = create(&h, dir.path(), vec![]).await;
    let refused = ask(&h, &sid, r#"mcp session_start {"prompt":"x","agent":"nope"}"#, None).await;
    assert!(refused.contains(r#"unknown agent "nope". Installed: Fake (fake), Other (other)"#), "{refused}");

    let started = mcp_json(&h, &sid, r#"session_start {"prompt":"hi","agent":"OTHER","model":"B","notify":false}"#).await;
    assert_eq!((started["agent"].as_str(), started["model"].as_str()), (Some("Other"), Some("b")), "{started}");
    let child = started["session_id"].as_str().unwrap().to_owned();
    assert_eq!(summary(&h, &child).unwrap().agent_id, "other");
    assert!(!data.join("agent-config.json").exists(), "the model is not remembered");

    // A model the other Agent lacks: the child is removed again.
    let ids = || {
        let CommandResult::Sessions { sessions } =
            tokio::task::block_in_place(|| tokio::runtime::Handle::current().block_on(h.execute(Command::ListSessions))).unwrap()
        else {
            panic!()
        };
        sessions.into_iter().map(|s| s.id).collect::<Vec<_>>()
    };
    let before = ids();
    let refused = ask(&h, &sid, r#"mcp session_start {"prompt":"x","agent":"other","model":"gpt"}"#, None).await;
    assert!(refused.contains(r#"unknown model "gpt""#), "{refused}");
    assert_eq!(ids(), before);
}

#[tokio::test(flavor = "multi_thread")]
async fn share_a_json_panel_as_a_tree() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let h = shared_harness(&data);
    let a = create(&h, dir.path(), vec![]).await;
    let panels = data.join("sessions").join(&a).join("panels");
    ask(&h, &a, r#"mcp state_patch {"ops":[{"op":"add","path":"/todo","value":{"n":2}},{"op":"add","path":"/other","value":1}]}"#, None).await;
    let tree = r#"{"root":{"type":"Text","props":{"text":{"$state":"/todo/n"}}}}"#;
    std::fs::write(panels.join("todo.json"), tree).unwrap();
    ask(&h, &a, r#"mcp render_ui {"id":"t","placement":"right","title":"Todo","source":"todo.json"}"#, None).await;

    let shared = mcp_json(&h, &a, r#"artifact_share {"id":"t"}"#).await;
    assert_eq!((shared["kind"].as_str(), shared["file"].as_str()), (Some("ui"), Some("ui.json")), "{shared}");
    let folder = data.join("shared").join(shared["id"].as_str().unwrap());
    assert_eq!(std::fs::read_to_string(folder.join("ui.json")).unwrap(), tree);
    // Only the state the tree binds goes with it.
    let state: serde_json::Value = serde_json::from_slice(&std::fs::read(folder.join("state.json")).unwrap()).unwrap();
    assert_eq!(state, serde_json::json!({ "todo": { "n": 2 } }));
}

/// Prompts the Harness sent `sid` with news from its Sub Sessions: (text, origin, context).
fn notices(h: &Harness, sid: &str) -> Vec<(String, harness_core::api::PromptOrigin, String)> {
    events(h, sid)
        .into_iter()
        .filter_map(|e| match e.kind {
            EventKind::TurnStarted { text, origin: Some(o), context, .. } if o.kind == harness_core::api::PromptOriginKind::SubSession => {
                Some((text, o, context.unwrap_or_default()))
            }
            _ => None,
        })
        .collect()
}

async fn until(what: &str, mut f: impl FnMut() -> bool) {
    // Only bounds a failure: generous for a loaded machine.
    for _ in 0..1200 {
        if f() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("timed out: {what}");
}

#[tokio::test(flavor = "multi_thread")]
async fn sub_session_news_reach_the_idle_parent() {
    let dir = tempfile::tempdir().unwrap();
    let repo = repo(dir.path());
    let h = harness(&dir.path().join("data"), &[]);
    let sid = create(&h, &repo, vec![]).await;

    // The parent ends its Turn right after the start; the child's Turn ends later or meanwhile.
    let started = mcp_json(&h, &sid, r#"session_start {"prompt":"hello","title":"Child","worktree":false}"#).await;
    let child = started["session_id"].as_str().unwrap().to_owned();
    until("the parent hears the child ended", || notices(&h, &sid).len() == 1).await;
    let (text, origin, context) = notices(&h, &sid).remove(0);
    assert_eq!((origin.session_id.as_str(), origin.title.as_str()), (child.as_str(), "Child"));
    assert!(text.starts_with(&format!("Sub Session \"Child\" (session_id {child}) ended its Turn (end_turn). Its last reply:")), "{text}");
    assert!(text.ends_with("Working on it. Done."), "{text}");
    assert!(context.contains("comes from the Harness, not from the user"), "{context}");
    // The same, structured, for Frontends.
    let [r] = origin.reports.as_slice() else { panic!("{:?}", origin.reports) };
    assert_eq!((r.session_id.as_str(), r.title.as_str(), r.kind), (child.as_str(), "Child", harness_core::api::SubSessionReportKind::Ended));
    assert_eq!((r.stop_reason.as_deref(), r.asked.as_deref()), (Some("end_turn"), Some("hello")));
    assert!(r.reply.as_deref().is_some_and(|t| t.ends_with("Working on it. Done.")), "{r:?}");
    assert!(r.duration_ms.is_some());
    until("the notice Turn ends", || idle(&h, &sid)).await;

    // A Turn the user starts in the child is none of the parent's business.
    ask(&h, &child, "hi", None).await;

    // Waiting for the user, then ending: two notices.
    mcp_json(&h, &sid, &format!(r#"session_send {{"id":"{child}","text":"needs permission"}}"#)).await;
    until("the parent hears the child waits", || notices(&h, &sid).len() == 2).await;
    let (text, origin, _) = notices(&h, &sid).remove(1);
    assert!(text.contains("waits for the user to answer a permission request"), "{text}");
    assert_eq!(origin.reports[0].kind, harness_core::api::SubSessionReportKind::NeedsUser);
    assert_eq!(origin.reports[0].asked.as_deref(), Some("needs permission"));
    let request = until_request(&h, &child).await;
    h.execute(Command::ResolvePermission { session_id: child.clone(), request_id: request, option_id: Some("allow".into()), global: false }).await.unwrap();
    // The fake agent asks for a permission on any prompt that names one, the notice too: answer it.
    let request = until_request(&h, &sid).await;
    h.execute(Command::ResolvePermission { session_id: sid.clone(), request_id: request, option_id: Some("allow".into()), global: false }).await.unwrap();
    until("the parent hears the child ended again", || notices(&h, &sid).len() == 3).await;
    assert!(notices(&h, &sid)[2].0.contains("ended its Turn"));

    // notify: false keeps the parent out of it.
    until("the notice Turn ends", || idle(&h, &sid)).await;
    let quiet = mcp_json(&h, &sid, r#"session_start {"prompt":"hello","worktree":false,"notify":false}"#).await;
    let quiet = quiet["session_id"].as_str().unwrap().to_owned();
    until("the quiet child ends", || idle(&h, &quiet) && events(&h, &quiet).iter().any(|e| matches!(e.kind, EventKind::TurnEnded { .. }))).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(notices(&h, &sid).len(), 3, "{:?}", notices(&h, &sid));
}

/// Every Turn started in `sid` has ended.
fn idle(h: &Harness, sid: &str) -> bool {
    let evs = events(h, sid);
    let n = |end: bool| {
        evs.iter()
            .filter(|e| matches!(e.kind, EventKind::TurnEnded { .. }) == end && matches!(e.kind, EventKind::TurnStarted { .. } | EventKind::TurnEnded { .. }))
            .count()
    };
    n(true) == n(false)
}

/// The latest permission request in `sid` that still waits for an answer (the Policy answers some itself).
async fn until_request(h: &Harness, sid: &str) -> String {
    for _ in 0..400 {
        let log = events(h, sid);
        let pending = log.iter().rev().find_map(|e| match &e.kind {
            EventKind::PermissionRequested { request_id, .. }
                if !log.iter().any(|r| matches!(&r.kind, EventKind::PermissionResolved { request_id: id, .. } if id == request_id)) =>
            {
                Some(request_id.clone())
            }
            _ => None,
        });
        if let Some(id) = pending {
            return id;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("timed out: no pending permission request in {sid}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_running_session_wait_replaces_the_notice() {
    let dir = tempfile::tempdir().unwrap();
    let repo = repo(dir.path());
    let h = harness(&dir.path().join("data"), &[]);
    let sid = create(&h, &repo, vec![]).await;

    // "gated": the child works until the file exists, so it still works when the wait starts, however
    // long the parent takes to get there. The wait runs beside the parent's other Turns.
    let gate = dir.path().join("gate");
    let started = mcp_json(&h, &sid, &format!(r#"session_start {{"prompt":"gated {}","worktree":false}}"#, gate.display())).await;
    let child = started["session_id"].as_str().unwrap().to_owned();
    let waiter = {
        let (h, sid, child) = (h.clone(), sid.clone(), child.clone());
        tokio::spawn(async move { mcp_json(&h, &sid, &format!(r#"session_wait {{"id":"{child}"}}"#)).await })
    };
    until("the wait is under way", || h.sub_session_waits(&child) == 1).await;
    std::fs::write(&gate, "").unwrap();
    let done = waiter.await.unwrap();
    assert_eq!(done["status"], "idle", "{done}");
    assert_eq!(done["reply"], "Working on it. Done.");
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(notices(&h, &sid).is_empty(), "the wait already told the parent: {:?}", notices(&h, &sid));

    // The same kind of Turn without a wait: the parent hears of it.
    mcp_json(&h, &sid, &format!(r#"session_send {{"id":"{child}","text":"slow again"}}"#)).await;
    until("the parent hears the child ended", || notices(&h, &sid).len() == 1).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_notice_that_arrives_during_a_notice_turn_goes_out_without_a_user_prompt() {
    let dir = tempfile::tempdir().unwrap();
    let repo = repo(dir.path());
    let h = harness(&dir.path().join("data"), &[]);
    let sid = create(&h, &repo, vec![]).await;

    // "slow" in the title makes the parent notice Turn slow (the fake agent reads the prompt).
    mcp_json(&h, &sid, r#"session_start {"prompt":"hello","title":"slow first","worktree":false}"#).await;
    until("the first notice Turn starts", || notices(&h, &sid).len() == 1 && !idle(&h, &sid)).await;
    // ... and it is mid-Turn: its first chunk is out and the fake agent now sleeps.
    until("the notice Turn says its first words", || {
        let evs = events(&h, &sid);
        let start = evs.iter().position(|e| matches!(&e.kind, EventKind::TurnStarted { origin: Some(_), .. }));
        start.is_some_and(|i| evs[i..].iter().any(|e| matches!(&e.kind, EventKind::AgentMessageChunk { text, .. } if text.contains("Working on it."))))
    })
    .await;
    // The second child ends while the parent is busy with that Turn.
    mcp_json(&h, &sid, r#"session_start {"prompt":"hello","title":"Second","worktree":false}"#).await;
    until("the parent hears the second child too", || notices(&h, &sid).len() == 2).await;
    assert!(notices(&h, &sid)[1].0.contains("\"Second\""), "{:?}", notices(&h, &sid)[1].0);
    until("the parent is idle", || idle(&h, &sid)).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_reply_is_found_when_another_turn_of_the_thread_still_streams() {
    let dir = tempfile::tempdir().unwrap();
    let repo = repo(dir.path());
    let h = harness(&dir.path().join("data"), &[]);
    let sid = create(&h, &repo, vec![]).await;

    // "slow" says "Working on it." at once and then waits: the next prompt runs beside it, and the
    // chunks of both Turns land in the log (chunks carry no turn id).
    h.execute(Command::Prompt { session_id: sid.clone(), thread_id: None, text: "slow".into(), attachments: vec![], comment_ids: vec![] }).await.unwrap();
    let info = mcp_json(&h, &sid, "harness_info {}").await;
    assert!(info.is_object(), "{info}");
}
