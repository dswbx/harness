//! ACP client side: one Agent process per Session (shared by its Threads), normalized into the
//! Session Log. See docs/spikes/acp-client.md for the crate's behaviour.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use agent_client_protocol::schema::v1 as acp;
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{AcpAgent, Agent, Client, ConnectionTo, LineDirection, Responder};
use serde_json::Value;
use tokio::sync::{oneshot, Mutex as AsyncMutex};

use crate::api::{
    AttachmentInput, Boundary, Decision, EventKind, NewPermissionRule, RuleScope, PermissionOption, ProcessState, Resolver,
    SessionStatus, SlashCommand, TaskEntry, ThreadId,
};
use crate::session::Session;

/// Agent stderr lines kept for error reports.
const STDERR_TAIL: usize = 30;

fn with_tail(message: String, tail: &Mutex<std::collections::VecDeque<String>>) -> String {
    let t = tail.lock().unwrap();
    if t.is_empty() {
        message
    } else {
        format!("{message}\n\nAgent output (stderr):\n{}", t.iter().cloned().collect::<Vec<_>>().join("\n"))
    }
}

/// Distinguishes Agent processes of one Session, so a late exit never clears its successor.
static GENERATION: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
pub struct AgentSlot {
    /// Serializes connection startup.
    start: AsyncMutex<()>,
    /// Serializes Agent Session setup (warm-up racing the first prompt must not open two).
    setup: AsyncMutex<()>,
    state: Mutex<SlotState>,
}

#[derive(Default)]
struct SlotState {
    conn: Option<Arc<AgentConn>>,
    /// Turns in flight, per Thread.
    turns: HashMap<ThreadId, usize>,
    pending: HashMap<String, Pending>,
    /// Latest known state of each tool call (merged updates), since permission requests may
    /// carry only an id and a title.
    tool_calls: HashMap<String, Value>,
    last_active: Option<Instant>,
    /// Auth methods from the last `initialize` (raw ACP JSON).
    auth_methods: Vec<Value>,
}

struct Pending {
    thread: Option<ThreadId>,
    responder: Answer,
    options: Vec<PermissionOption>,
    facts: crate::permissions::ToolFacts,
}

/// Who waits for a permission answer: the Agent (ACP request) or the Harness itself (a Harness
/// MCP tool call). `None` means cancelled.
enum Answer {
    Acp(Responder<acp::RequestPermissionResponse>),
    Local(oneshot::Sender<Option<String>>),
}

impl Answer {
    fn send(self, option_id: Option<String>) -> anyhow::Result<()> {
        match self {
            Answer::Acp(r) => {
                let outcome = match option_id {
                    Some(id) => acp::RequestPermissionOutcome::Selected(acp::SelectedPermissionOutcome::new(id)),
                    None => acp::RequestPermissionOutcome::Cancelled,
                };
                r.respond(acp::RequestPermissionResponse::new(outcome))?;
            }
            Answer::Local(tx) => {
                let _ = tx.send(option_id);
            }
        }
        Ok(())
    }
}

struct AgentConn {
    generation: u64,
    cx: ConnectionTo<Agent>,
    init: acp::InitializeResponse,
    /// Agent Session per Thread.
    acp_sessions: Mutex<HashMap<ThreadId, acp::SessionId>>,
    /// Drop notifications while `session/load` replays history (the Session Log already has it).
    replaying: Arc<AtomicBool>,
    /// Why the Harness stopped the process, when it did so on purpose.
    stop_reason: Arc<Mutex<Option<String>>>,
    shutdown: Mutex<Option<oneshot::Sender<()>>>,
}

impl AgentSlot {
    pub fn status(&self) -> SessionStatus {
        Self::status_of(&self.state.lock().unwrap())
    }

    fn status_of(s: &SlotState) -> SessionStatus {
        if !s.pending.is_empty() {
            SessionStatus::NeedsAttention
        } else if s.turns.values().any(|n| *n > 0) {
            SessionStatus::Working
        } else {
            SessionStatus::Idle
        }
    }

    /// Applies `f` to the slot state and logs the Session status if it changed.
    fn update(&self, session: &Session, f: impl FnOnce(&mut SlotState)) {
        let (before, after) = {
            let mut s = self.state.lock().unwrap();
            let before = Self::status_of(&s);
            f(&mut s);
            s.last_active = Some(Instant::now());
            (before, Self::status_of(&s))
        };
        if before != after {
            session.set_status(after);
        }
    }

    fn conn(&self) -> Option<Arc<AgentConn>> {
        self.state.lock().unwrap().conn.clone()
    }

    pub async fn cancel(&self, session: &Session, thread: &ThreadId) -> anyhow::Result<()> {
        let Some(conn) = self.conn() else { return Ok(()) };
        let id = conn.acp_sessions.lock().unwrap().get(thread).cloned();
        if let Some(id) = id {
            conn.cx.send_notification(acp::CancelNotification::new(id))?;
        }
        // Pending permission requests of the Thread must be answered "cancelled" per ACP.
        let mut cancelled = Vec::new();
        self.update(session, |s| {
            let ids: Vec<String> =
                s.pending.iter().filter(|(_, p)| p.thread.as_ref() == Some(thread)).map(|(id, _)| id.clone()).collect();
            for id in ids {
                cancelled.push((id.clone(), s.pending.remove(&id).unwrap()));
            }
        });
        for (request_id, p) in cancelled {
            let _ = session.log().append(p.thread, EventKind::PermissionResolved {
                request_id,
                option_id: None,
                by: Resolver::Cancelled,
                rule_id: None,
            });
            let _ = p.responder.send(None);
        }
        Ok(())
    }

    pub fn resolve_permission(
        &self,
        session: &Session,
        request_id: &str,
        option_id: Option<String>,
    ) -> anyhow::Result<()> {
        // First answer wins: later answers find nothing pending.
        let mut pending = None;
        self.update(session, |s| pending = s.pending.remove(request_id));
        let Some(pending) = pending else {
            anyhow::bail!("permission request {request_id} is not pending");
        };
        session.log().append(pending.thread.clone(), EventKind::PermissionResolved {
            request_id: request_id.to_owned(),
            option_id: option_id.clone(),
            by: if option_id.is_some() { Resolver::View } else { Resolver::Cancelled },
            rule_id: None,
        })?;
        let kind = pending.options.iter().find(|o| Some(&o.option_id) == option_id.as_ref()).map(|o| o.kind.as_str());
        if let Some(rule) = remembered_rule(session, kind, &pending.facts) {
            let rule = session.policy().add(rule)?;
            session.log().append(None, EventKind::PermissionRuleAdded { rule })?;
        }
        session.log().sync()?;
        // Answer last so the Agent's follow-up lands after the resolution in the log.
        pending.responder.send(option_id)?;
        Ok(())
    }


    /// Stops the process of `generation` if it has been idle long enough. Returns `false` once
    /// that process is gone, ending its watchdog.
    fn stop_if_idle(&self, session: &Session, generation: u64) -> bool {
        let conn = {
            let s = self.state.lock().unwrap();
            let Some(conn) = s.conn.as_ref().filter(|c| c.generation == generation) else { return false };
            let idle = s.pending.is_empty()
                && s.turns.values().all(|n| *n == 0)
                && s.last_active.is_none_or(|t| t.elapsed() >= session.idle_timeout());
            if !idle || session.log().subscriber_count() > 0 {
                return true;
            }
            conn.clone()
        };
        conn.stop("idle");
        false
    }
}

impl AgentSlot {
    pub async fn authenticate(&self, session: &Session, method_id: String) -> anyhow::Result<()> {
        let conn = self.conn().ok_or_else(|| anyhow::anyhow!("the Agent is not running; send a message first"))?;
        conn.cx.send_request(acp::AuthenticateRequest::new(method_id.clone())).block_task().await?;
        session.log().append(None, EventKind::AgentUpdate {
            update: serde_json::json!({ "harness": "authenticated", "methodId": method_id }),
        })?;
        Ok(())
    }

    /// The launch spec plus the extra args and env of a terminal auth method.
    pub fn terminal_auth(
        &self,
        session: &Session,
        method_id: &str,
    ) -> anyhow::Result<(crate::api::AgentInfo, Vec<String>, HashMap<String, String>)> {
        let state = self.state.lock().unwrap();
        let m = state
            .auth_methods
            .iter()
            .find(|m| m.get("id").and_then(Value::as_str) == Some(method_id))
            .ok_or_else(|| anyhow::anyhow!("unknown auth method {method_id}"))?;
        anyhow::ensure!(m.get("type").and_then(Value::as_str) == Some("terminal"), "{method_id} is not a terminal auth method");
        let args = serde_json::from_value(m.get("args").cloned().unwrap_or(Value::Null)).unwrap_or_default();
        let env = serde_json::from_value(m.get("env").cloned().unwrap_or(Value::Null)).unwrap_or_default();
        let meta = session.meta();
        Ok((session.agents().get(&meta.agent.id).unwrap_or(meta.agent), args, env))
    }

    /// Stops the Agent process, if running (e.g. on archive). The next prompt starts it again.
    pub fn shutdown(&self, reason: &str) {
        if let Some(conn) = self.conn() {
            conn.stop(reason);
        }
    }
}

impl AgentConn {
    fn stop(&self, reason: &str) {
        *self.stop_reason.lock().unwrap() = Some(reason.to_owned());
        if let Some(tx) = self.shutdown.lock().unwrap().take() {
            let _ = tx.send(());
        }
    }
}

/// Starts a Turn: ensures the Agent process and the Thread's Agent Session, then sends the prompt
/// in the background. Returns once the Turn has started. Attachments are checked first: a rejected
/// one fails the prompt before any Turn is logged.
pub async fn prompt(session: Arc<Session>, thread: ThreadId, text: String, attachments: Vec<AttachmentInput>) -> anyhow::Result<()> {
    let meta = session.meta();
    anyhow::ensure!(!meta.archived, "this Session is archived; unarchive it first");
    anyhow::ensure!(
        !meta.read_only_threads.contains(&thread),
        "this Thread is read-only; continue it with a summary"
    );
    let folder = std::path::PathBuf::from(&meta.folder);
    let tracked = meta.workspace.repo_root.is_some();
    let before = if tracked { crate::workspace::snapshot(&folder).await.ok() } else { None };
    let conn = ensure_conn(&session).await?;
    let acp_session = match ensure_agent_session(&session, &conn, &thread).await {
        Err(e) if is_auth_required(&e) => {
            report_auth_required(&session, Some(&thread), &e.to_string());
            anyhow::bail!("The Agent needs you to sign in first.");
        }
        r => r?,
    };
    let Some(acp_session) = acp_session else {
        let reason = "The Agent could not continue its previous Agent Session.".to_owned();
        session.update_meta(|m| m.read_only_threads.insert(thread.clone()))?;
        session.log().append(Some(thread.clone()), EventKind::ThreadReadOnly { reason: reason.clone() })?;
        session.log().sync()?;
        anyhow::bail!("{reason} The Thread is read-only; continue it with a summary.");
    };
    let caps = &conn.init.agent_capabilities.prompt_capabilities;
    let attachments = crate::attachments::resolve(session.dir(), &folder, &meta.agent.name, caps, attachments)?;
    crate::attachments::store(&attachments)?;
    let seed = session.update_meta(|m| m.seeds.remove(&thread))?;
    let turn_id = uuid::Uuid::now_v7().to_string();
    session.log().append(Some(thread.clone()), EventKind::TurnStarted {
        turn_id: turn_id.clone(),
        text: text.clone(),
        attachments: attachments.iter().map(|a| a.attachment.clone()).collect(),
    })?;
    let slot = session.agent_slot();
    slot.update(&session, |s| *s.turns.entry(thread.clone()).or_default() += 1);
    tokio::spawn(async move {
        let mut blocks = Vec::new();
        if let Some(seed) = seed {
            blocks.push(acp::ContentBlock::Text(acp::TextContent::new(format!("<context>\n{seed}\n</context>"))));
        }
        if !text.is_empty() || attachments.is_empty() {
            blocks.push(acp::ContentBlock::Text(acp::TextContent::new(text)));
        }
        blocks.extend(attachments.into_iter().map(|a| a.block));
        let request = acp::PromptRequest::new(acp_session, blocks);
        let stop_reason = match conn.cx.send_request(request).block_task().await {
            Ok(r) => enum_str(&r.stop_reason),
            Err(e) if e.code == agent_client_protocol::ErrorCode::AuthRequired => {
                report_auth_required(&session, Some(&thread), &e.message);
                "auth_required".to_owned()
            }
            Err(e) => {
                let message = if agent_client_protocol::is_incoming_transport_closed(&e) {
                    "The Agent process ended during this Turn. Your next message restarts it.".to_owned()
                } else {
                    e.to_string()
                };
                let _ = session.log().append(Some(thread.clone()), EventKind::Error { message });
                "error".to_owned()
            }
        };
        if let Some(from_tree) = before
            && let Ok(to_tree) = crate::workspace::snapshot(&folder).await
            && to_tree != from_tree
            && let Ok(diff) = crate::workspace::diff(&folder, &from_tree, &to_tree).await
        {
            let _ = session.log().append(Some(thread.clone()), EventKind::WorkspaceChanged {
                turn_id: turn_id.clone(),
                from_tree,
                to_tree,
                files: diff.files,
            });
        }
        let _ = session.log().append(Some(thread.clone()), EventKind::TurnEnded { turn_id, stop_reason: stop_reason.clone() });
        let meta = session.meta();
        session.shared().app_events.emit(crate::api::AppEvent::TurnFinished { session_id: meta.id, title: meta.title, stop_reason });
        let _ = session.log().sync();
        let slot = session.agent_slot();
        slot.update(&session, |s| {
            if let Some(n) = s.turns.get_mut(&thread) {
                *n = n.saturating_sub(1);
            }
            if s.turns.values().all(|n| *n == 0) {
                s.tool_calls.clear();
            }
        });
    });
    Ok(())
}

/// MCP servers for a Thread's Agent Session: the Harness MCP (HTTP, or the stdio shim) plus the
/// Session's MCP Library servers.
async fn mcp_servers(session: &Arc<Session>, conn: &AgentConn, thread: &ThreadId) -> anyhow::Result<Vec<acp::McpServer>> {
    let shared = session.shared();
    let http_ok = conn.init.agent_capabilities.mcp_capabilities.http;
    let url = shared.mcp.url().await?;
    let token = shared.mcp.issue(session, thread);
    let mut out = Vec::new();
    if http_ok {
        out.push(acp::McpServer::Http(
            acp::McpServerHttp::new("harness", url).headers(vec![acp::HttpHeader::new("Authorization", format!("Bearer {token}"))]),
        ));
    } else if let Some((command, args)) = &shared.mcp_shim {
        out.push(acp::McpServer::Stdio(acp::McpServerStdio::new("harness", command).args(args.clone()).env(vec![
            acp::EnvVariable::new("HARNESS_MCP_URL", url),
            acp::EnvVariable::new("HARNESS_MCP_TOKEN", token),
        ])));
    }
    for id in session.meta().mcp_servers {
        let def = shared.library.resolve(&id)?;
        match def.transport {
            crate::api::McpTransport::Stdio { command, args, env } => {
                let mut env: Vec<acp::EnvVariable> = env.into_iter().map(|(k, v)| acp::EnvVariable::new(k, v)).collect();
                if !env.iter().any(|e| e.name == "PATH") {
                    env.push(acp::EnvVariable::new("PATH", shared.agents.toolchain.path()));
                }
                out.push(acp::McpServer::Stdio(acp::McpServerStdio::new(def.id, command).args(args).env(env)));
            }
            crate::api::McpTransport::Http { url, headers } if http_ok => {
                let headers = headers.into_iter().map(|(k, v)| acp::HttpHeader::new(k, v)).collect();
                out.push(acp::McpServer::Http(acp::McpServerHttp::new(def.id, url).headers(headers)));
            }
            crate::api::McpTransport::Http { .. } => {
                session.log().append(Some(thread.clone()), EventKind::Error {
                    message: format!("{} is an HTTP MCP server, which this Agent does not support; skipped.", def.name),
                })?;
            }
        }
    }
    Ok(out)
}

/// The Thread's Agent Session, starting the Agent (and resuming its session) if needed.
async fn live_agent_session(session: &Arc<Session>, thread: &ThreadId) -> anyhow::Result<(Arc<AgentConn>, acp::SessionId)> {
    let meta = session.meta();
    anyhow::ensure!(!meta.archived, "this Session is archived; unarchive it first");
    anyhow::ensure!(!meta.read_only_threads.contains(thread), "this Thread is read-only; continue it with a summary");
    let conn = ensure_conn(session).await?;
    match ensure_agent_session(session, &conn, thread).await {
        Ok(Some(id)) => Ok((conn, id)),
        Ok(None) => anyhow::bail!("the Agent could not continue its previous Agent Session; send a message to continue with a summary"),
        Err(e) if is_auth_required(&e) => {
            report_auth_required(session, Some(thread), &e.to_string());
            anyhow::bail!("The Agent needs you to sign in first.")
        }
        Err(e) => Err(e),
    }
}

/// Starts the Agent and the Thread's Agent Session without prompting.
pub async fn warm_up(session: Arc<Session>, thread: ThreadId) -> anyhow::Result<()> {
    live_agent_session(&session, &thread).await.map(|_| ())
}

/// Sets a config option. Agents answer with the full option list and may not also send an
/// update notification (Codex doesn't), so the answer is logged.
pub async fn set_config_option(session: Arc<Session>, thread: ThreadId, config_id: String, value: String) -> anyhow::Result<()> {
    let (conn, id) = live_agent_session(&session, &thread).await?;
    let r = conn.cx.send_request(acp::SetSessionConfigOptionRequest::new(id, config_id.clone(), value.as_str())).block_task().await?;
    session.log().append(Some(thread), EventKind::ConfigOptionsChanged { options: serde_json::to_value(&r.config_options)? })?;
    if let Err(e) = session.shared().agents.remember_config(&session.meta().agent.id, &config_id, &value) {
        tracing::warn!("could not remember config option: {e:#}");
    }
    Ok(())
}

/// Sets the legacy session mode; its answer carries no state, so the change is logged here.
pub async fn set_mode(session: Arc<Session>, thread: ThreadId, mode_id: String) -> anyhow::Result<()> {
    let (conn, id) = live_agent_session(&session, &thread).await?;
    conn.cx.send_request(acp::SetSessionModeRequest::new(id, mode_id.clone())).block_task().await?;
    session.log().append(Some(thread), EventKind::ModeChanged { mode_id })?;
    Ok(())
}

/// Starts a fresh Agent Session for the Thread whose Context Seed is a summary of the Thread so far.
pub async fn continue_with_summary(session: Arc<Session>, thread: ThreadId) -> anyhow::Result<()> {
    let summary = crate::summary::summarize(&session.log().events()?, &thread);
    let conn = ensure_conn(&session).await?;
    conn.acp_sessions.lock().unwrap().remove(&thread);
    new_agent_session(&session, &conn, &thread, Boundary::ContinuedWithSummary).await?;
    session.update_meta(|m| {
        m.read_only_threads.remove(&thread);
        m.seeds.insert(thread.clone(), summary);
    })?;
    session.log().sync()?;
    Ok(())
}

async fn ensure_conn(session: &Arc<Session>) -> anyhow::Result<Arc<AgentConn>> {
    let slot = session.agent_slot();
    let _guard = slot.start.lock().await;
    if let Some(conn) = slot.conn() {
        return Ok(conn);
    }
    let conn = spawn_agent(session.clone()).await?;
    slot.update(session, |s| s.conn = Some(conn.clone()));
    spawn_watchdog(Arc::downgrade(session), conn.generation);
    Ok(conn)
}

/// Stops the Agent process once it is idle and no View is open (see `Shared::idle_timeout`).
fn spawn_watchdog(session: Weak<Session>, generation: u64) {
    tokio::spawn(async move {
        loop {
            let tick = match session.upgrade() {
                Some(s) => (s.idle_timeout() / 4).clamp(Duration::from_millis(50), Duration::from_secs(30)),
                None => return,
            };
            tokio::time::sleep(tick).await;
            let Some(s) = session.upgrade() else { return };
            if !s.agent_slot().stop_if_idle(&s, generation) {
                return;
            }
        }
    });
}

/// The Thread's Agent Session: the live one, else the previous one resumed or loaded, else a new
/// one if the Thread never had one. `None` when a previous Agent Session cannot be continued.
async fn ensure_agent_session(
    session: &Arc<Session>,
    conn: &Arc<AgentConn>,
    thread: &ThreadId,
) -> anyhow::Result<Option<acp::SessionId>> {
    let _guard = session.agent_slot().setup.lock().await;
    if let Some(id) = conn.acp_sessions.lock().unwrap().get(thread) {
        return Ok(Some(id.clone()));
    }
    let meta = session.meta();
    let Some(prev) = meta.agent_sessions.get(thread).cloned() else {
        return Ok(Some(new_agent_session(session, conn, thread, Boundary::Initial).await?));
    };
    let cwd = std::path::PathBuf::from(&meta.folder);
    let caps = &conn.init.agent_capabilities;
    let prev_id = acp::SessionId::new(prev);
    let mut boundary = None;
    if caps.session_capabilities.resume.is_some() {
        match conn.cx
            .send_request(acp::ResumeSessionRequest::new(prev_id.clone(), cwd.clone()).mcp_servers(mcp_servers(session, conn, thread).await?))
            .block_task()
            .await {
            Ok(_) => boundary = Some(Boundary::Resumed),
            Err(e) if e.code == agent_client_protocol::ErrorCode::AuthRequired => return Err(e.into()),
            Err(e) => tracing::warn!("resume failed: {e}"),
        }
    }
    if boundary.is_none() && caps.load_session {
        conn.replaying.store(true, Ordering::SeqCst);
        let r = conn.cx
            .send_request(acp::LoadSessionRequest::new(prev_id.clone(), cwd).mcp_servers(mcp_servers(session, conn, thread).await?))
            .block_task()
            .await;
        conn.replaying.store(false, Ordering::SeqCst);
        match r {
            Ok(_) => boundary = Some(Boundary::Loaded),
            Err(e) if e.code == agent_client_protocol::ErrorCode::AuthRequired => return Err(e.into()),
            Err(e) => tracing::warn!("load failed: {e}"),
        }
    }
    let Some(boundary) = boundary else { return Ok(None) };
    conn.acp_sessions.lock().unwrap().insert(thread.clone(), prev_id.clone());
    session.log().append(Some(thread.clone()), EventKind::AgentSessionStarted {
        acp_session_id: prev_id.to_string(),
        boundary,
    })?;
    Ok(Some(prev_id))
}

/// Sets the config option values last picked for this Agent on a brand-new Agent Session, in the
/// Agent's own option order (e.g. model before effort, whose choices can depend on it). Skips values
/// already current and any the Agent rejects. Returns the resulting options.
async fn apply_remembered_config(session: &Arc<Session>, conn: &Arc<AgentConn>, id: &acp::SessionId, mut options: Value) -> Value {
    let remembered = session.shared().agents.remembered_config(&session.meta().agent.id);
    if remembered.is_empty() {
        return options;
    }
    let ids: Vec<String> = options.as_array().into_iter().flatten().filter_map(|o| o["id"].as_str().map(str::to_owned)).collect();
    for config_id in ids {
        let Some(value) = remembered.get(&config_id) else { continue };
        let current = options.as_array().and_then(|a| a.iter().find(|o| o["id"] == config_id.as_str())).map(|o| o["currentValue"].clone());
        match current {
            None => continue,
            Some(c) if c == value.as_str() => continue,
            _ => {}
        }
        match conn.cx.send_request(acp::SetSessionConfigOptionRequest::new(id.clone(), config_id.clone(), value.as_str())).block_task().await {
            Ok(r) => match serde_json::to_value(&r.config_options) {
                Ok(o) => options = o,
                Err(e) => tracing::warn!("config options: {e}"),
            },
            Err(e) => tracing::warn!("remembered {config_id}={value} rejected: {e}"),
        }
    }
    options
}

async fn new_agent_session(
    session: &Arc<Session>,
    conn: &Arc<AgentConn>,
    thread: &ThreadId,
    boundary: Boundary,
) -> anyhow::Result<acp::SessionId> {
    let cwd = std::path::PathBuf::from(session.meta().folder);
    let servers = mcp_servers(session, conn, thread).await?;
    let r = conn.cx.send_request(acp::NewSessionRequest::new(cwd).mcp_servers(servers)).block_task().await?;
    let mut options = r.config_options.map(serde_json::to_value).transpose()?;
    if boundary == Boundary::Initial && let Some(o) = options.take() {
        options = Some(apply_remembered_config(session, conn, &r.session_id, o).await);
    }
    if let Some(options) = options {
        session.log().append(Some(thread.clone()), EventKind::ConfigOptionsChanged { options })?;
    }
    if let Some(modes) = &r.modes {
        session.log().append(Some(thread.clone()), EventKind::ModeChanged {
            mode_id: modes.current_mode_id.to_string(),
        })?;
    }
    let id = r.session_id;
    conn.acp_sessions.lock().unwrap().insert(thread.clone(), id.clone());
    session.update_meta(|m| m.agent_sessions.insert(thread.clone(), id.to_string()))?;
    session.log().append(Some(thread.clone()), EventKind::AgentSessionStarted {
        acp_session_id: id.to_string(),
        boundary,
    })?;
    Ok(id)
}

async fn spawn_agent(session: Arc<Session>) -> anyhow::Result<Arc<AgentConn>> {
    let meta = session.meta();
    let log = |kind| {
        let _ = session.log().append(None, kind);
    };
    log(EventKind::AgentProcessState { state: ProcessState::Starting, message: None });

    // Last stderr lines, attached to startup and crash reports.
    let stderr: Arc<Mutex<std::collections::VecDeque<String>>> = Default::default();
    // The current install wins over the launch spec the Session was created with (updates).
    let spec = session.agents().get(&meta.agent.id).unwrap_or(meta.agent.clone());
    // `env -u` strips leaked host vars; PATH puts the managed toolchain before the login-shell PATH.
    let mut args: Vec<String> = Vec::new();
    for var in crate::agent_quirks::stripped_env() {
        args.push("-u".into());
        args.push(var);
    }
    args.push(format!("PATH={}", session.agents().toolchain.path()));
    for (k, v) in &spec.env {
        args.push(format!("{k}={v}"));
    }
    args.push(spec.command.clone());
    args.extend(spec.args.iter().cloned());
    let agent = AcpAgent::new(agent_client_protocol::AcpAgentConfig::new("/usr/bin/env").args(args))
        .with_debug({
            let tail = stderr.clone();
            move |line, dir| {
                if matches!(dir, LineDirection::Stderr) {
                    tracing::debug!(target: "agent_stderr", "{line}");
                    let mut t = tail.lock().unwrap();
                    if t.len() == STDERR_TAIL {
                        t.pop_front();
                    }
                    t.push_back(line.to_owned());
                }
            }
        });

    let generation = GENERATION.fetch_add(1, Ordering::SeqCst);
    let replaying = Arc::new(AtomicBool::new(false));
    let stop_reason = Arc::new(Mutex::new(None::<String>));
    let (ready_tx, ready_rx) = oneshot::channel::<Result<(ConnectionTo<Agent>, acp::InitializeResponse), String>>();
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

    let s_notify = session.clone();
    let s_perm = session.clone();
    let s_exit = session.clone();
    let replaying_n = replaying.clone();
    let stop_reason_exit = stop_reason.clone();
    let stderr_exit = stderr.clone();
    tokio::spawn(async move {
        let result = Client
            .builder()
            .name("harness")
            .on_receive_notification(
                async move |n: acp::SessionNotification, _cx| {
                    if !replaying_n.load(Ordering::SeqCst) {
                        on_update(&s_notify, &n);
                    }
                    Ok(())
                },
                agent_client_protocol::on_receive_notification!(),
            )
            .on_receive_request(
                async move |req: acp::RequestPermissionRequest, responder, _cx| {
                    on_permission(&s_perm, req, responder);
                    Ok(())
                },
                agent_client_protocol::on_receive_request!(),
            )
            .connect_with(agent, |cx: ConnectionTo<Agent>| async move {
                let init = cx
                    .send_request(
                        acp::InitializeRequest::new(ProtocolVersion::V1)
                            // Notices: Agents send hook/SDK messages as `notice` instead of
                            // bold-label text glued into the reply.
                            .client_capabilities(acp::ClientCapabilities::new().session(
                                acp::ClientSessionCapabilities::new().notices(acp::NoticeCapabilities::new()),
                            ))
                            .client_info(acp::Implementation::new("harness", env!("CARGO_PKG_VERSION"))),
                    )
                    .block_task()
                    .await;
                match init {
                    Ok(init) => {
                        let _ = ready_tx.send(Ok((cx.clone(), init)));
                        // Ends on our shutdown or when the Agent hangs up; a killed adapter can
                        // close its stdout while a parent (npx) lingers.
                        tokio::select! {
                            _ = shutdown_rx => {}
                            _ = cx.incoming_closed() => {}
                        }
                    }
                    Err(e) => {
                        let _ = ready_tx.send(Err(e.to_string()));
                    }
                }
                Ok(())
            })
            .await;
        let stopped = stop_reason_exit.lock().unwrap().clone();
        let error = result.err().map(|e| with_tail(e.to_string(), &stderr_exit));
        on_exit(&s_exit, generation, stopped, error);
    });

    let started = match ready_rx.await {
        Ok(Ok(r)) => Ok(r),
        Ok(Err(e)) if !e.contains("incoming_transport_closed") => Err(format!("The Agent did not start (initialize failed: {e}).")),
        Ok(Err(_)) | Err(_) => Err(format!("The Agent process exited during startup ({} {}).", spec.command, spec.args.join(" "))),
    };
    let (cx, init) = match started {
        Ok(r) => r,
        Err(message) => {
            // Give stderr a moment to arrive; it usually explains the failure.
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            let message = with_tail(message, &stderr);
            log(EventKind::AgentProcessState { state: ProcessState::Failed, message: Some(message.clone()) });
            anyhow::bail!(message);
        }
    };
    log(EventKind::AgentProcessState { state: ProcessState::Ready, message: None });
    let prompt_caps = &init.agent_capabilities.prompt_capabilities;
    log(EventKind::AgentCapabilities { image: prompt_caps.image, embedded_context: prompt_caps.embedded_context });
    let methods = init.auth_methods.iter().filter_map(|m| serde_json::to_value(m).ok()).collect();
    session.agent_slot().state.lock().unwrap().auth_methods = methods;
    Ok(Arc::new(AgentConn {
        generation,
        cx,
        init,
        acp_sessions: Mutex::new(HashMap::new()),
        replaying,
        stop_reason,
        shutdown: Mutex::new(Some(shutdown_tx)),
    }))
}

/// The process is gone: forget its connection and cancel what it left pending. In-flight Turns
/// end on their own when their prompt request fails.
fn on_exit(session: &Arc<Session>, generation: u64, stopped: Option<String>, error: Option<String>) {
    let slot = session.agent_slot();
    let mut orphaned = Vec::new();
    let mut current = false;
    slot.update(session, |s| {
        if s.conn.as_ref().is_some_and(|c| c.generation == generation) {
            current = true;
            s.conn = None;
            orphaned = s.pending.drain().collect();
        }
    });
    for (request_id, p) in orphaned {
        let _ = session.log().append(p.thread, EventKind::PermissionResolved {
            request_id,
            option_id: None,
            by: Resolver::Cancelled,
            rule_id: None,
        });
    }
    if current {
        session.shared().mcp.revoke(session);
    }
    let on_purpose = stopped.is_some();
    let (state, message) = match (stopped, error) {
        (Some(reason), _) => (ProcessState::Stopped, Some(reason)),
        (None, Some(e)) => (ProcessState::Failed, Some(e)),
        (None, None) => (ProcessState::Exited, None),
    };
    if current || on_purpose {
        let _ = session.log().append(None, EventKind::AgentProcessState { state, message });
        let _ = session.log().sync();
    }
}

fn is_auth_required(e: &anyhow::Error) -> bool {
    e.downcast_ref::<agent_client_protocol::Error>().is_some_and(|e| e.code == agent_client_protocol::ErrorCode::AuthRequired)
}

fn report_auth_required(session: &Session, thread: Option<&ThreadId>, message: &str) {
    let methods = session
        .agent_slot()
        .state
        .lock()
        .unwrap()
        .auth_methods
        .iter()
        .map(|m| crate::api::AuthMethodInfo {
            id: m.get("id").and_then(Value::as_str).unwrap_or_default().to_owned(),
            name: m.get("name").and_then(Value::as_str).unwrap_or_default().to_owned(),
            description: m.get("description").and_then(Value::as_str).map(str::to_owned),
            kind: m.get("type").and_then(Value::as_str).unwrap_or("agent").to_owned(),
        })
        .collect();
    let _ = session.log().append(thread.cloned(), EventKind::AuthRequired { methods, message: message.to_owned() });
    let _ = session.log().sync();
}

fn thread_of(session: &Session, acp_session: &acp::SessionId) -> Option<ThreadId> {
    let meta = session.meta();
    meta.agent_sessions
        .iter()
        .find(|(_, id)| id.as_str() == acp_session.to_string())
        .map(|(t, _)| t.clone())
}

fn on_update(session: &Session, n: &acp::SessionNotification) {
    let thread = thread_of(session, &n.session_id);
    let update = serde_json::to_value(&n.update).unwrap_or(Value::Null);
    track_tool_call(session, &update);
    let mut kind = normalize(&update);
    crate::agent_quirks::adjust(&update, &mut kind);
    if let EventKind::SessionInfoUpdated { title: Some(t) } = &kind {
        session.set_agent_title(thread.as_ref(), t);
    }
    let _ = session.log().append(thread, kind);
}

fn track_tool_call(session: &Session, u: &Value) {
    let Some(id) = u.get("toolCallId").and_then(Value::as_str) else { return };
    let mut state = session.agent_slot().state.lock().unwrap();
    merge(state.tool_calls.entry(id.to_owned()).or_insert_with(|| Value::Object(Default::default())), u);
}

/// Overlays the non-null fields of `update` onto `base`.
fn merge(base: &mut Value, update: &Value) {
    if let (Some(b), Some(u)) = (base.as_object_mut(), update.as_object()) {
        for (k, v) in u {
            if !v.is_null() {
                b.insert(k.clone(), v.clone());
            }
        }
    }
}

/// Maps an ACP `session/update` (as JSON, camelCase) to a Harness event.
fn normalize(u: &Value) -> EventKind {
    let s = |k: &str| u.get(k).and_then(Value::as_str).map(str::to_owned);
    let text = || u.pointer("/content/text").and_then(Value::as_str).map(str::to_owned);
    match s("sessionUpdate").as_deref() {
        Some("agent_message_chunk") if text().is_some() => EventKind::AgentMessageChunk { text: text().unwrap() },
        Some("agent_thought_chunk") if text().is_some() => EventKind::AgentThoughtChunk { text: text().unwrap() },
        Some("tool_call") => EventKind::ToolCall {
            tool_call_id: s("toolCallId").unwrap_or_default(),
            title: s("title").unwrap_or_default(),
            kind: s("kind"),
            status: s("status"),
            content: u.get("content").cloned().unwrap_or(Value::Array(vec![])),
            locations: u.get("locations").cloned().unwrap_or(Value::Array(vec![])),
            raw_input: u.get("rawInput").cloned(),
            parent_tool_call_id: None,
            report: None,
        },
        Some("tool_call_update") => EventKind::ToolCallUpdate {
            tool_call_id: s("toolCallId").unwrap_or_default(),
            title: s("title"),
            kind: s("kind"),
            status: s("status"),
            content: u.get("content").cloned(),
            locations: u.get("locations").cloned(),
            raw_input: u.get("rawInput").cloned(),
            raw_output: u.get("rawOutput").cloned(),
            parent_tool_call_id: None,
            background: false,
        },
        Some("notice") => EventKind::AgentNotice {
            severity: s("severity").unwrap_or_else(|| "info".into()),
            title: s("title").unwrap_or_default(),
            description: s("description"),
        },
        Some("plan") => EventKind::TaskListUpdated {
            entries: u
                .get("entries")
                .and_then(Value::as_array)
                .map(|es| {
                    es.iter()
                        .map(|e| TaskEntry {
                            content: e.get("content").and_then(Value::as_str).unwrap_or_default().into(),
                            priority: e.get("priority").and_then(Value::as_str).unwrap_or_default().into(),
                            status: e.get("status").and_then(Value::as_str).unwrap_or_default().into(),
                        })
                        .collect()
                })
                .unwrap_or_default(),
        },
        Some("current_mode_update") => EventKind::ModeChanged { mode_id: s("currentModeId").unwrap_or_default() },
        Some("config_option_update") => {
            EventKind::ConfigOptionsChanged { options: u.get("configOptions").cloned().unwrap_or(Value::Null) }
        }
        Some("available_commands_update") => EventKind::AvailableCommandsChanged {
            commands: u
                .get("availableCommands")
                .and_then(Value::as_array)
                .map(|cs| {
                    cs.iter()
                        .map(|c| SlashCommand {
                            name: c.get("name").and_then(Value::as_str).unwrap_or_default().into(),
                            description: c.get("description").and_then(Value::as_str).unwrap_or_default().into(),
                            hint: c.pointer("/input/hint").and_then(Value::as_str).map(str::to_owned),
                        })
                        .collect()
                })
                .unwrap_or_default(),
        },
        Some("usage_update") => EventKind::UsageUpdated { usage: u.clone() },
        Some("session_info_update") => EventKind::SessionInfoUpdated { title: s("title") },
        _ => EventKind::AgentUpdate { update: u.clone() },
    }
}

fn on_permission(
    session: &Arc<Session>,
    req: acp::RequestPermissionRequest,
    responder: Responder<acp::RequestPermissionResponse>,
) {
    let request_id = uuid::Uuid::now_v7().to_string();
    let thread = thread_of(session, &req.session_id);
    let options: Vec<PermissionOption> = req
        .options
        .iter()
        .map(|o| PermissionOption {
            option_id: o.option_id.to_string(),
            name: o.name.clone(),
            kind: enum_str(&o.kind),
        })
        .collect();
    let slot = session.agent_slot();
    let requested = serde_json::to_value(&req.tool_call).unwrap_or(Value::Null);
    let mut tool_call = requested
        .get("toolCallId")
        .and_then(Value::as_str)
        .and_then(|id| slot.state.lock().unwrap().tool_calls.get(id).cloned())
        .unwrap_or_else(|| Value::Object(Default::default()));
    merge(&mut tool_call, &requested);

    let meta = session.meta();
    let folder = std::path::PathBuf::from(&meta.folder);
    let facts = crate::permissions::facts_of(&tool_call, &folder);
    let cx = crate::permissions::Context { session_id: &meta.id, agent_id: &meta.agent.id, folder: &folder };
    // Calls to the Harness MCP pass the Policy inside the Harness MCP itself; don't ask twice.
    let title = tool_call.get("title").and_then(Value::as_str).unwrap_or_default();
    let harness_tool = title.starts_with("mcp__harness__") || title.starts_with("mcp.harness.");
    let verdict = if harness_tool {
        crate::permissions::Verdict { decision: Decision::Allow, rule_id: None }
    } else {
        session.policy().evaluate(&cx, &facts)
    };
    let auto = match verdict.decision {
        Decision::Allow => pick(&options, &["allow_once", "allow_always"]),
        Decision::Deny => pick(&options, &["reject_once", "reject_always"]),
        Decision::Ask => None,
    };

    let _ = session.log().append(thread.clone(), EventKind::PermissionRequested {
        request_id: request_id.clone(),
        tool_call,
        options: options.clone(),
    });
    if let Some(option_id) = auto {
        let _ = session.log().append(thread.clone(), EventKind::PermissionResolved {
            request_id,
            option_id: Some(option_id.clone()),
            by: Resolver::Policy,
            rule_id: verdict.rule_id,
        });
        let _ = session.log().sync();
        let _ = responder.respond(acp::RequestPermissionResponse::new(acp::RequestPermissionOutcome::Selected(
            acp::SelectedPermissionOutcome::new(option_id),
        )));
        return;
    }
    slot.update(session, |s| {
        s.pending.insert(request_id, Pending { thread, responder: Answer::Acp(responder), options, facts });
    });
    let _ = session.log().sync();
}

/// Checks a Harness MCP tool call against the Permission Policy, asking the user when the Policy
/// says so. Errors when denied.
pub async fn authorize(
    session: &Arc<Session>,
    thread: &ThreadId,
    tool: &str,
    title: &str,
    kind: &str,
    args: &Value,
) -> anyhow::Result<()> {
    let meta = session.meta();
    let folder = std::path::PathBuf::from(&meta.folder);
    let tool_call = serde_json::json!({
        "toolCallId": format!("harness-{}", uuid::Uuid::now_v7()),
        "title": title,
        "kind": kind,
        "rawInput": args,
        "_meta": { "harnessTool": tool },
    });
    let facts = crate::permissions::facts_of(&tool_call, &folder);
    let cx = crate::permissions::Context { session_id: &meta.id, agent_id: &meta.agent.id, folder: &folder };
    let verdict = session.policy().evaluate(&cx, &facts);
    if verdict.decision == Decision::Allow {
        return Ok(());
    }
    let request_id = uuid::Uuid::now_v7().to_string();
    let options = vec![
        PermissionOption { option_id: "allow".into(), name: "Allow".into(), kind: "allow_once".into() },
        PermissionOption { option_id: "always".into(), name: "Always allow".into(), kind: "allow_always".into() },
        PermissionOption { option_id: "reject".into(), name: "Deny".into(), kind: "reject_once".into() },
    ];
    session.log().append(Some(thread.clone()), EventKind::PermissionRequested {
        request_id: request_id.clone(),
        tool_call,
        options: options.clone(),
    })?;
    if verdict.decision == Decision::Deny {
        session.log().append(Some(thread.clone()), EventKind::PermissionResolved {
            request_id,
            option_id: Some("reject".into()),
            by: Resolver::Policy,
            rule_id: verdict.rule_id,
        })?;
        anyhow::bail!("denied by the Harness Permission Policy");
    }
    let (tx, rx) = oneshot::channel();
    session.agent_slot().update(session, |s| {
        s.pending.insert(request_id, Pending { thread: Some(thread.clone()), responder: Answer::Local(tx), options, facts });
    });
    session.log().sync()?;
    match rx.await {
        Ok(Some(o)) if o != "reject" => Ok(()),
        Ok(Some(_)) => anyhow::bail!("the user denied this"),
        _ => anyhow::bail!("cancelled"),
    }
}

/// First option of the preferred kinds, in order.
fn pick(options: &[PermissionOption], kinds: &[&str]) -> Option<String> {
    kinds.iter().find_map(|k| options.iter().find(|o| o.kind == *k)).map(|o| o.option_id.clone())
}

/// An "always" answer becomes a Session rule: the exact command for `execute`, else the whole kind.
fn remembered_rule(
    session: &Session,
    option_kind: Option<&str>,
    facts: &crate::permissions::ToolFacts,
) -> Option<NewPermissionRule> {
    let decision = match option_kind? {
        "allow_always" => Decision::Allow,
        "reject_always" => Decision::Deny,
        _ => return None,
    };
    let kind = facts.kind.clone().filter(|k| k != "switch_mode")?;
    let pattern = if kind == "execute" { Some(facts.command.clone()?) } else { None };
    Some(NewPermissionRule {
        scope: RuleScope::Session { session_id: session.id() },
        tool_kind: Some(kind),
        pattern,
        decision,
    })
}

fn enum_str<T: serde::Serialize>(v: &T) -> String {
    match serde_json::to_value(v) {
        Ok(Value::String(s)) => s,
        Ok(other) => other.to_string(),
        Err(_) => String::new(),
    }
}


