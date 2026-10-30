//! Harness MCP (ADR 0011): an in-process MCP server on loopback HTTP that gives Agents the
//! Harness Primitives and their Session's Frontend Tools. Each Agent Session gets a bearer token
//! naming its Session and Thread; requests with an `Origin` header are refused. Agents without
//! HTTP MCP reach it through `run_shim` (stdio).

/// The Harness MCP tool a tool call title names: `mcp__harness__git_status` (Claude) or
/// `mcp.harness.git_status` (Codex) -> `git_status`. Agents name MCP tools their own way; this
/// knows only how they name ours.
pub fn harness_tool_name(title: &str) -> Option<&str> {
    ["mcp__harness__", "mcp.harness."].iter().find_map(|p| title.strip_prefix(p)).filter(|n| !n.is_empty())
}

use std::collections::HashMap;
use std::sync::{Arc, RwLock, Weak};

use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::Response;
use rmcp::handler::server::ServerHandler;
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, ListToolsResult, PaginatedRequestParams,
    ServerCapabilities, ServerConfig, Tool,
};
use rmcp::service::{RequestContext, RoleServer};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::ErrorData;
use serde_json::{json, Map, Value};

use crate::api::ThreadId;
use crate::session::Session;

#[derive(Clone)]
struct Target {
    session: Weak<Session>,
    thread: ThreadId,
}

type Tokens = Arc<RwLock<HashMap<String, Target>>>;

#[derive(Default)]
pub struct HarnessMcp {
    tokens: Tokens,
    url: tokio::sync::OnceCell<String>,
}

impl HarnessMcp {
    /// The server's URL, starting it on first use.
    pub async fn url(&self) -> anyhow::Result<String> {
        let tokens = self.tokens.clone();
        self.url
            .get_or_try_init(|| async move {
                let svc = StreamableHttpService::new(
                    || Ok(Handler),
                    Arc::new(LocalSessionManager::default()),
                    // No allowed origins: any Origin header is refused (browsers always send one).
                    StreamableHttpServerConfig::default().enforce_origin_validation(),
                );
                let app = axum::Router::new()
                    .nest_service("/mcp", svc)
                    .layer(axum::middleware::from_fn_with_state(tokens, auth));
                let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
                let addr = listener.local_addr()?;
                tokio::spawn(async move {
                    if let Err(e) = axum::serve(listener, app).await {
                        tracing::error!("harness mcp server stopped: {e}");
                    }
                });
                anyhow::Ok(format!("http://{addr}/mcp"))
            })
            .await
            .cloned()
    }

    /// A fresh token for one Agent Session of a Thread.
    pub fn issue(&self, session: &Arc<Session>, thread: &ThreadId) -> String {
        let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
        self.tokens
            .write()
            .unwrap()
            .insert(token.clone(), Target { session: Arc::downgrade(session), thread: thread.clone() });
        token
    }

    /// Forgets every token of a Session (its Agent process ended).
    pub fn revoke(&self, session: &Session) {
        let id = session.id();
        self.tokens.write().unwrap().retain(|_, t| t.session.upgrade().is_some_and(|s| s.id() != id));
    }
}

async fn auth(State(tokens): State<Tokens>, mut req: Request, next: Next) -> Result<Response, StatusCode> {
    if req.headers().contains_key(axum::http::header::ORIGIN) {
        return Err(StatusCode::FORBIDDEN);
    }
    let token = req
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or(StatusCode::UNAUTHORIZED)?;
    let target = tokens.read().unwrap().get(token).cloned().ok_or(StatusCode::UNAUTHORIZED)?;
    req.extensions_mut().insert(target);
    Ok(next.run(req).await)
}

struct Handler;

fn target(cx: &RequestContext<RoleServer>) -> Result<(Arc<Session>, ThreadId), ErrorData> {
    let t = cx
        .extensions
        .get::<http::request::Parts>()
        .and_then(|p| p.extensions.get::<Target>())
        .ok_or_else(|| ErrorData::invalid_request("missing Harness token", None))?;
    let session = t.session.upgrade().ok_or_else(|| ErrorData::invalid_request("the Session is gone", None))?;
    Ok((session, t.thread.clone()))
}

fn schema(v: Value) -> Arc<Map<String, Value>> {
    Arc::new(v.as_object().cloned().unwrap_or_default())
}

/// Primitive tools: (name, description, input schema, Permission Policy kind).
fn primitives() -> Vec<(&'static str, &'static str, Value, &'static str)> {
    let empty = json!({ "type": "object", "properties": {} });
    vec![
        ("git_status", "Git status of the Session's Workspace: branch, upstream, ahead/behind, changed files.", empty.clone(), "read"),
        (
            "git_diff",
            "Unified diff of the Workspace. Defaults to everything changed in this Session (since its base branch, or HEAD), untracked files included.",
            json!({ "type": "object", "properties": {
                "from": { "type": "string", "description": "Commit or tree to diff from" },
                "to": { "type": "string", "description": "Commit or tree to diff to (default: the working tree)" }
            } }),
            "read",
        ),
        ("list_branches", "Local branches of the Workspace's repository, most recent first.", empty.clone(), "read"),
        (
            "git_commit",
            "Stage all changes in the Workspace and commit them.",
            json!({ "type": "object", "properties": { "message": { "type": "string" } }, "required": ["message"] }),
            "git_commit",
        ),
        ("git_push", "Push the current branch to origin (sets upstream).", empty.clone(), "git_push"),
        (
            "state_get",
            "Read the Session State: one JSON document the user's UI can show and change (e.g. a score, answers). Omit `statePath` for all of it.",
            json!({ "type": "object", "properties": {
                "statePath": { "type": "string", "description": "JSON Pointer, e.g. /quiz/score" }
            } }),
            "read",
        ),
        (
            "state_patch",
            "Change the Session State with JSON Patch operations, applied all or nothing. `add`/`replace` create missing parent objects; `-` appends to an array; `test` checks a value first. UI bound to a path (`{\"$state\": \"/quiz/score\"}`) updates at once. Returns the new state.",
            json!({ "type": "object", "properties": {
                "ops": { "type": "array", "minItems": 1, "items": { "type": "object", "properties": {
                    "op": { "type": "string", "enum": ["add", "replace", "remove", "test"] },
                    "path": { "type": "string", "description": "JSON Pointer, e.g. /quiz/score" },
                    "value": { "description": "For add, replace and test" }
                }, "required": ["op", "path"] } }
            }, "required": ["ops"] }),
            "state",
        ),
        (
            "harness_info",
            "What the user's UI shows now: live Frontend items you placed with an `id` (e.g. render_ui slots: id, placement, title) and the top-level keys of the Session State.",
            empty,
            "read",
        ),
    ]
}

impl ServerHandler for Handler {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_instructions("Tools of the Harness hosting this conversation: git for its Workspace, and tools of its Frontend (the UI showing this conversation).")
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        cx: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let (session, _) = target(&cx)?;
        let mut tools: Vec<Tool> =
            primitives().into_iter().map(|(name, desc, input, _)| Tool::new(name, desc, schema(input))).collect();
        for t in session.frontend_tools() {
            tools.push(Tool::new(t.name.clone(), t.description.clone(), schema(t.input_schema.clone())));
        }
        Ok(ListToolsResult { tools, ..Default::default() })
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        cx: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let (session, thread) = target(&cx)?;
        let args = Value::Object(request.arguments.clone().unwrap_or_default());
        let name = request.name.to_string();
        let result = match call(&session, &thread, &name, args).await {
            Ok(text) => CallToolResult::success(vec![ContentBlock::text(text)]),
            Err(e) => CallToolResult::error(vec![ContentBlock::text(format!("{e:#}"))]),
        };
        Ok(result.into())
    }
}

/// Runs one tool call for the Session, after the Permission Policy agrees.
async fn call(session: &Arc<Session>, thread: &ThreadId, name: &str, args: Value) -> anyhow::Result<String> {
    let s = |k: &str| args.get(k).and_then(Value::as_str).map(str::to_owned);
    if let Some((_, desc, _, kind)) = primitives().into_iter().find(|p| p.0 == name) {
        let title = match name {
            "git_commit" => format!("Commit: {}", s("message").unwrap_or_default()),
            "git_push" => "Push branch to origin".to_owned(),
            _ => desc.to_owned(),
        };
        crate::acp::authorize(session, thread, name, &title, kind, &args).await?;
        return Ok(match name {
            "git_status" => serde_json::to_string_pretty(&session.git_status().await?)?,
            "git_diff" => {
                let d = session.git_diff(s("from"), s("to")).await?;
                let mut patch = d.patch;
                if patch.len() > 200_000 {
                    patch.truncate(patch.floor_char_boundary(200_000));
                    patch.push_str("\n[diff truncated]");
                }
                if patch.is_empty() { "No changes.".to_owned() } else { patch }
            }
            "list_branches" => {
                let folder = std::path::PathBuf::from(session.meta().folder);
                serde_json::to_string_pretty(&crate::workspace::list_branches(&folder).await?)?
            }
            "git_commit" => {
                let message = s("message").filter(|m| !m.trim().is_empty()).ok_or_else(|| anyhow::anyhow!("message is required"))?;
                format!("Committed {}", session.git_commit(message).await?)
            }
            "git_push" => {
                session.git_push().await?;
                "Pushed.".to_owned()
            }
            "state_get" => {
                let state = session.state()?;
                let v = match s("statePath").filter(|p| !p.is_empty()) {
                    Some(p) => state.pointer(&p).cloned().ok_or_else(|| anyhow::anyhow!("nothing at {p}"))?,
                    None => state,
                };
                serde_json::to_string_pretty(&v)?
            }
            "state_patch" => {
                let ops: Vec<crate::api::StatePatchOp> =
                    serde_json::from_value(args.get("ops").cloned().unwrap_or_default()).map_err(|e| anyhow::anyhow!("invalid ops: {e}"))?;
                let state = session.patch_state(Some(thread.clone()), ops, crate::api::StateWriter::Agent)?;
                serde_json::to_string_pretty(&state)?
            }
            "harness_info" => serde_json::to_string_pretty(&info(session)?)?,
            _ => unreachable!(),
        });
    }
    let tool = session
        .frontend_tools()
        .into_iter()
        .find(|t| t.name == name)
        .ok_or_else(|| anyhow::anyhow!("unknown tool {name}"))?;
    let (validator, images) = crate::frontend_files::validator(&tool.input_schema)
        .map_err(|e| anyhow::anyhow!("the Frontend's schema for {name} is invalid: {e}"))?;
    let errors: Vec<String> = validator.iter_errors(&args).map(|e| format!("{}: {e}", e.instance_path)).collect();
    // Agents may call a tool before they have seen its schema (some load schemas on demand), so
    // the error carries the description: enough to get the next call right.
    anyhow::ensure!(
        errors.is_empty(),
        "invalid input for {name}:\n{}\n\nHow to call {name}:\n{}",
        errors.join("\n"),
        tool.description
    );
    let images = images.lock().unwrap().clone();
    let planned = crate::frontend_files::plan(std::path::Path::new(&session.meta().folder), &images)?;
    crate::acp::authorize(session, thread, name, &format!("Frontend tool: {name}"), "frontend_tool", &args).await?;
    let files = crate::frontend_files::store(&session.frontend_dir(), planned)?;
    let path = session.write_frontend_tool_output(thread, name, args, files)?;
    let items = info(session)?["items"].clone();
    Ok(format!("Done. The Frontend received it ({path}). Live items: {items}"))
}

/// `harness_info`: live Frontend items (calls with an `id`) and the Session State's top-level keys.
fn info(session: &Session) -> anyhow::Result<Value> {
    let items: Vec<Value> = session
        .frontend_items()?
        .into_iter()
        .map(|(tool, id, input)| {
            let mut item = json!({ "tool": tool, "id": id });
            for k in ["placement", "title"] {
                if let Some(v) = input.get(k) {
                    item[k] = v.clone();
                }
            }
            item
        })
        .collect();
    let keys: Vec<String> = session.state()?.as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default();
    Ok(json!({ "items": items, "state_keys": keys }))
}

/// `harness mcp-shim`: proxies stdio MCP (one JSON-RPC message per line) to the Harness MCP at
/// `HARNESS_MCP_URL` with `HARNESS_MCP_TOKEN`. Request/response only (no server-initiated streams).
pub async fn run_shim() -> anyhow::Result<()> {
    use futures_util::StreamExt;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
    let url = std::env::var("HARNESS_MCP_URL")?;
    let token = std::env::var("HARNESS_MCP_TOKEN")?;
    let http = reqwest::Client::new();
    let mut session: Option<String> = None;
    let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();
    let mut out = tokio::io::stdout();
    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let mut rb = http
            .post(&url)
            .bearer_auth(&token)
            .header("accept", "application/json, text/event-stream")
            .header("content-type", "application/json")
            .body(line);
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

#[cfg(test)]
mod harness_tool_tests {
    #[test]
    fn names_harness_tools_in_each_agent_format() {
        use super::harness_tool_name as n;
        assert_eq!([n("mcp__harness__git_status"), n("mcp.harness.git_commit"), n("mcp__other__x"), n("mcp__harness__")], [Some("git_status"), Some("git_commit"), None, None]);
    }
}
