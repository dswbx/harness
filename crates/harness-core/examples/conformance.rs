//! Installs the current ACP Registry versions of the given Agents into a temp data dir and runs
//! the headless conformance check on each (an install runs it and refuses a failing version):
//! `cargo run -p harness-core --example conformance -- claude-acp codex-acp`.
//! Exits non-zero if any fails. No sign-in needed: an Agent that asks for it passes.
//! `CONFORMANCE_DATA=<dir>` keeps the install between runs.

use harness_core::agents::{Agents, REGISTRY_URL};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let ids: Vec<String> = std::env::args().skip(1).collect();
    anyhow::ensure!(!ids.is_empty(), "usage: conformance <registry id>...");
    let data = match std::env::var("CONFORMANCE_DATA") {
        Ok(d) => std::path::PathBuf::from(d),
        Err(_) => std::env::temp_dir().join(format!("harness-conformance-{}", std::process::id())),
    };
    std::fs::create_dir_all(&data)?;
    let agents = Agents::open(&data, REGISTRY_URL.to_owned(), vec![])?;
    agents.registry(true).await?;
    let mut failed = false;
    for id in &ids {
        let t = std::time::Instant::now();
        match agents.install(id, false).await {
            Ok(a) => {
                let check = a.install.check.map(|c| format!("passed (sign-in needed: {})", c.auth_required)).unwrap_or_default();
                println!("ok   {id} v{} in {:?}: {check}", a.version.unwrap_or_default(), t.elapsed());
            }
            Err(e) => {
                failed = true;
                println!("FAIL {id}: {e:#}");
            }
        }
    }
    if std::env::var("CONFORMANCE_DATA").is_err() {
        let _ = std::fs::remove_dir_all(&data);
    }
    anyhow::ensure!(!failed, "conformance check failed");
    Ok(())
}
