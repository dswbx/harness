//! Deterministic ACP agent for Harness tests. Behaviour is driven by the prompt text:
//! - always: one message chunk, a Task List, then `end_turn`
//! - contains "tool": a tool call that completes
//! - contains "permission": the tool call (`echo hi`) first asks for permission; rejection fails it
//! - contains "write": appends a line to `fake.txt` in the session's cwd
//! - starts with "mcp <tool> <json>": calls `<tool>` on the `harness` MCP server it was given and
//!   answers "mcp: <result text>" (or "mcp error: ..."); "mcp-list" answers the tool names
//! - contains "crash": the process exits mid-Turn
//! - contains "hangup": stdout closes mid-Turn but the process lingers (like a killed child of npx)
//! - a prompt carrying a `<context>` block (Context Seed) is answered with "seeded"
//! - a `<harness_context>` block is not part of the prompt text; "show-context" answers
//!   "context: <the block>" (or "context: none")
//! - a prompt with non-text blocks first answers "blocks: <kinds>" (e.g. `text,image,resource_link`)
//!
//! Flags: `--resume` / `--load` advertise those capabilities for any `fake-*` session id; load
//! replays one message chunk ("replayed") before answering. `--no-http-mcp` makes the Harness
//! use the stdio shim. `--auth` advertises an agent auth
//! method (`login`) and a terminal one (`tui`, args `--login`), and refuses `session/new` with
//! `auth_required` until `authenticate(login)` succeeds. `--images` advertises image and
//! embedded-context prompt capabilities.

use agent_client_protocol::schema::v1::*;
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{Agent, Client, ConnectionTo, Stdio};

fn update(cx: &ConnectionTo<Client>, session: &SessionId, u: SessionUpdate) -> agent_client_protocol::Result<()> {
    cx.send_notification(SessionNotification::new(session.clone(), u))
}

fn text(t: &str) -> SessionUpdate {
    SessionUpdate::AgentMessageChunk(ContentChunk::new(ContentBlock::Text(TextContent::new(t))))
}

/// cwd per Agent Session.
static CWDS: std::sync::Mutex<Vec<(String, std::path::PathBuf)>> = std::sync::Mutex::new(Vec::new());

fn remember_cwd(id: &SessionId, cwd: &std::path::Path) {
    CWDS.lock().unwrap().push((id.to_string(), cwd.to_owned()));
}

/// MCP servers per Agent Session.
static MCP: std::sync::Mutex<Vec<(String, Vec<McpServer>)>> = std::sync::Mutex::new(Vec::new());

fn remember_mcp(id: &SessionId, servers: &[McpServer]) {
    MCP.lock().unwrap().push((id.to_string(), servers.to_vec()));
}

/// Calls a tool (or lists tools when `tool` is None) on the session's `harness` MCP server.
async fn harness_mcp(id: &SessionId, tool: Option<&str>, args: serde_json::Value) -> Result<String, String> {
    use rmcp::ServiceExt;
    let servers = MCP.lock().unwrap().iter().rev().find(|(s, _)| *s == id.to_string()).map(|(_, m)| m.clone()).unwrap_or_default();
    let server = servers
        .into_iter()
        .find(|s| serde_json::to_value(s).ok().and_then(|v| v["name"].as_str().map(str::to_owned)).as_deref() == Some("harness"))
        .ok_or("no harness MCP server")?;
    let client = match server {
        McpServer::Http(h) => {
            let token = h.headers.iter().find(|x| x.name == "Authorization").map(|x| x.value.trim_start_matches("Bearer ").to_owned()).unwrap_or_default();
            let config = rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig::with_uri(h.url).auth_header(token);
            ().serve(rmcp::transport::StreamableHttpClientTransport::from_config(config)).await.map_err(|e| e.to_string())?
        }
        McpServer::Stdio(s) => {
            let mut cmd = tokio::process::Command::new(&s.command);
            cmd.args(&s.args).envs(s.env.iter().map(|e| (e.name.clone(), e.value.clone())));
            ().serve(rmcp::transport::TokioChildProcess::new(cmd).map_err(|e| e.to_string())?).await.map_err(|e| e.to_string())?
        }
        _ => return Err("unsupported transport".into()),
    };
    let out = match tool {
        None => {
            let tools = client.list_all_tools().await.map_err(|e| e.to_string())?;
            Ok(tools.iter().map(|t| t.name.to_string()).collect::<Vec<_>>().join(","))
        }
        Some(name) => {
            let mut params = rmcp::model::CallToolRequestParams::new(name.to_owned());
            if let serde_json::Value::Object(m) = args {
                params = params.with_arguments(m);
            }
            let r = client.call_tool(params).await.map_err(|e| e.to_string())?;
            let v = serde_json::to_value(&r).unwrap_or_default();
            let text = v["content"].as_array().into_iter().flatten().filter_map(|c| c["text"].as_str()).collect::<Vec<_>>().join("\n");
            if v["isError"].as_bool() == Some(true) { Err(text) } else { Ok(text) }
        }
    };
    let _ = client.cancel().await;
    out
}

fn cwd_of(id: &SessionId) -> Option<std::path::PathBuf> {
    CWDS.lock().unwrap().iter().rev().find(|(s, _)| *s == id.to_string()).map(|(_, p)| p.clone())
}

/// A `model` select with values `a` and `b`.
fn model_option(current: &str) -> Vec<SessionConfigOption> {
    vec![SessionConfigOption::select(
        "model",
        "Model",
        current.to_owned(),
        vec![SessionConfigSelectOption::new("a", "A"), SessionConfigSelectOption::new("b", "B")],
    )]
}

#[tokio::main]
async fn main() -> agent_client_protocol::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let resume = args.iter().any(|a| a == "--resume");
    let load = args.iter().any(|a| a == "--load");
    let auth = args.iter().any(|a| a == "--auth");
    let no_http_mcp = args.iter().any(|a| a == "--no-http-mcp");
    let images = args.iter().any(|a| a == "--images");
    let authed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(!auth));
    let authed_new = authed.clone();
    // Ids stay unique across processes so a restarted agent never reuses one.
    let next = std::sync::atomic::AtomicU64::new(std::process::id() as u64 * 1000);
    Agent
        .builder()
        .name("fake-agent")
        .on_receive_request(
            async move |req: InitializeRequest, responder, _cx| {
                let _ = ProtocolVersion::V1;
                let mut caps = AgentCapabilities::new()
                    .load_session(load)
                    .mcp_capabilities(McpCapabilities::new().http(!no_http_mcp))
                    .prompt_capabilities(PromptCapabilities::new().image(images).embedded_context(images));
                if resume {
                    caps = caps.session_capabilities(SessionCapabilities::new().resume(SessionResumeCapabilities::new()));
                }
                let mut resp = InitializeResponse::new(req.protocol_version).agent_capabilities(caps);
                if auth {
                    resp = resp.auth_methods(vec![
                        AuthMethod::Agent(AuthMethodAgent::new("login", "Log in")),
                        AuthMethod::Terminal(AuthMethodTerminal::new("tui", "Log in in a terminal").args(vec!["--login".to_owned()])),
                    ]);
                }
                responder.respond(resp)
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |req: AuthenticateRequest, responder, _cx| {
                if req.method_id.to_string() == "login" {
                    authed.store(true, std::sync::atomic::Ordering::SeqCst);
                    responder.respond(AuthenticateResponse::new())
                } else {
                    responder.respond_with_error(Error::invalid_params())
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |req: NewSessionRequest, responder, _cx| {
                if !authed_new.load(std::sync::atomic::Ordering::SeqCst) {
                    return responder.respond_with_error(Error::auth_required());
                }
                let n = next.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let id = SessionId::new(format!("fake-{n}"));
                remember_cwd(&id, &req.cwd);
                remember_mcp(&id, &req.mcp_servers);
                responder.respond(NewSessionResponse::new(id).config_options(model_option("a")))
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            // Like Codex: the answer carries the new options; no update notification follows.
            async move |req: SetSessionConfigOptionRequest, responder, _cx| {
                let value = serde_json::to_value(&req.value).unwrap_or_default();
                let value = value.get("value").and_then(|v| v.as_str()).unwrap_or("a").to_owned();
                responder.respond(SetSessionConfigOptionResponse::new(model_option(&value)))
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |req: ResumeSessionRequest, responder, _cx| {
                remember_cwd(&req.session_id, &req.cwd);
                remember_mcp(&req.session_id, &req.mcp_servers);
                responder.respond(ResumeSessionResponse::new())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |req: LoadSessionRequest, responder, cx: ConnectionTo<Client>| {
                remember_cwd(&req.session_id, &req.cwd);
                update(&cx, &req.session_id, text("replayed"))?;
                responder.respond(LoadSessionResponse::new())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |req: PromptRequest, responder, cx: ConnectionTo<Client>| {
                // Run the Turn off the dispatch loop so we can await the client's answers.
                let cx2 = cx.clone();
                cx.spawn(async move {
                    let cx = cx2;
                    let sid = req.session_id.clone();
                    let harness_context = req.prompt.iter().find_map(|b| match b {
                        ContentBlock::Text(t) if t.text.starts_with("<harness_context>") => Some(t.text.clone()),
                        _ => None,
                    });
                    let prompt = req
                        .prompt
                        .iter()
                        .filter_map(|b| match b {
                            ContentBlock::Text(t) if !t.text.starts_with("<harness_context>") => Some(t.text.clone()),
                            _ => None,
                        })
                        .collect::<Vec<_>>()
                        .join(" ");
                    if req.prompt.iter().any(|b| !matches!(b, ContentBlock::Text(_))) {
                        let kinds: Vec<&str> = req
                            .prompt
                            .iter()
                            .filter(|b| !matches!(b, ContentBlock::Text(t) if t.text.starts_with("<harness_context>")))
                            .map(|b| match b {
                                ContentBlock::Text(_) => "text",
                                ContentBlock::Image(_) => "image",
                                ContentBlock::ResourceLink(_) => "resource_link",
                                ContentBlock::Resource(_) => "resource",
                                _ => "other",
                            })
                            .collect();
                        update(&cx, &sid, text(&format!("blocks: {}\n", kinds.join(","))))?;
                    }
                    if prompt.contains("<context>") {
                        update(&cx, &sid, text("seeded"))?;
                    }
                    if prompt.contains("show-context") {
                        update(&cx, &sid, text(&format!("context: {}", harness_context.as_deref().unwrap_or("none"))))?;
                    }
                    if prompt.starts_with("mcp-servers") {
                        let servers = MCP.lock().unwrap().iter().rev().find(|(s, _)| *s == sid.to_string()).map(|(_, m)| m.clone()).unwrap_or_default();
                        let desc: Vec<String> = servers
                            .iter()
                            .map(|s| match s {
                                McpServer::Stdio(s) => format!(
                                    "{}:stdio:{}",
                                    s.name,
                                    s.env.iter().filter(|e| e.name != "PATH").map(|e| format!("{}={}", e.name, e.value)).collect::<Vec<_>>().join("&")
                                ),
                                McpServer::Http(h) => format!("{}:http", h.name),
                                _ => "other".into(),
                            })
                            .collect();
                        update(&cx, &sid, text(&format!("servers: {}", desc.join(" "))))?;
                        return responder.respond(PromptResponse::new(StopReason::EndTurn));
                    }
                    if let Some(rest) = prompt.strip_prefix("mcp-list") {
                        let _ = rest;
                        let r = harness_mcp(&sid, None, serde_json::Value::Null).await;
                        update(&cx, &sid, text(&format!("tools: {}", r.unwrap_or_else(|e| e))))?;
                        return responder.respond(PromptResponse::new(StopReason::EndTurn));
                    }
                    if let Some(rest) = prompt.strip_prefix("mcp ") {
                        let (tool, args) = rest.split_once(' ').unwrap_or((rest, "{}"));
                        let args = serde_json::from_str(args).unwrap_or(serde_json::Value::Null);
                        let reply = match harness_mcp(&sid, Some(tool), args).await {
                            Ok(t) => format!("mcp: {t}"),
                            Err(e) => format!("mcp error: {e}"),
                        };
                        update(&cx, &sid, text(&reply))?;
                        return responder.respond(PromptResponse::new(StopReason::EndTurn));
                    }
                    update(&cx, &sid, text("Working on it."))?;
                    if prompt.contains("title") {
                        update(&cx, &sid, SessionUpdate::SessionInfoUpdate(SessionInfoUpdate::new().title("Fake title")))?;
                    }
                    if prompt.contains("write")
                        && let Some(cwd) = cwd_of(&sid)
                    {
                        use std::io::Write;
                        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(cwd.join("fake.txt")).unwrap();
                        writeln!(f, "hello").unwrap();
                    }
                    if prompt.contains("crash") {
                        std::process::exit(1);
                    }
                    if prompt.contains("hangup") {
                        use std::os::fd::FromRawFd;
                        // SAFETY: fd 1 is our stdout; nothing writes to it after this.
                        drop(unsafe { std::fs::File::from_raw_fd(1) });
                        std::thread::sleep(std::time::Duration::from_secs(60));
                    }
                    update(&cx, &sid, SessionUpdate::Plan(Plan::new(vec![
                        PlanEntry::new("Read prompt", PlanEntryPriority::High, PlanEntryStatus::Completed),
                        PlanEntry::new("Answer", PlanEntryPriority::Medium, PlanEntryStatus::InProgress),
                    ])))?;
                    if prompt.contains("tool") || prompt.contains("permission") {
                        let call = ToolCall::new("call-1", "Run fake tool")
                            .kind(ToolKind::Execute)
                            .status(ToolCallStatus::Pending)
                            .raw_input(serde_json::json!({ "command": "echo hi" }));
                        update(&cx, &sid, SessionUpdate::ToolCall(call))?;
                        let mut allowed = true;
                        if prompt.contains("permission") {
                            let options = vec![
                                PermissionOption::new("allow", "Allow", PermissionOptionKind::AllowOnce),
                                PermissionOption::new("always", "Always allow", PermissionOptionKind::AllowAlways),
                                PermissionOption::new("reject", "Reject", PermissionOptionKind::RejectOnce),
                            ];
                            let ask = RequestPermissionRequest::new(
                                sid.clone(),
                                ToolCallUpdate::new("call-1", ToolCallUpdateFields::new().title("Run fake tool")),
                                options,
                            );
                            let answer = cx.send_request(ask).block_task().await?;
                            allowed = matches!(&answer.outcome, RequestPermissionOutcome::Selected(s) if s.option_id.to_string() != "reject");
                        }
                        let status = if allowed { ToolCallStatus::Completed } else { ToolCallStatus::Failed };
                        update(&cx, &sid, SessionUpdate::ToolCallUpdate(ToolCallUpdate::new("call-1", ToolCallUpdateFields::new().status(status))))?;
                    }
                    update(&cx, &sid, text(" Done."))?;
                    responder.respond(PromptResponse::new(StopReason::EndTurn))
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_to(Stdio::new())
        .await
}
