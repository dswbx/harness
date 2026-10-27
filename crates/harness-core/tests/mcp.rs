//! Harness MCP end to end: the scripted `fake-agent` is the MCP client (HTTP and stdio shim).

use std::path::{Path, PathBuf};
use std::process::Command as Proc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use harness_core::api::{
    AgentInfo, Command, CommandResult, Event, EventKind, FrontendManifest, FrontendToolDecl, McpServerDef, McpTransport,
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
        frontend_tools: vec![FrontendToolDecl {
            name: "json_render".into(),
            description: "Render a card".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": { "title": { "type": "string" }, "items": { "type": "array", "items": { "type": "string" } } },
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
    h.execute(Command::Prompt { session_id: sid.into(), thread_id: None, text: text.into() }).await.unwrap();
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
    assert_eq!(tools, "tools: git_status,git_diff,list_branches,git_commit,git_push,json_render");

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

    let ok = ask(&h, &sid, r#"mcp json_render {"title":"Hi","items":["x"]}"#, None).await;
    assert!(ok.starts_with("mcp: Done."), "{ok}");
    let (path, input) = events(&h, &sid)
        .into_iter()
        .find_map(|e| match e.kind {
            EventKind::FrontendToolOutput { path, input, .. } => Some((path, input)),
            _ => None,
        })
        .expect("FrontendToolOutput");
    assert_eq!(input["title"], "Hi");
    assert!(path.starts_with("tools/json_render/") && path.ends_with(".json"));

    let CommandResult::FileContent { content } =
        h.execute(Command::FrontendRead { session_id: sid.clone(), path: path.clone() }).await.unwrap()
    else { panic!() };
    assert_eq!(serde_json::from_str::<serde_json::Value>(&content).unwrap()["title"], "Hi");
    let CommandResult::Files { files } = h.execute(Command::FrontendList { session_id: sid.clone(), dir: String::new() }).await.unwrap()
    else { panic!() };
    assert_eq!(files, vec![path]);
    h.execute(Command::FrontendWrite { session_id: sid.clone(), path: "state/view.json".into(), content: "{}".into() }).await.unwrap();
    assert!(h.execute(Command::FrontendRead { session_id: sid.clone(), path: "../session.json".into() }).await.is_err());
    assert!(h.execute(Command::FrontendWrite { session_id: sid.clone(), path: "/tmp/x".into(), content: "".into() }).await.is_err());
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

/// The chat Frontend's manifest is generated from jsonv-ts; the core's validator must accept it.
#[test]
fn generated_chat_manifest_validates_in_core() {
    let manifest: FrontendManifest =
        serde_json::from_str(include_str!("../../../packages/frontend-chat/manifest.json")).unwrap();
    let tool = manifest.frontend_tools.iter().find(|t| t.name == "json_render").expect("json_render");
    let v = jsonschema::validator_for(&tool.input_schema).unwrap();
    assert!(v.is_valid(&serde_json::json!({ "title": "Done", "tone": "success", "items": [{ "label": "Files", "value": "3" }] })));
    assert!(!v.is_valid(&serde_json::json!({ "body": "no title" })));
    assert!(!v.is_valid(&serde_json::json!({ "title": "x", "tone": "loud" })));
}
