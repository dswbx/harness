//! The stdio shim.

/// `harness mcp-shim`: proxies stdio MCP (one JSON-RPC message per line) to the Harness MCP at
/// `HARNESS_MCP_URL` with `HARNESS_MCP_TOKEN`. Request/response only (no server-initiated streams).
pub async fn run_shim() -> anyhow::Result<()> {
    use futures_util::StreamExt;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
    let url = std::env::var("HARNESS_MCP_URL")?;
    let token = std::env::var("HARNESS_MCP_TOKEN")?;
    let http = crate::http::builder().build()?;
    let mut session: Option<String> = None;
    let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();
    let mut out = tokio::io::stdout();
    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let mut rb =
            http.post(&url).bearer_auth(&token).header("accept", "application/json, text/event-stream").header("content-type", "application/json").body(line);
        if let Some(s) = &session {
            rb = rb.header("mcp-session-id", s);
        }
        let resp = rb.send().await?;
        if let Some(s) = resp.headers().get("mcp-session-id").and_then(|v| v.to_str().ok()) {
            session = Some(s.to_owned());
        }
        let sse = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).is_some_and(|c| c.starts_with("text/event-stream"));
        if sse {
            let mut buf = String::new();
            let mut body = resp.bytes_stream();
            while let Some(chunk) = body.next().await {
                buf.push_str(&String::from_utf8_lossy(&chunk?));
                while let Some(i) = buf.find('\n') {
                    let l: String = buf.drain(..=i).collect();
                    if let Some(data) = l.trim_end().strip_prefix("data:") {
                        let data = data.trim();
                        if !data.is_empty() {
                            out.write_all(format!("{data}\n").as_bytes()).await?;
                            out.flush().await?;
                        }
                    }
                }
            }
        } else {
            let body = resp.text().await?;
            if !body.trim().is_empty() {
                out.write_all(format!("{}\n", body.trim()).as_bytes()).await?;
                out.flush().await?;
            }
        }
    }
    Ok(())
}
