//! The Harness MCP server: loopback HTTP, a bearer token per Agent Session, and the MCP handler.

use parking_lot::RwLock;
use std::collections::HashMap;
use std::sync::{Arc, Weak};

use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::Response;
use rmcp::ErrorData;
use rmcp::handler::server::ServerHandler;
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerConfig, Tool,
};
use rmcp::service::{RequestContext, RoleServer};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use serde_json::{Map, Value};

use super::tools::{TRANSCRIPT_TOOLS, call, primitives};
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
                let app = axum::Router::new().nest_service("/mcp", svc).layer(axum::middleware::from_fn_with_state(tokens, auth));
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
        self.tokens.write().insert(token.clone(), Target { session: Arc::downgrade(session), thread: thread.clone() });
        token
    }

    /// Forgets every token of a Session (its Agent process ended).
    pub fn revoke(&self, session: &Session) {
        let id = session.id();
        self.tokens.write().retain(|_, t| t.session.upgrade().is_some_and(|s| s.id() != id));
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
    let target = tokens.read().get(token).cloned().ok_or(StatusCode::UNAUTHORIZED)?;
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

impl ServerHandler for Handler {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build()).with_instructions(
            "Tools of the Harness hosting this conversation: git for its Workspace, and tools of its Frontend (the UI showing this conversation).",
        )
    }

    async fn list_tools(&self, _request: Option<PaginatedRequestParams>, cx: RequestContext<RoleServer>) -> Result<ListToolsResult, ErrorData> {
        let (session, thread) = target(&cx)?;
        let fresh = session.is_fresh_side(&thread);
        let sub = crate::sub_sessions::offered(&session, &thread);
        let mut tools: Vec<Tool> = primitives()
            .into_iter()
            .filter(|p| !(fresh && TRANSCRIPT_TOOLS.contains(&p.name)))
            .filter(|p| sub || !crate::sub_sessions::TOOLS.contains(&p.name))
            .map(|p| Tool::new(p.name, p.description, schema(p.schema)))
            .collect();
        for t in session.frontend_tools() {
            tools.push(Tool::new(t.name.clone(), t.description.clone(), schema(t.input_schema.clone())));
        }
        Ok(ListToolsResult { tools, ..Default::default() })
    }

    async fn call_tool(&self, request: CallToolRequestParams, cx: RequestContext<RoleServer>) -> Result<CallToolResponse, ErrorData> {
        let (session, thread) = target(&cx)?;
        let args = Value::Object(request.arguments.clone().unwrap_or_default());
        let name = request.name.to_string();
        let result = match call(&session, &thread, &name, args).await {
            Ok(content) => CallToolResult::success(content),
            Err(e) => CallToolResult::error(vec![ContentBlock::text(format!("{e:#}"))]),
        };
        Ok(result.into())
    }
}
