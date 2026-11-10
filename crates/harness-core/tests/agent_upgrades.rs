//! Verified, transactional Agent installs (ADR 0007): sha256 rules, conformance-checked upgrades,
//! rollback and hold. Offline: a file:// registry and archives that run the fake agent.
#![allow(clippy::unwrap_used, reason = "tests fail loudly")]

mod common;
use common::fake_agent_bin;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use harness_core::Harness;
use harness_core::api::{AgentInfo, Command, CommandResult};
use harness_core::host::Options;
use sha2::{Digest, Sha256};

const BAD_PROTOCOL: &str = "@bad-protocol";

struct Env {
    dir: tempfile::TempDir,
    h: Arc<Harness>,
}

impl Env {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let options = Options { registry_url: format!("file://{}", dir.path().join("registry.json").display()), ..Default::default() };
        let h = Harness::with_options(dir.path().join("data"), vec![], options).unwrap();
        Self { dir, h }
    }

    fn data(&self) -> PathBuf {
        self.dir.path().join("data")
    }

    /// Publishes `version` of `fake-acp`, whose binary runs the fake agent with `flags`.
    /// `listed_sha` false leaves the sha256 out of the registry. Returns the archive's sha256.
    async fn publish(&self, version: &str, flags: &str, listed_sha: bool) -> String {
        let root = self.dir.path().join(format!("pkg-{version}"));
        let src = root.join("src/bin");
        std::fs::create_dir_all(&src).unwrap();
        let script = src.join("run");
        let body = if flags == BAD_PROTOCOL {
            // Answers `initialize` with protocol version 0 (the ACP crate does not let the fake agent).
            r#"read line; id=$(printf '%s' "$line" | sed -n 's/.*"id":\("[^"]*"\).*/\1/p'); printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":0,"agentCapabilities":{}}}\n' "$id"; sleep 10"#.to_owned()
        } else {
            format!("exec '{}' {flags} \"$@\"", fake_agent_bin().display())
        };
        std::fs::write(&script, format!("#!/bin/sh\n{body}\n")).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let tgz = root.join("fake.tar.gz");
        let ok = std::process::Command::new("tar").arg("-czf").arg(&tgz).arg("-C").arg(root.join("src")).arg("bin").status().unwrap();
        assert!(ok.success());
        let sha = format!("{:x}", Sha256::digest(std::fs::read(&tgz).unwrap()));
        let mut binary = serde_json::json!({ "archive": format!("file://{}", tgz.display()), "cmd": "./bin/run" });
        if listed_sha {
            binary["sha256"] = sha.clone().into();
        }
        let index = serde_json::json!({
            "version": "1.0.0",
            "agents": [{
                "id": "fake-acp", "name": "Fake", "version": version,
                "distribution": { "binary": { harness_core::toolchain::platform(): binary } }
            }]
        });
        std::fs::write(self.dir.path().join("registry.json"), serde_json::to_vec(&index).unwrap()).unwrap();
        self.h.execute(Command::ListRegistry { refresh: true }).await.unwrap();
        sha
    }

    async fn install(&self, allow_unverified: bool) -> Result<AgentInfo, String> {
        match self.h.execute(Command::InstallAgent { registry_id: "fake-acp".into(), allow_unverified }).await.map_err(|e| e.message)? {
            CommandResult::AgentInstalled { agent } => Ok(agent),
            _ => panic!(),
        }
    }

    async fn agent(&self) -> AgentInfo {
        let CommandResult::Agents { agents } = self.h.execute(Command::ListAgents).await.unwrap() else { panic!() };
        agents.into_iter().find(|a| a.id == "fake-acp").unwrap()
    }

    fn installed_dirs(&self) -> Vec<String> {
        let mut v: Vec<String> =
            std::fs::read_dir(self.data().join("agents/fake-acp")).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }
}

fn exists(p: &Path) -> bool {
    p.exists()
}

#[tokio::test(flavor = "multi_thread")]
async fn install_records_hash_version_and_check() {
    let env = Env::new();
    let sha = env.publish("1.0.0", "", true).await;
    let a = env.install(false).await.unwrap();
    assert_eq!(a.version.as_deref(), Some("1.0.0"));
    assert_eq!(a.install.sha256.as_deref(), Some(sha.as_str()));
    assert!(!a.install.unverified && a.install.previous.is_none() && !a.install.held);
    let check = a.install.check.unwrap();
    assert!(check.passed && !check.auth_required, "{check:?}");
    assert_eq!(check.version.as_deref(), Some("1.0.0"));
    // Persisted with the record.
    assert_eq!(env.agent().await.install.sha256.as_deref(), Some(sha.as_str()));
}

#[tokio::test(flavor = "multi_thread")]
async fn archive_without_sha256_needs_an_explicit_allow() {
    let env = Env::new();
    let sha = env.publish("1.0.0", "", false).await;
    let err = env.install(false).await.unwrap_err();
    assert!(err.contains("cannot be verified"), "{err}");
    assert!(!exists(&env.data().join("agents/fake-acp/1.0.0")));
    let CommandResult::Agents { agents } = env.h.execute(Command::ListAgents).await.unwrap() else { panic!() };
    assert!(agents.is_empty());

    let a = env.install(true).await.unwrap();
    assert!(a.install.unverified);
    assert_eq!(a.install.sha256.as_deref(), Some(sha.as_str()), "the hash is computed even when the registry has none");
}

#[tokio::test(flavor = "multi_thread")]
async fn passing_upgrade_switches_and_keeps_only_the_previous() {
    let env = Env::new();
    env.publish("1.0.0", "", true).await;
    env.install(false).await.unwrap();
    env.publish("2.0.0", "--resume", true).await;
    let a = env.install(false).await.unwrap();
    assert_eq!(a.version.as_deref(), Some("2.0.0"));
    assert!(a.command.ends_with("agents/fake-acp/2.0.0/bin/run"), "{}", a.command);
    assert_eq!(a.install.previous.as_ref().map(|p| p.version.as_str()), Some("1.0.0"));
    assert_eq!(env.installed_dirs(), vec!["1.0.0", "2.0.0"]);

    env.publish("3.0.0", "", true).await;
    let a = env.install(false).await.unwrap();
    assert_eq!(a.install.previous.as_ref().map(|p| p.version.as_str()), Some("2.0.0"));
    assert_eq!(env.installed_dirs(), vec!["2.0.0", "3.0.0"], "older than the previous is removed");
}

#[tokio::test(flavor = "multi_thread")]
async fn failing_upgrade_keeps_the_old_version() {
    let env = Env::new();
    env.publish("1.0.0", "", true).await;
    env.install(false).await.unwrap();

    env.publish("2.0.0", BAD_PROTOCOL, true).await;
    let err = env.install(false).await.unwrap_err();
    assert!(err.contains("conformance check") && err.contains("protocol version"), "{err}");

    let a = env.agent().await;
    assert_eq!(a.version.as_deref(), Some("1.0.0"));
    assert_eq!(env.installed_dirs(), vec!["1.0.0"]);
    let check = a.install.check.unwrap();
    assert!(!check.passed);
    assert_eq!(check.version.as_deref(), Some("2.0.0"), "the refused update is reported");

    // A crash at startup reports the stderr tail.
    env.publish("2.0.1", "--exit", true).await;
    let err = env.install(false).await.unwrap_err();
    assert!(err.contains("exiting on purpose"), "{err}");
    assert_eq!(env.agent().await.version.as_deref(), Some("1.0.0"));
}

#[tokio::test(flavor = "multi_thread")]
async fn first_install_that_fails_the_check_is_not_installed() {
    let env = Env::new();
    env.publish("1.0.0", "--exit", true).await;
    assert!(env.install(false).await.is_err());
    let CommandResult::Agents { agents } = env.h.execute(Command::ListAgents).await.unwrap() else { panic!() };
    assert!(agents.is_empty());
    assert!(!exists(&env.data().join("agents/fake-acp/1.0.0")));
}

#[tokio::test(flavor = "multi_thread")]
async fn auth_required_passes_the_check() {
    let env = Env::new();
    env.publish("1.0.0", "--auth", true).await;
    let check = env.install(false).await.unwrap().install.check.unwrap();
    assert!(check.passed && check.auth_required, "{check:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn rollback_restores_the_previous_version_and_holds_it() {
    let env = Env::new();
    env.publish("1.0.0", "", true).await;
    env.install(false).await.unwrap();
    assert!(env.h.execute(Command::RollbackAgent { agent_id: "fake-acp".into() }).await.is_err(), "nothing to roll back to");
    env.publish("2.0.0", "", true).await;
    env.install(false).await.unwrap();

    let CommandResult::AgentInstalled { agent } = env.h.execute(Command::RollbackAgent { agent_id: "fake-acp".into() }).await.unwrap() else { panic!() };
    assert_eq!(agent.version.as_deref(), Some("1.0.0"));
    assert!(agent.command.ends_with("agents/fake-acp/1.0.0/bin/run"), "{}", agent.command);
    assert!(agent.install.held);
    assert_eq!(agent.install.previous.as_ref().map(|p| p.version.as_str()), Some("2.0.0"));
    assert_eq!(env.agent().await.version.as_deref(), Some("1.0.0"), "persisted");

    // Held, so the registry's 2.0.0 is not installed until released; then it is, again.
    let err = env.install(false).await.unwrap_err();
    assert!(err.contains("held"), "{err}");
    env.h.execute(Command::HoldAgentVersion { agent_id: "fake-acp".into(), hold: false }).await.unwrap();
    assert_eq!(env.install(false).await.unwrap().version.as_deref(), Some("2.0.0"));
}

#[tokio::test(flavor = "multi_thread")]
async fn hold_blocks_updates() {
    let env = Env::new();
    env.publish("1.0.0", "", true).await;
    env.install(false).await.unwrap();
    let CommandResult::AgentInstalled { agent } = env.h.execute(Command::HoldAgentVersion { agent_id: "fake-acp".into(), hold: true }).await.unwrap() else {
        panic!()
    };
    assert!(agent.install.held);
    env.publish("2.0.0", "", true).await;
    let err = env.install(false).await.unwrap_err();
    assert!(err.contains("held at v1.0.0"), "{err}");
    assert_eq!(env.agent().await.version.as_deref(), Some("1.0.0"));
    assert_eq!(env.installed_dirs(), vec!["1.0.0"]);
    assert!(env.h.execute(Command::HoldAgentVersion { agent_id: "nope".into(), hold: true }).await.is_err());
}
