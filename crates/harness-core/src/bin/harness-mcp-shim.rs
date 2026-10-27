//! Stdio MCP shim (see `harness_core::mcp::run_shim`); the app binary has the same as `harness mcp-shim`.

#[tokio::main(flavor = "current_thread")]
async fn main() -> anyhow::Result<()> {
    harness_core::mcp::run_shim().await
}
