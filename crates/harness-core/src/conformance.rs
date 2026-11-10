//! Headless conformance check of an Agent version (ADR 0007): spawn it the way Sessions do, in a
//! throwaway HOME and folder, `initialize` (protocol version 1), then `session/new`. A sign-in
//! requirement from `session/new` passes: the user may not be signed in, and the process and
//! protocol work.

use std::collections::VecDeque;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::schema::v1 as acp;
use agent_client_protocol::{AcpAgent, Agent, Client, ConnectionTo, ErrorCode, LineDirection};
use parking_lot::Mutex;

use crate::api::{AgentInfo, ConformanceCheck};

/// How long an Agent gets to answer, in total.
pub const CHECK_TIMEOUT: Duration = Duration::from_secs(60);

const STDERR_TAIL: usize = 30;

enum Outcome {
    Passed { auth_required: bool },
    Failed(String),
}

/// Runs the check on `spec` with the toolchain `path`. Never panics or errors: a failure is in the result.
pub async fn check(spec: &AgentInfo, path: &str, timeout: Duration) -> ConformanceCheck {
    let root = std::env::temp_dir().join(format!("harness-check-{}", uuid::Uuid::now_v7()));
    let outcome = match prepare(&root) {
        Ok(()) => run(spec, path, &root, timeout).await,
        Err(e) => Outcome::Failed(format!("could not prepare the check folder: {e}")),
    };
    let _ = std::fs::remove_dir_all(&root);
    let at_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let (passed, auth_required, error) = match outcome {
        Outcome::Passed { auth_required } => (true, auth_required, None),
        Outcome::Failed(e) => (false, false, Some(e)),
    };
    ConformanceCheck { version: spec.version.clone(), passed, auth_required, error, at_ms }
}

fn prepare(root: &Path) -> std::io::Result<()> {
    for d in ["home", "home/.config", "home/.local/share", "home/.cache", "home/.local/state", "folder"] {
        std::fs::create_dir_all(root.join(d))?;
    }
    Ok(())
}

async fn run(spec: &AgentInfo, path: &str, root: &Path, timeout: Duration) -> Outcome {
    let home = root.join("home");
    let overrides: Vec<(String, String)> = [
        ("HOME", home.clone()),
        ("XDG_CONFIG_HOME", home.join(".config")),
        ("XDG_DATA_HOME", home.join(".local/share")),
        ("XDG_CACHE_HOME", home.join(".cache")),
        ("XDG_STATE_HOME", home.join(".local/state")),
        ("TMPDIR", root.to_owned()),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v.display().to_string()))
    .collect();
    let args = crate::acp::launch_args(spec, path, &overrides);

    let tail: Arc<Mutex<VecDeque<String>>> = Default::default();
    let agent = AcpAgent::new(agent_client_protocol::AcpAgentConfig::new("/usr/bin/env").args(args)).with_debug({
        let tail = tail.clone();
        move |line, dir| {
            if matches!(dir, LineDirection::Stderr) {
                let mut t = tail.lock();
                if t.len() == STDERR_TAIL {
                    t.pop_front();
                }
                t.push_back(line.to_owned());
            }
        }
    });

    let outcome: Arc<Mutex<Option<Outcome>>> = Default::default();
    let cwd = root.join("folder");
    let out = outcome.clone();
    let connection = Client.builder().name("harness-check").connect_with(agent, |cx: ConnectionTo<Agent>| async move {
        let result = handshake(&cx, cwd).await;
        *out.lock() = Some(result);
        Ok(())
    });
    // Dropping the connection kills the Agent and its process group.
    let finished = tokio::time::timeout(timeout, connection).await;
    let result = outcome.lock().take();
    let reason = match (result, finished) {
        (Some(Outcome::Passed { auth_required }), _) => return Outcome::Passed { auth_required },
        (Some(Outcome::Failed(e)), _) => e,
        (None, Err(_)) => format!("no answer within {} s", timeout.as_secs()),
        (None, Ok(Err(e))) => format!("the Agent exited during startup: {e}"),
        (None, Ok(Ok(()))) => "the Agent exited during startup".to_owned(),
    };
    // Give stderr a moment to arrive; it usually explains the failure.
    tokio::time::sleep(Duration::from_millis(100)).await;
    Outcome::Failed(crate::acp::with_tail(reason, &tail))
}

async fn handshake(cx: &ConnectionTo<Agent>, cwd: std::path::PathBuf) -> Outcome {
    let init = match cx.send_request(acp::InitializeRequest::new(ProtocolVersion::V1)).block_task().await {
        Ok(i) => i,
        Err(e) => return Outcome::Failed(format!("initialize failed: {e}")),
    };
    if init.protocol_version != ProtocolVersion::V1 {
        return Outcome::Failed(format!("the Agent answered protocol version {}, expected 1", init.protocol_version));
    }
    match cx.send_request(acp::NewSessionRequest::new(cwd)).block_task().await {
        Ok(_) => Outcome::Passed { auth_required: false },
        Err(e) if e.code == ErrorCode::AuthRequired => Outcome::Passed { auth_required: true },
        Err(e) => Outcome::Failed(format!("session/new failed: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::AgentSource;

    fn spec(command: &str, args: &[&str]) -> AgentInfo {
        AgentInfo {
            id: "t".into(),
            name: "T".into(),
            command: command.into(),
            args: args.iter().map(|a| (*a).to_owned()).collect(),
            env: Default::default(),
            source: AgentSource::Custom,
            version: Some("1".into()),
            icon: None,
            install: Default::default(),
        }
    }

    #[tokio::test]
    async fn an_agent_that_never_answers_times_out() {
        let r = check(&spec("/bin/sleep", &["30"]), "/usr/bin:/bin", Duration::from_secs(1)).await;
        assert!(!r.passed);
        assert!(r.error.unwrap().contains("no answer within 1 s"));
    }

    #[tokio::test]
    async fn protocol_version_other_than_1_fails() {
        let script = r#"read line; id=$(printf '%s' "$line" | sed -n 's/.*"id":\("[^"]*"\).*/\1/p'); printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":0,"agentCapabilities":{}}}\n' "$id"; sleep 10"#;
        let r = check(&spec("/bin/sh", &["-c", script]), "/usr/bin:/bin", Duration::from_secs(10)).await;
        assert!(!r.passed);
        let e = r.error.unwrap();
        assert!(e.contains("protocol version 0"), "{e}");
    }

    #[tokio::test]
    async fn a_missing_command_fails() {
        let r = check(&spec("/nonexistent/agent", &[]), "/usr/bin:/bin", Duration::from_secs(10)).await;
        assert!(!r.passed);
    }
}
