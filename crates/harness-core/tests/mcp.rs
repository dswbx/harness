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
    AgentInfo, AppEvent, Command, CommandResult, Decision, Event, EventKind, FrontendAnswer, FrontendImage, FrontendManifest, FrontendToolDecl, McpServerDef,
    McpTransport, NewPermissionRule, Resolver, RuleScope, StatePatchOp, StateWriter,
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
    let h = Harness::with_options(data.to_owned(), vec![agent], options).unwrap();
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
    h.execute(Command::Prompt { session_id: sid.into(), thread_id: None, text: text.into(), attachments: vec![] }).await.unwrap();
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
        if evs[before..].iter().any(|e| matches!(e.kind, EventKind::TurnEnded { .. })) {
            return evs[before..]
                .iter()
                .filter_map(|e| match &e.kind {
                    EventKind::AgentMessageChunk { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect();
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("turn did not end");
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
        "tools: git_status,git_diff,list_branches,git_commit,git_push,state_get,state_patch,harness_info,ui_get,artifact_search,artifact_share,artifact_attach,artifact_detach,threads_list,transcript_outline,transcript_read,transcript_search,json_render"
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
    let CommandResult::PanelSource { content, hash, mtime_ms } = h.execute(read("plan/progress.md")).await.unwrap() else { panic!() };
    assert_eq!(content, "# Progress\n\n- [x] one");
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
    let body = reply.strip_prefix("mcp: ").unwrap_or_else(|| panic!("{call}: {reply}"));
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
