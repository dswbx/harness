//! Harness MCP (ADR 0011): an in-process MCP server on loopback HTTP that gives Agents the
//! Harness Primitives and their Session's Frontend Tools. Each Agent Session gets a bearer token
//! naming its Session and Thread; requests with an `Origin` header are refused. Agents without
//! HTTP MCP reach it through `run_shim` (stdio).

/// The Harness MCP tool a tool call title names: `mcp__harness__git_status` (Claude) or
/// `mcp.harness.git_status` (Codex) -> `git_status`. Agents name MCP tools their own way; this
/// knows only how they name ours.
pub fn harness_tool_name(title: &str) -> Option<&str> {
    crate::agent_quirks::harness_tool_prefixes().iter().find_map(|p| title.strip_prefix(p)).filter(|n| !n.is_empty())
}

/// Whether `name` is a tool this Harness MCP serves for the Session: a Primitive or one of its
/// Frontend's Tools.
pub fn serves_tool(session: &Session, name: &str) -> bool {
    primitives().iter().any(|p| p.0 == name) || session.frontend_tools().iter().any(|t| t.name == name)
}

/// Whether an Agent's permission request for a tool call may skip the Permission Policy because the
/// Harness MCP checks it itself (`authorize`). The title is untrusted Agent text, so it is not
/// enough: the tool must really be served for the Session, and the call must not look like a
/// command, edit or fetch (`kind`, or a `command` in the input) that only borrows the title.
pub fn trusted_harness_call(served: bool, facts: &crate::permissions::ToolFacts) -> bool {
    let risky = matches!(facts.kind.as_deref(), Some("execute" | "edit" | "delete" | "move" | "fetch"));
    served && !risky && facts.command.is_none()
}

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
use serde_json::{Map, Value, json};

use crate::api::{GitActor, ThreadId};
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

/// Tools that read other Threads, not offered to a Side Thread started without the Main Thread's
/// conversation (its point is an independent view).
const TRANSCRIPT_TOOLS: [&str; 4] = ["threads_list", "transcript_outline", "transcript_read", "transcript_search"];

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
            "Read the Session State: one JSON document the user's UI can show and change (e.g. a score, answers). Omit `statePath` for all of it. With `artifact`, read that attached Shared Artifact's own state instead.",
            json!({ "type": "object", "properties": {
                "statePath": { "type": "string", "description": "JSON Pointer, e.g. /quiz/score" },
                "artifact": { "type": "string", "description": "Id of an attached Shared Artifact" }
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
                }, "required": ["op", "path"] } },
                "artifact": { "type": "string", "description": "Id of an attached Shared Artifact: change its own state instead of the Session State" }
            }, "required": ["ops"] }),
            "state",
        ),
        (
            "harness_info",
            "What the user's UI shows now: live Frontend items you placed with an `id` (e.g. render_ui slots: id, placement, title, source, `updated_ms` (when it last changed: its latest call, or a later write of its source file), and `errors` the UI reported, such as script errors or a missing source file), the top-level keys of the Session State, `panels_dir`: the folder for the .md, .html or .json files of file-backed panels (render_ui `source`), and `shared`: the Shared Artifacts attached to this Session (id, title, kind, `dir`: their folder, `file`: the content file in it).",
            empty.clone(),
            "read",
        ),
        (
            "ui_get",
            "Read a panel you placed with render_ui: its stored input (root or source, placement, title, ...), the Session State values its `$state` paths point to, and for a `source` panel the file's current `content`. For a Shared Artifact (`shared:<id>`, or a panel whose source is one): its meta, content and its own state. Use it before you change a panel you no longer see, e.g. after compaction.",
            json!({ "type": "object", "properties": {
                "id": { "type": "string", "description": "The panel's id, as in render_ui, or shared:<artifact id>" }
            }, "required": ["id"] }),
            "read",
        ),
        (
            "artifact_search",
            "Find Shared Artifacts (artifacts kept outside any Session, e.g. a checklist the user works on across Sessions) whose title or content contains `query`. Returns id, title, kind, updated_ms, a snippet, and whether this Session has it attached. Use it when the user names one. Omit `query` to list all.",
            json!({ "type": "object", "properties": { "query": { "type": "string" } } }),
            "read",
        ),
        (
            "artifact_share",
            "Make one of this Session's render_ui panels (by its id) a Shared Artifact, so other Sessions can attach it. Its file or tree moves out of this Session, with the state it uses. Only when the user asks. Returns the shared id and its folder.",
            json!({ "type": "object", "properties": {
                "id": { "type": "string", "description": "The panel's id, as in render_ui" }
            }, "required": ["id"] }),
            "state",
        ),
        (
            "artifact_attach",
            "Attach a Shared Artifact to this Session: the user sees it as a panel. Returns its folder and content file: edit .md and .html files there with your Edit tool; for a render_ui tree call render_ui with `id: \"shared:<id>\"` and a new `root`. Attaching is explicit: do it when the user asks for the artifact, not because it was named.",
            json!({ "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] }),
            "state",
        ),
        (
            "artifact_detach",
            "Detach a Shared Artifact from this Session. The artifact stays; other Sessions keep it.",
            json!({ "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] }),
            "state",
        ),
        (
            "threads_list",
            "The Threads of this Session: the Main Thread and any Side Threads (id, kind, title from the first prompt, Turn count).",
            empty,
            "read",
        ),
        (
            "transcript_outline",
            "Outline of a Thread's transcript: one line per Turn (number, short prompt, tool count, size). Read-only.",
            json!({ "type": "object", "properties": { "thread": crate::transcript::thread_schema() } }),
            "read",
        ),
        (
            "transcript_read",
            "Read Turns `from` to `to` (1-based, inclusive) of a Thread's transcript: prompts, replies and tool titles. Tool input and output only with `tools`. Read-only.",
            json!({ "type": "object", "properties": {
                "thread": crate::transcript::thread_schema(),
                "from": { "type": "integer", "minimum": 1, "description": "First Turn (default 1)" },
                "to": { "type": "integer", "minimum": 1, "description": "Last Turn (default: the last)" },
                "tools": { "type": "boolean", "description": "Include tool input and output (default false)" }
            } }),
            "read",
        ),
        (
            "transcript_search",
            "Find Turns of a Thread's transcript containing `query` (case-insensitive): Turn numbers with snippets. Read-only.",
            json!({ "type": "object", "properties": {
                "thread": crate::transcript::thread_schema(),
                "query": { "type": "string" }
            }, "required": ["query"] }),
            "read",
        ),
    ]
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
        let mut tools: Vec<Tool> = primitives()
            .into_iter()
            .filter(|(name, ..)| !(fresh && TRANSCRIPT_TOOLS.contains(name)))
            .map(|(name, desc, input, _)| Tool::new(name, desc, schema(input)))
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

/// Runs one tool call for the Session, after the Permission Policy agrees.
async fn call(session: &Arc<Session>, thread: &ThreadId, name: &str, args: Value) -> anyhow::Result<Vec<ContentBlock>> {
    let s = |k: &str| args.get(k).and_then(Value::as_str).map(str::to_owned);
    if let Some((_, desc, _, kind)) = primitives().into_iter().find(|p| p.0 == name) {
        anyhow::ensure!(
            !(TRANSCRIPT_TOOLS.contains(&name) && session.is_fresh_side(thread)),
            "{name} is not available: the user started this Side Thread without the Main Thread's conversation"
        );
        let title = match name {
            "git_commit" => format!("Commit: {}", s("message").unwrap_or_default()),
            "git_push" => "Push branch to origin".to_owned(),
            _ => desc.to_owned(),
        };
        crate::acp::authorize(session, thread, name, &title, kind, &args).await?;
        return Ok(vec![ContentBlock::text(match name {
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
                format!("Committed {}", session.git_commit(message, GitActor::Agent).await?)
            }
            "git_push" => {
                let branch = session.git_push(GitActor::Agent).await?;
                format!("Pushed {branch}.")
            }
            "state_get" => {
                let state = match s("artifact") {
                    Some(id) => {
                        session.ensure_attached(&id)?;
                        session.shared().artifacts.state(&id)?
                    }
                    None => session.state()?,
                };
                let v = match s("statePath").filter(|p| !p.is_empty()) {
                    Some(p) => state.pointer(&p).cloned().ok_or_else(|| anyhow::anyhow!("nothing at {p}"))?,
                    None => state,
                };
                serde_json::to_string_pretty(&v)?
            }
            "state_patch" => {
                let ops: Vec<crate::api::StatePatchOp> =
                    serde_json::from_value(args.get("ops").cloned().unwrap_or_default()).map_err(|e| anyhow::anyhow!("invalid ops: {e}"))?;
                let state = match s("artifact") {
                    Some(id) => session.patch_artifact_state(Some(thread.clone()), &id, ops, crate::api::StateWriter::Agent)?,
                    None => session.patch_state(Some(thread.clone()), ops, crate::api::StateWriter::Agent)?,
                };
                serde_json::to_string_pretty(&state)?
            }
            "artifact_search" => {
                let attached = session.attached_shared()?;
                let hits: Vec<Value> = session
                    .shared()
                    .artifacts
                    .list(s("query").as_deref())
                    .into_iter()
                    .take(20)
                    .map(|e| {
                        let m = e.meta;
                        json!({ "id": m.id, "title": m.title, "kind": m.kind, "updated_ms": m.updated_ms, "snippet": e.snippet, "attached": attached.contains(&m.id) })
                    })
                    .collect();
                if hits.is_empty() { "No Shared Artifacts match.".to_owned() } else { serde_json::to_string_pretty(&hits)? }
            }
            "artifact_share" => {
                let id = s("id").ok_or_else(|| anyhow::anyhow!("id is required"))?;
                let meta = session.share_item(&id, crate::api::StateWriter::Agent)?;
                session.shared().app_events.emit(crate::api::AppEvent::SharedArtifactsChanged);
                serde_json::to_string_pretty(&shared_info(session, &meta))?
            }
            "artifact_attach" => {
                let id = s("id").ok_or_else(|| anyhow::anyhow!("id is required"))?;
                let meta = session.attach_shared(&id, crate::api::StateWriter::Agent)?;
                session.shared().app_events.emit(crate::api::AppEvent::SharedArtifactsChanged);
                serde_json::to_string_pretty(&shared_info(session, &meta))?
            }
            "artifact_detach" => {
                let id = s("id").ok_or_else(|| anyhow::anyhow!("id is required"))?;
                session.detach_shared(&id, crate::api::StateWriter::Agent)?;
                session.shared().app_events.emit(crate::api::AppEvent::SharedArtifactsChanged);
                format!("Detached {id}.")
            }
            "harness_info" => serde_json::to_string_pretty(&info(session)?)?,
            "ui_get" => serde_json::to_string_pretty(&ui_get(session, s("id").as_deref())?)?,
            "threads_list" => crate::transcript::threads_list(session)?,
            "transcript_outline" => crate::transcript::outline(session, &args)?,
            "transcript_read" => crate::transcript::read(session, &args)?,
            "transcript_search" => crate::transcript::search(session, &args)?,
            _ => unreachable!(),
        })]);
    }
    let tool = session.frontend_tools().into_iter().find(|t| t.name == name).ok_or_else(|| anyhow::anyhow!("unknown tool {name}"))?;
    let (validator, images) =
        crate::frontend_files::validator(&tool.input_schema).map_err(|e| anyhow::anyhow!("the Frontend's schema for {name} is invalid: {e}"))?;
    let errors = crate::frontend_files::format_errors(&validator, &args);
    // Agents may call a tool before they have seen its schema (some load schemas on demand), so
    // the error carries the description: enough to get the next call right.
    anyhow::ensure!(errors.is_empty(), "invalid input for {name}:\n{errors}\n\nHow to call {name}:\n{}", tool.description);
    // A file-backed panel (ADR 0023): the log keeps the name; the file must exist in panels_dir.
    // `shared:<id>` names an attached Shared Artifact instead (ADR 0024).
    if let Some(source) = args.get("source").and_then(Value::as_str) {
        match crate::shared::reference(source) {
            Some(id) => drop(session.ensure_attached(id)?),
            None => {
                let (content, _) =
                    crate::panels::read(&session.panels_dir(), source).map_err(|e| anyhow::anyhow!("{e:#}. Write the file first, then call {name} again."))?;
                if let Some(e) = tree_error(session, source, &content) {
                    anyhow::bail!("{e}\n\nFix the file, then call {name} again.");
                }
            }
        }
    }
    // `id: "shared:<id>"` with a `root` replaces a shared tree's `ui.json`. Not logged: the watcher
    // tells every View.
    if let Some(id) = args.get("id").and_then(Value::as_str).and_then(crate::shared::reference) {
        let root = args.get("root").filter(|_| args.get("remove").is_none() && args.get("source").is_none());
        let root = root.ok_or_else(|| anyhow::anyhow!("an id shared:<id> takes only a new root (to detach it, use artifact_detach)"))?;
        session.ensure_attached(id)?;
        let images = images.lock().clone();
        let planned = crate::frontend_files::plan(std::path::Path::new(&session.meta().folder), &images)?;
        crate::acp::authorize(session, thread, name, &format!("Frontend tool: {name}"), "frontend_tool", &args).await?;
        session.shared().artifacts.write_ui(id, root, planned)?;
        session.shared().app_events.emit(crate::api::AppEvent::SharedArtifactChanged { id: id.to_owned() });
        return Ok(vec![ContentBlock::text(format!("Done. Shared artifact {id} now shows the new tree in every Session that has it attached."))]);
    }
    if tool.replies {
        crate::acp::authorize(session, thread, name, &format!("Frontend tool: {name}"), "read", &args).await?;
        let answer = session.request_frontend(name, args).await?;
        if let Some(error) = answer.error {
            anyhow::bail!("{error}");
        }
        let text = answer.text.map(ContentBlock::text);
        let image = answer.image.map(|i| ContentBlock::image(i.data, i.mime));
        return Ok(text.into_iter().chain(image).collect());
    }
    let images = images.lock().clone();
    let planned = crate::frontend_files::plan(std::path::Path::new(&session.meta().folder), &images)?;
    crate::acp::authorize(session, thread, name, &format!("Frontend tool: {name}"), "frontend_tool", &args).await?;
    let files = crate::frontend_files::store(&session.frontend_dir(), planned)?;
    let path = session.write_frontend_tool_output(thread, name, args, files)?;
    let items = info(session)?["items"].clone();
    Ok(vec![ContentBlock::text(format!("Done. The Frontend received it ({path}). Live items: {items}"))])
}

/// `ui_get`: the latest stored input of a live `render_ui` item, plus the Session State values at
/// the paths it binds (`$state`, `$bindState`, `${/path}` in `$template`; `$computed` args are
/// ordinary `$state` values).
fn ui_get(session: &Session, id: Option<&str>) -> anyhow::Result<Value> {
    let id = id.ok_or_else(|| anyhow::anyhow!("id is required"))?;
    if let Some(shared) = crate::shared::reference(id) {
        session.ensure_attached(shared)?;
        return shared_get(session, shared);
    }
    let items: Vec<(String, Value)> = session.frontend_items()?.into_iter().filter(|x| x.tool == crate::session::RENDER_UI).map(|x| (x.id, x.input)).collect();
    let Some((_, input)) = items.iter().find(|(i, _)| i == id) else {
        let known: Vec<&str> = items.iter().map(|(i, _)| i.as_str()).collect();
        anyhow::bail!("no render_ui panel with id {id:?}. Known ids: {}", if known.is_empty() { "none".to_owned() } else { known.join(", ") });
    };
    let source = input.get("source").and_then(Value::as_str);
    if let Some(shared) = source.and_then(crate::shared::reference) {
        let mut out = json!({ "input": input });
        match shared_get(session, shared) {
            Ok(Value::Object(o)) => {
                if let Some(m) = out.as_object_mut() {
                    m.extend(o);
                }
            }
            Ok(_) => {}
            Err(e) => out["error"] = json!(format!("Shared artifact missing: {e:#}")),
        }
        return Ok(out);
    }
    let mut out = json!({ "input": input, "state": bound_values(&session.state()?, input) });
    if let Some(source) = source {
        match crate::panels::read(&session.panels_dir(), source) {
            Ok((content, _)) => out["content"] = json!(content),
            Err(e) => out["error"] = json!(format!("{e:#}")),
        }
    }
    Ok(out)
}

/// The values of `doc` at the paths `input` binds (null when missing).
fn bound_values(doc: &Value, input: &Value) -> Map<String, Value> {
    crate::state::bound_paths(input)
        .into_iter()
        .map(|p| {
            let v = doc.pointer(&p).cloned().unwrap_or(Value::Null);
            (p, v)
        })
        .collect()
}

/// `ui_get` for a Shared Artifact: its meta, folder, content (a tree as `input`) and state (for a
/// tree, the values at the paths it binds; else all of it).
fn shared_get(session: &Session, id: &str) -> anyhow::Result<Value> {
    let r = session.shared().artifacts.read(id)?;
    let mut out = shared_info(session, &r.meta);
    if r.meta.kind == crate::api::SharedKind::Ui {
        let ui: Value = serde_json::from_str(&r.content).map_err(|e| anyhow::anyhow!("ui.json of {id} is not JSON: {e}"))?;
        out["state"] = json!(bound_values(&r.state, &ui["root"]));
        out["tree"] = ui;
    } else {
        out["content"] = json!(r.content);
        out["state"] = r.state;
    }
    Ok(out)
}

/// What the Agent needs to find a Shared Artifact again: id, title, kind, folder and content file.
fn shared_info(session: &Session, meta: &crate::api::SharedArtifactMeta) -> Value {
    let dir = session.shared().artifacts.folder(&meta.id).map(|d| d.display().to_string()).unwrap_or_default();
    json!({ "id": meta.id, "title": meta.title, "kind": meta.kind, "dir": dir, "file": crate::shared::content_name(meta.kind) })
}

/// Why a `.json` panel source cannot show: not JSON, no `root`, a root the render_ui schema refuses,
/// or a local image (only `root` input copies those). None for other sources and good trees.
fn tree_error(session: &Session, source: &str, content: &str) -> Option<String> {
    if !source.ends_with(".json") {
        return None;
    }
    let ui: Value = match serde_json::from_str(content) {
        Ok(v) => v,
        Err(e) => return Some(format!("source {source:?} is not JSON: {e}")),
    };
    let Some(root) = ui.get("root").filter(|r| r.is_object()) else {
        return Some(format!("source {source:?} must be {{\"root\": node}}, the same root you would pass to render_ui"));
    };
    let tool = session.frontend_tools().into_iter().find(|t| t.name == crate::session::RENDER_UI)?;
    let (validator, images) = crate::frontend_files::validator(&tool.input_schema).ok()?;
    let errors = crate::frontend_files::format_errors(&validator, &json!({ "root": root }));
    if !errors.is_empty() {
        return Some(format!("source {source:?} has an invalid tree:\n{errors}"));
    }
    let local: Vec<String> = images.lock().iter().filter(|s| !s.starts_with("https://") && !s.starts_with("data:image/")).cloned().collect();
    (!local.is_empty()).then(|| format!("source {source:?} uses local images ({}); a .json source can only show https: or data: images", local.join(", ")))
}

/// `harness_info`: live Frontend items (calls with an `id`, with the errors the UI reported for
/// them, and a missing `source` file; `updated_ms`), the Session State's top-level keys and `panels_dir`.
fn info(session: &Session) -> anyhow::Result<Value> {
    let errors = session.frontend_errors()?;
    let panels = session.panels_dir();
    let items: Vec<Value> = session
        .frontend_items()?
        .into_iter()
        .map(|crate::session::FrontendItem { tool, id, input, ts_ms, .. }| {
            let mut item = json!({ "tool": tool, "id": id });
            for k in ["placement", "title", "source"] {
                if let Some(v) = input.get(k) {
                    item[k] = v.clone();
                }
            }
            let mut errs: Vec<String> = errors.iter().filter(|e| e.tool == tool && e.item == id).map(|e| e.message.clone()).collect();
            // When it last changed: its latest call, or for a file-backed panel a later file write.
            let mut updated = ts_ms;
            if let Some(source) = input.get("source").and_then(Value::as_str) {
                match crate::shared::reference(source) {
                    Some(sid) => match session.shared().artifacts.get(sid) {
                        Ok(m) => updated = updated.max(m.updated_ms),
                        Err(_) => errs.push(format!("Shared artifact missing: {sid}")),
                    },
                    None => match crate::panels::read(&panels, source) {
                        Ok((content, _)) => {
                            updated = updated.max(crate::panels::mtime_ms(&panels, source).unwrap_or(0));
                            errs.extend(tree_error(session, source, &content));
                        }
                        Err(e) => errs.push(format!("Source missing: {e:#}")),
                    },
                }
            }
            item["updated_ms"] = json!(updated);
            if !errs.is_empty() {
                item["errors"] = json!(errs);
            }
            item
        })
        .collect();
    let keys: Vec<String> = session.state()?.as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default();
    let shared: Vec<Value> = session
        .attached_shared()?
        .into_iter()
        .map(|id| match session.shared().artifacts.get(&id) {
            Ok(meta) => shared_info(session, &meta),
            Err(_) => json!({ "id": id, "errors": ["Shared artifact missing: it was deleted"] }),
        })
        .collect();
    Ok(json!({ "items": items, "state_keys": keys, "panels_dir": panels.display().to_string(), "shared": shared }))
}

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

#[cfg(test)]
mod harness_tool_tests {
    #[test]
    fn names_harness_tools_in_each_agent_format() {
        use super::harness_tool_name as n;
        assert_eq!(
            [n("mcp__harness__git_status"), n("mcp.harness.git_commit"), n("mcp__other__x"), n("mcp__harness__")],
            [Some("git_status"), Some("git_commit"), None, None]
        );
    }

    #[test]
    fn trust_needs_a_served_tool_and_a_benign_call() {
        use super::trusted_harness_call as t;
        use crate::permissions::ToolFacts;
        let facts = |kind: Option<&str>, command: Option<&str>| ToolFacts { kind: kind.map(Into::into), command: command.map(Into::into), paths: vec![] };
        assert!(t(true, &facts(Some("other"), None)));
        assert!(t(true, &facts(Some("read"), None)));
        assert!(t(true, &facts(None, None)));
        assert!(!t(false, &facts(Some("other"), None)));
        for kind in ["execute", "edit", "delete", "move", "fetch"] {
            assert!(!t(true, &facts(Some(kind), None)), "{kind}");
        }
        assert!(!t(true, &facts(Some("other"), Some("rm -rf ~"))));
    }
}
