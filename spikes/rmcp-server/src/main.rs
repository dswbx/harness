use std::{collections::HashMap, sync::Arc};

use axum::{extract::State, http::{header, Request, StatusCode}, middleware::{self, Next}, response::Response, Router};
use rmcp::{
    handler::server::{tool::Extension, wrapper::Parameters},
    model::*,
    schemars, tool, tool_handler, tool_router,
    transport::streamable_http_server::{
        session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
    },
    ErrorData, ServerHandler,
};
use serde::Deserialize;

/// Harness session id resolved from bearer token; injected by auth middleware.
#[derive(Clone, Debug)]
struct HarnessSession(String);

#[derive(Clone)]
struct AuthState {
    tokens: Arc<HashMap<String, String>>, // token -> session id
}

#[derive(Deserialize, schemars::JsonSchema)]
struct EchoArgs {
    text: String,
}

#[derive(Clone)]
struct Harness {
    git_dir: String,
}

fn sid(parts: &http::request::Parts) -> String {
    parts.extensions.get::<HarnessSession>().map(|s| s.0.clone()).unwrap_or("?".into())
}

#[tool_router]
impl Harness {
    #[tool(description = "Echo text back")]
    async fn echo(
        &self,
        Extension(parts): Extension<http::request::Parts>,
        Parameters(EchoArgs { text }): Parameters<EchoArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        eprintln!("[tool] echo session={} text={text:?}", sid(&parts));
        Ok(CallToolResult::success(vec![ContentBlock::text(text)]))
    }

    #[tool(description = "Run git status --porcelain in the session workspace")]
    async fn git_status(
        &self,
        Extension(parts): Extension<http::request::Parts>,
    ) -> Result<CallToolResult, ErrorData> {
        eprintln!("[tool] git_status session={}", sid(&parts));
        let out = tokio::process::Command::new("git")
            .args(["status", "--porcelain"])
            .current_dir(&self.git_dir)
            .output()
            .await
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        Ok(CallToolResult::success(vec![ContentBlock::text(String::from_utf8_lossy(&out.stdout).to_string())]))
    }
}

#[tool_handler]
impl ServerHandler for Harness {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_instructions("Harness MCP spike")
    }
}

async fn auth(State(st): State<AuthState>, mut req: Request<axum::body::Body>, next: Next) -> Result<Response, StatusCode> {
    if req.headers().contains_key(header::ORIGIN) {
        eprintln!("[auth] reject: Origin present");
        return Err(StatusCode::FORBIDDEN);
    }
    let tok = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    match tok.and_then(|t| st.tokens.get(t)) {
        Some(s) => {
            req.extensions_mut().insert(HarnessSession(s.clone()));
            Ok(next.run(req).await)
        }
        None => {
            eprintln!("[auth] reject: bad/missing token");
            Err(StatusCode::UNAUTHORIZED)
        }
    }
}

async fn serve(git_dir: String, port: u16) -> anyhow::Result<()> {
    let mut tokens = HashMap::new();
    tokens.insert("tok-session-A".to_string(), "sess-A".to_string());
    tokens.insert("tok-session-B".to_string(), "sess-B".to_string());
    let svc = StreamableHttpService::new(
        move || Ok(Harness { git_dir: git_dir.clone() }),
        Arc::new(LocalSessionManager::default()),
        StreamableHttpServerConfig::default().enforce_origin_validation(),
    );
    let app = Router::new()
        .nest_service("/mcp", svc)
        .layer(middleware::from_fn_with_state(AuthState { tokens: Arc::new(tokens) }, auth));
    let l = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    println!("LISTEN http://{}/mcp", l.local_addr()?);
    axum::serve(l, app).await?;
    Ok(())
}

/// Naive stdio<->HTTP proxy: one JSON-RPC message per line.
async fn shim() -> anyhow::Result<()> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let url = std::env::var("HARNESS_MCP_URL")?;
    let tok = std::env::var("HARNESS_MCP_TOKEN")?;
    let http = reqwest::Client::new();
    let mut session: Option<String> = None;
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut out = tokio::io::stdout();
    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() { continue; }
        let mut rb = http.post(&url).bearer_auth(&tok)
            .header("accept", "application/json, text/event-stream")
            .header("content-type", "application/json")
            .body(line);
        if let Some(s) = &session { rb = rb.header("mcp-session-id", s); }
        let resp = rb.send().await?;
        if let Some(s) = resp.headers().get("mcp-session-id") { session = Some(s.to_str()?.to_string()); }
        let ct = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
        let body = resp.text().await?;
        if ct.starts_with("text/event-stream") {
            for l in body.lines() {
                if let Some(d) = l.strip_prefix("data:") {
                    let d = d.trim();
                    if !d.is_empty() { out.write_all(d.as_bytes()).await?; out.write_all(b"\n").await?; }
                }
            }
        } else if !body.trim().is_empty() {
            out.write_all(body.trim().as_bytes()).await?; out.write_all(b"\n").await?;
        }
        out.flush().await?;
    }
    Ok(())
}

async fn client(url: String, tok: String) -> anyhow::Result<()> {
    use rmcp::{transport::{streamable_http_client::StreamableHttpClientTransportConfig, StreamableHttpClientTransport}, ServiceExt};
    let t = StreamableHttpClientTransport::from_config(StreamableHttpClientTransportConfig::with_uri(url).auth_header(tok));
    let c = ().serve(t).await?;
    println!("tools: {:?}", c.list_all_tools().await?.iter().map(|t| t.name.to_string()).collect::<Vec<_>>());
    let mut a = serde_json::Map::new();
    a.insert("text".into(), "hi from rmcp client".into());
    let r = c.call_tool(CallToolRequestParams::new("echo").with_arguments(a)).await?;
    println!("echo: {r:?}");
    let r = c.call_tool(CallToolRequestParams::new("git_status")).await?;
    println!("git_status: {r:?}");
    c.cancel().await?;
    Ok(())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let a: Vec<String> = std::env::args().collect();
    match a.get(1).map(|s| s.as_str()) {
        Some("mcp-shim") => shim().await,
        Some("env") => { let t = std::time::Instant::now(); let e = login_env().await?; println!("{} vars in {:?}; PATH has git={}", e.len(), t.elapsed(), e["PATH"].contains("/usr/bin")); Ok(()) }
        Some("client") => client(a[2].clone(), a[3].clone()).await,
        _ => serve(std::env::var("GIT_DIR_CWD").unwrap_or(".".into()), std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(0)).await,
    }
}

/// Capture login-shell env. Sentinels guard against rc-file stdout noise.
async fn login_env() -> anyhow::Result<HashMap<String, String>> {
    use std::process::Stdio;
    let shell = std::env::var("SHELL").unwrap_or("/bin/zsh".into());
    let script = "printf '__HS_BEGIN__'; /usr/bin/env -0; printf '__HS_END__'";
    let child = tokio::process::Command::new(&shell)
        .args(["-ilc", script])
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    let out = tokio::time::timeout(std::time::Duration::from_secs(10), child.wait_with_output()).await??;
    let s = String::from_utf8_lossy(&out.stdout);
    let body = s.rsplit_once("__HS_BEGIN__").and_then(|(_, r)| r.split_once("__HS_END__")).map(|(b, _)| b)
        .ok_or_else(|| anyhow::anyhow!("sentinels not found"))?;
    Ok(body.split('\0').filter_map(|kv| kv.split_once('=')).map(|(k, v)| (k.into(), v.into())).collect())
}
