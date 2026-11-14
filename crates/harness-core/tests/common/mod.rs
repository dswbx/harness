//! Shared by the integration tests.
#![allow(clippy::unwrap_used, reason = "tests fail loudly")]

use std::path::PathBuf;
use std::sync::OnceLock;

/// The `fake-agent` binary, built once per test binary. Tests run in parallel: building it in each
/// test raced, and Agents started while the binary was being written. Cargo reports where it put
/// the binary, so a custom `CARGO_TARGET_DIR` works too.
pub fn fake_agent_bin() -> PathBuf {
    static BIN: OnceLock<PathBuf> = OnceLock::new();
    BIN.get_or_init(|| {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let out =
            std::process::Command::new(env!("CARGO")).args(["build", "-q", "-p", "fake-agent", "--message-format=json"]).current_dir(&root).output().unwrap();
        assert!(out.status.success(), "building fake-agent failed: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
            .find_map(|m| m["executable"].as_str().filter(|_| m["target"]["name"] == "fake-agent").map(PathBuf::from))
            .expect("cargo did not report the fake-agent binary")
    })
    .clone()
}

/// Polls `f` every 10 ms until it holds; panics with `what` after `timeout`. Use it instead of a
/// fixed sleep before a positive assertion. Fixed sleeps are for negative assertions only.
#[allow(dead_code, reason = "not every test binary waits")]
pub async fn wait_until(what: &str, timeout: std::time::Duration, mut f: impl FnMut() -> bool) {
    let deadline = std::time::Instant::now() + timeout;
    while !f() {
        assert!(std::time::Instant::now() < deadline, "timed out after {timeout:?} waiting for {what}");
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
}

/// [`wait_until`] for synchronous code.
#[allow(dead_code, reason = "not every test binary waits")]
pub fn wait_until_blocking(what: &str, timeout: std::time::Duration, mut f: impl FnMut() -> bool) {
    let deadline = std::time::Instant::now() + timeout;
    while !f() {
        assert!(std::time::Instant::now() < deadline, "timed out after {timeout:?} waiting for {what}");
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}
