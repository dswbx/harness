//! Harness MCP end to end: the scripted `fake-agent` is the MCP client (HTTP and stdio shim).

use std::path::{Path, PathBuf};
use std::process::Command as Proc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use harness_core::api::{
    AgentInfo, Command, CommandResult, Event, EventKind, FrontendManifest, StatePatchOp, StateWriter, FrontendToolDecl, McpServerDef, McpTransport,
};
use harness_core::host::Options;
use harness_core::Harness;

fn fake_agent_bin() -> PathBuf {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let status = Proc::new(env!("CARGO")).args(["build", "-q", "-p", "fake-agent"]).current_dir(&root).status().unwrap();
    assert!(status.success());
    root.join("target/debug/fake-agent").canonicalize().unwrap()
}

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
                    .execute(Command::ResolvePermission { session_id: sid.into(), request_id: request_id.clone(), option_id: Some(a.into()) })
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

    let tools = ask(&h, &sid, "mcp-list", None).await;
    assert_eq!(tools, "tools: git_status,git_diff,list_branches,git_commit,git_push,state_get,state_patch,harness_info,json_render");

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
    let asked = events(&h, &sid).into_iter().any(|e| {
        matches!(&e.kind, EventKind::PermissionRequested { tool_call, .. } if tool_call["kind"] == "git_push")
    });
    assert!(asked);
}

#[tokio::test(flavor = "multi_thread")]
async fn frontend_tool_is_validated_and_stored() {
    let dir = tempfile::tempdir().unwrap();
    let h = harness(&dir.path().join("data"), &[]);
    let sid = create(&h, dir.path(), vec![]).await;

    let bad = ask(&h, &sid, r#"mcp json_render {"items":[1]}"#, None).await;
    assert!(bad.starts_with("mcp error: invalid input for json_render"), "{bad}");
    assert!(bad.contains("title"), "names the missing property: {bad}");

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
    let CommandResult::Attachment { mime, data } =
        h.execute(Command::FrontendReadImage { session_id: sid.clone(), path: copy.clone() }).await.unwrap()
    else { panic!() };
    assert_eq!((mime.as_str(), data.as_str()), ("image/png", "cG5n"));
    assert!(h.execute(Command::FrontendReadImage { session_id: sid.clone(), path: path.clone() }).await.is_err(), "not an image");

    let CommandResult::FileContent { content } =
        h.execute(Command::FrontendRead { session_id: sid.clone(), path: path.clone() }).await.unwrap()
    else { panic!() };
    assert_eq!(serde_json::from_str::<serde_json::Value>(&content).unwrap()["title"], "Hi");
    let CommandResult::Files { files } = h.execute(Command::FrontendList { session_id: sid.clone(), dir: String::new() }).await.unwrap()
    else { panic!() };
    assert_eq!(files, vec![copy, path]);
    h.execute(Command::FrontendWrite { session_id: sid.clone(), path: "state/view.json".into(), content: "{}".into() }).await.unwrap();
    assert!(h.execute(Command::FrontendRead { session_id: sid.clone(), path: "../session.json".into() }).await.is_err());
    assert!(h.execute(Command::FrontendWrite { session_id: sid.clone(), path: "/tmp/x".into(), content: "".into() }).await.is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn session_state_and_harness_info() {
    let dir = tempfile::tempdir().unwrap();
    let h = harness(&dir.path().join("data"), &[]);
    let sid = create(&h, dir.path(), vec![]).await;

    let r = ask(&h, &sid, r#"mcp state_patch {"ops":[{"op":"add","path":"/quiz/score","value":0},{"op":"add","path":"/quiz/answers","value":[]}]}"#, None).await;
    assert!(r.starts_with("mcp: {") && r.contains("\"score\": 0"), "{r}");
    let bad = ask(&h, &sid, r#"mcp state_patch {"ops":[{"op":"replace","path":"/quiz/score","value":9},{"op":"test","path":"/quiz/score","value":0}]}"#, None).await;
    assert!(bad.starts_with("mcp error: test failed at /quiz/score"), "{bad}");
    // The user (a bound UI component) changes it too.
    h.execute(Command::PatchState {
        session_id: sid.clone(),
        ops: vec![StatePatchOp::Add { path: "/quiz/answers/-".into(), value: serde_json::json!("B") }],
    })
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
    assert!(done.contains(r#"Live items: [{"tool":"json_render","id":"score","placement":"bottom","title":"a"},{"tool":"json_render","id":"q","placement":"right","title":"b"}]"#), "{done}");
    ask(&h, &sid, r#"mcp json_render {"title":"c","id":"score","remove":true}"#, None).await;
    let info = ask(&h, &sid, "mcp harness_info {}", None).await;
    assert!(info.contains("\"id\": \"q\"") && !info.contains("\"score\"") && info.contains("\"quiz\""), "{info}");
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
    assert!(first.contains(&format!("- Repository: {}", repo.display())) && first.contains("- Worktree: no"), "{first}");
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
    h.execute(Command::ContinueWithSummary { session_id: sid.clone(), thread_id: None, text: None }).await.unwrap();
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
        transport: McpTransport::Stdio {
            command: "/usr/bin/true".into(),
            args: vec![],
            env: [("PLAIN".to_owned(), "1".to_owned())].into(),
        },
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
    let manifest: FrontendManifest =
        serde_json::from_str(include_str!("../../../packages/frontend-chat/manifest.json")).unwrap();
    let tool = manifest.frontend_tools.iter().find(|t| t.name == "render_ui").expect("render_ui");
    let v = jsonschema::options().with_format("harness-image", |_: &str| true).should_validate_formats(true).build(&tool.input_schema).unwrap();
    let errors = |i: serde_json::Value| v.iter_errors(&i).map(|e| format!("{}: {e}", e.instance_path)).collect::<Vec<_>>().join("\n");
    assert_eq!(errors(json!({ "root": { "type": "Stack", "children": [
        { "type": "Card", "props": { "title": "Done", "tone": "success" }, "children": [{ "type": "Markdown", "props": { "text": "ok" } }] },
        { "type": "Carousel", "props": { "images": [{ "src": "a.png", "alt": "A" }] } }
    ] } })), "");
    let e = errors(json!({ "root": { "type": "Stack", "children": [{ "type": "Image", "props": { "alt": "x" } }] } }));
    assert!(e.contains("/root/children/0/props") && e.contains("\"src\" is a required property"), "{e}");
    let e = errors(json!({ "root": { "type": "Badge", "props": { "text": "x", "tone": "loud" } } }));
    assert!(e.contains("/root/props/tone"), "{e}");
    let e = errors(json!({ "root": { "type": "Nope" } }));
    assert!(e.contains("/root/type"), "{e}");
    let e = errors(json!({ "root": { "type": "Markdown", "props": { "text": "x" }, "children": [{ "type": "Markdown", "props": { "text": "y" } }] } }));
    assert!(e.contains("/root/children"), "{e}");
    // Placements, bindings and actions.
    assert_eq!(errors(json!({ "id": "score", "placement": "bottom", "root": { "type": "Stat", "props": { "label": "Score", "value": { "$template": "${/quiz/score} / 5" } } } })), "");
    assert_eq!(errors(json!({ "id": "score", "remove": true })), "");
    assert_eq!(errors(json!({ "root": { "type": "Choice", "props": { "value": { "$bindState": "/a/q1" }, "options": [{ "value": "a", "label": "A" }] },
        "on": { "change": { "action": "sendMessage", "params": { "text": { "$template": "Answer: ${/a/q1}" } } } } } })), "");
    assert!(errors(json!({ "placement": "right", "root": { "type": "Markdown", "props": { "text": "x" } } })).contains("\"id\" is a required property"));
    assert_eq!(errors(json!({ "id": "test", "placement": "right", "title": "Test", "root": { "type": "Stepper", "props": { "steps": ["Q1"] },
        "on": { "finish": { "action": "sendMessage", "params": { "text": "done" } } },
        "children": [{ "type": "Choice", "props": { "value": { "$bindState": "/q/a1" }, "result": { "$bindState": "/q/r/q1" }, "answer": "a", "options": [{ "value": "a", "label": "A" }] } }] } })), "");
    assert_eq!(errors(json!({ "root": { "type": "Stat", "props": { "label": "Score", "value": { "$computed": "count", "args": { "values": { "$state": "/q/r" }, "eq": true } } } } })), "");
    assert!(!errors(json!({ "root": { "type": "Stat", "props": { "label": "S", "value": { "$computed": "average", "args": { "values": [] } } } } })).is_empty());
    assert_eq!(errors(json!({ "root": { "type": "Button", "props": { "label": "Continue" }, "visible": { "$and": [{ "$state": "/q/a1" }, { "$state": "/q/step", "eq": 0 }] } } })), "");
    assert!(!errors(json!({ "root": { "type": "Button", "props": { "label": "x" }, "visible": { "$state": 1 } } })).is_empty());
    assert!(!errors(json!({ "root": { "type": "Button", "props": { "label": "x" }, "on": { "press": { "action": "setState", "params": { "value": 1 } } } } })).is_empty());
}
