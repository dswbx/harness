//! ACP Registry installs, Custom Agents and Agent auth, offline (file:// registry and archives).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use harness_core::api::{AgentInfo, AgentSource, Command, CommandResult, Event, EventKind, FrontendManifest};
use harness_core::host::Options;
use harness_core::Harness;
use sha2::{Digest, Sha256};

fn fake_agent_bin() -> PathBuf {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let status = std::process::Command::new(env!("CARGO")).args(["build", "-q", "-p", "fake-agent"]).current_dir(&root).status().unwrap();
    assert!(status.success());
    root.join("target/debug/fake-agent").canonicalize().unwrap()
}

fn harness(data: &Path, registry: &Path, fixed: Vec<AgentInfo>) -> Arc<Harness> {
    let options = Options { registry_url: format!("file://{}", registry.display()), ..Default::default() };
    let h = Harness::with_options(data.to_owned(), fixed, options).unwrap();
    h.register_frontend(FrontendManifest { id: "chat".into(), name: "C".into(), version: "0".into(), frontend_tools: vec![] });
    h
}

/// A tar.gz holding `bin/run`, a script that execs the fake agent with `flags`; returns its sha256.
fn archive(dir: &Path, flags: &str) -> (PathBuf, String) {
    let src = dir.join("src/bin");
    std::fs::create_dir_all(&src).unwrap();
    let script = src.join("run");
    std::fs::write(&script, format!("#!/bin/sh\nexec '{}' {flags} \"$@\"\n", fake_agent_bin().display())).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    let tgz = dir.join("fake.tar.gz");
    let ok = std::process::Command::new("tar").arg("-czf").arg(&tgz).arg("-C").arg(dir.join("src")).arg("bin").status().unwrap();
    assert!(ok.success());
    let sha = format!("{:x}", Sha256::digest(std::fs::read(&tgz).unwrap()));
    (tgz, sha)
}

fn registry(dir: &Path, tgz: &Path, sha: &str) -> PathBuf {
    let platform = harness_core::toolchain::platform();
    let index = serde_json::json!({
        "version": "1.0.0",
        "agents": [
            {
                "id": "fake-acp", "name": "Fake", "version": "1.2.3", "description": "scripted",
                "distribution": { "binary": { platform: { "archive": format!("file://{}", tgz.display()), "sha256": sha, "cmd": "./bin/run", "args": ["--resume"] } } }
            },
            { "id": "npm-only", "name": "Npm", "version": "0.1.0", "distribution": { "npx": { "package": "npm-only@0.1.0" } } },
            { "id": "linux-only", "name": "Linux", "version": "0.1.0", "distribution": { "binary": { "linux-x86_64": { "archive": "https://x/y.tgz", "cmd": "./y" } } } },
            { "id": "broken", "name": 42 }
        ]
    });
    let path = dir.join("registry.json");
    std::fs::write(&path, serde_json::to_vec(&index).unwrap()).unwrap();
    path
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

async fn create(h: &Harness, folder: &Path, agent_id: &str) -> String {
    let cmd = Command::CreateSession {
        folder: folder.display().to_string(),
        agent_id: agent_id.into(),
        frontend_id: "chat".into(),
        title: None,
        branch: None,
        worktree: false,
        mcp_servers: vec![],
    };
    let CommandResult::SessionCreated { session_id } = h.execute(cmd).await.unwrap() else { panic!() };
    session_id
}

async fn turn_ends(h: &Harness, sid: &str, text: &str) -> Result<(), String> {
    let before = events(h, sid).len();
    h.execute(Command::Prompt { session_id: sid.into(), thread_id: None, text: text.into(), attachments: vec![] }).await?;
    for _ in 0..400 {
        if events(h, sid)[before..].iter().any(|e| matches!(e.kind, EventKind::TurnEnded { .. })) {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("turn did not end");
}

#[tokio::test(flavor = "multi_thread")]
async fn registry_binary_install_runs_and_survives_restart() {
    let dir = tempfile::tempdir().unwrap();
    let (tgz, sha) = archive(dir.path(), "");
    let reg = registry(dir.path(), &tgz, &sha);
    let data = dir.path().join("data");
    let h = harness(&data, &reg, vec![]);

    let CommandResult::Registry { agents } = h.execute(Command::ListRegistry { refresh: true }).await.unwrap() else { panic!() };
    let methods: Vec<_> = agents.iter().map(|a| (a.id.as_str(), a.install_method.as_deref())).collect();
    assert_eq!(methods, vec![("fake-acp", Some("binary")), ("npm-only", Some("npx")), ("linux-only", None)], "unparseable entries are skipped");

    let CommandResult::AgentInstalled { agent } =
        h.execute(Command::InstallAgent { registry_id: "fake-acp".into() }).await.unwrap()
    else { panic!() };
    assert_eq!((agent.version.as_deref(), &agent.source), (Some("1.2.3"), &AgentSource::Registry { registry_id: "fake-acp".into() }));
    assert!(agent.command.ends_with("agents/fake-acp/1.2.3/bin/run"), "{}", agent.command);

    let sid = create(&h, dir.path(), "fake-acp").await;
    turn_ends(&h, &sid, "hi").await.unwrap();

    // Persisted: a new Harness on the same data dir lists it and the registry marks it installed.
    let h2 = harness(&data, &reg, vec![]);
    let CommandResult::Agents { agents } = h2.execute(Command::ListAgents).await.unwrap() else { panic!() };
    assert_eq!(agents.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), vec!["fake-acp"]);
    let CommandResult::Registry { agents } = h2.execute(Command::ListRegistry { refresh: false }).await.unwrap() else { panic!() };
    assert_eq!(agents[0].installed_version.as_deref(), Some("1.2.3"));

    h2.execute(Command::RemoveAgent { agent_id: "fake-acp".into() }).await.unwrap();
    assert!(!data.join("agents/fake-acp").exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn checksum_mismatch_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let (tgz, _) = archive(dir.path(), "");
    let reg = registry(dir.path(), &tgz, &"0".repeat(64));
    let data = dir.path().join("data");
    let h = harness(&data, &reg, vec![]);
    let err = h.execute(Command::InstallAgent { registry_id: "fake-acp".into() }).await.unwrap_err();
    assert!(err.contains("checksum mismatch"), "{err}");
    let CommandResult::Agents { agents } = h.execute(Command::ListAgents).await.unwrap() else { panic!() };
    assert!(agents.is_empty());
    assert!(!data.join("agents/fake-acp/1.2.3").exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn custom_agent_with_env() {
    let dir = tempfile::tempdir().unwrap();
    let reg = dir.path().join("none.json");
    let h = harness(&dir.path().join("data"), &reg, vec![]);
    let cmd = Command::AddCustomAgent {
        name: "My Fake".into(),
        command: fake_agent_bin().display().to_string(),
        args: vec!["--resume".into()],
        env: [("FAKE_VAR".to_owned(), "1".to_owned())].into(),
    };
    let CommandResult::AgentInstalled { agent } = h.execute(cmd.clone()).await.unwrap() else { panic!() };
    assert_eq!((agent.id.as_str(), agent.source.clone()), ("custom-my-fake", AgentSource::Custom));
    assert!(h.execute(cmd).await.is_err(), "duplicate id");
    let sid = create(&h, dir.path(), "custom-my-fake").await;
    turn_ends(&h, &sid, "hi").await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn auth_required_until_the_user_signs_in() {
    let dir = tempfile::tempdir().unwrap();
    let fake = AgentInfo {
        id: "fake".into(),
        name: "Fake".into(),
        command: fake_agent_bin().display().to_string(),
        args: vec!["--auth".into()],
        env: Default::default(),
        source: AgentSource::Custom,
        version: None,
        icon: None,
    };
    let h = harness(&dir.path().join("data"), &dir.path().join("none.json"), vec![fake]);
    let sid = create(&h, dir.path(), "fake").await;

    let err = turn_ends(&h, &sid, "hi").await.unwrap_err();
    assert!(err.contains("sign in"), "{err}");
    let methods = events(&h, &sid).into_iter().find_map(|e| match e.kind {
        EventKind::AuthRequired { methods, .. } => Some(methods),
        _ => None,
    });
    let methods = methods.expect("AuthRequired");
    assert_eq!(methods.iter().map(|m| (m.id.as_str(), m.kind.as_str())).collect::<Vec<_>>(), vec![("login", "agent"), ("tui", "terminal")]);
    assert!(events(&h, &sid).iter().all(|e| !matches!(e.kind, EventKind::ThreadReadOnly { .. })));

    assert!(h.execute(Command::Authenticate { session_id: sid.clone(), method_id: "nope".into() }).await.is_err());
    h.execute(Command::Authenticate { session_id: sid.clone(), method_id: "login".into() }).await.unwrap();
    turn_ends(&h, &sid, "hi").await.unwrap();
}
