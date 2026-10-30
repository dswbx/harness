//! Shared by the integration tests.

use std::path::PathBuf;
use std::sync::OnceLock;

/// The `fake-agent` binary, built once per test binary. Tests run in parallel: building it in each
/// test raced, and Agents started while the binary was being written. Cargo reports where it put
/// the binary, so a custom `CARGO_TARGET_DIR` works too.
pub fn fake_agent_bin() -> PathBuf {
    static BIN: OnceLock<PathBuf> = OnceLock::new();
    BIN.get_or_init(|| {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let out = std::process::Command::new(env!("CARGO"))
            .args(["build", "-q", "-p", "fake-agent", "--message-format=json"])
            .current_dir(&root)
            .output()
            .unwrap();
        assert!(out.status.success(), "building fake-agent failed: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
            .find_map(|m| m["executable"].as_str().filter(|_| m["target"]["name"] == "fake-agent").map(PathBuf::from))
            .expect("cargo did not report the fake-agent binary")
    })
    .clone()
}
