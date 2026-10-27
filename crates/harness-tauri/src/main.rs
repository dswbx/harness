#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `harness mcp-shim`: stdio proxy to the Harness MCP for Agents without HTTP MCP.
    if std::env::args().nth(1).as_deref() == Some("mcp-shim") {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("runtime");
        if let Err(e) = rt.block_on(harness_core::mcp::run_shim()) {
            eprintln!("mcp-shim: {e:#}");
            std::process::exit(1);
        }
        return;
    }
    harness_tauri::run()
}
