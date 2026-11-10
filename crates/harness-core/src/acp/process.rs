//! Agent process lifecycle: the per-Session slot, spawn, watchdog, exit and shutdown.

use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::schema::v1 as acp;
use agent_client_protocol::{AcpAgent, Agent, Client, ConnectionTo, LineDirection, Responder};
use serde_json::Value;
use tokio::sync::{Mutex as AsyncMutex, oneshot};

use super::normalize::on_update;
use super::permission::{on_permission, remembered_rule};
use super::thread_of;
use crate::api::{EventKind, PermissionOption, ProcessState, Resolver, SessionStatus, ThreadId};
use crate::session::Session;

/// Agent stderr lines kept for error reports.
pub(super) const STDERR_TAIL: usize = 30;

pub(crate) fn with_tail(message: String, tail: &Mutex<std::collections::VecDeque<String>>) -> String {
    let t = tail.lock();
    if t.is_empty() { message } else { format!("{message}\n\nAgent output (stderr):\n{}", t.iter().cloned().collect::<Vec<_>>().join("\n")) }
}

/// Distinguishes Agent processes of one Session, so a late exit never clears its successor.
pub(super) static GENERATION: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
pub struct AgentSlot {
    /// Serializes connection startup.
    pub(super) start: AsyncMutex<()>,
    /// Serializes Agent Session setup (warm-up racing the first prompt must not open two).
    pub(super) setup: AsyncMutex<()>,
    pub(super) state: Mutex<SlotState>,
}

#[derive(Default)]
pub(super) struct SlotState {
    pub(super) conn: Option<Arc<AgentConn>>,
    /// Turns in flight, per Thread.
    pub(super) turns: HashMap<ThreadId, usize>,
    /// Prompts still starting the Agent or its Agent Session: not a Turn yet, but not idle either.
    pub(super) preparing: usize,
    /// Threads with a Cancel in flight: a permission request from the Agent meanwhile is answered
    /// "cancelled", and the Turn that ends is not reported as an error.
    pub(super) cancelling: std::collections::HashSet<ThreadId>,
    pub(super) pending: HashMap<String, Pending>,
    /// Latest known state of each tool call (merged updates), since permission requests may
    /// carry only an id and a title.
    pub(super) tool_calls: HashMap<String, Value>,
    pub(super) last_active: Option<Instant>,
    /// Auth methods from the last `initialize` (raw ACP JSON).
    pub(super) auth_methods: Vec<Value>,
}

pub(super) struct Preparing<'a>(&'a AgentSlot);

impl Drop for Preparing<'_> {
    fn drop(&mut self) {
        let mut s = self.0.state.lock();
        s.preparing = s.preparing.saturating_sub(1);
        s.last_active = Some(Instant::now());
    }
}

pub(super) struct Pending {
    pub(super) thread: Option<ThreadId>,
    pub(super) responder: Answer,
    pub(super) options: Vec<PermissionOption>,
    pub(super) facts: crate::permissions::ToolFacts,
}

/// Who waits for a permission answer: the Agent (ACP request) or the Harness itself (a Harness
/// MCP tool call). `None` means cancelled.
pub(super) enum Answer {
    Acp(Responder<acp::RequestPermissionResponse>),
    Local(oneshot::Sender<Option<String>>),
}

impl Answer {
    pub(super) fn send(self, option_id: Option<String>) -> anyhow::Result<()> {
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

pub(super) struct AgentConn {
    pub(super) generation: u64,
    pub(super) cx: ConnectionTo<Agent>,
    pub(super) init: acp::InitializeResponse,
    /// Agent Session per Thread.
    pub(super) acp_sessions: Mutex<HashMap<ThreadId, acp::SessionId>>,
    /// Drop notifications while `session/load` replays history (the Session Log already has it).
    pub(super) replaying: Arc<AtomicBool>,
    /// Drop notifications for Agent Sessions not yet mapped to a Thread while `session/fork` runs
    /// (a fork may replay the source's history under its new id).
    pub(super) forking: Arc<AtomicBool>,
    /// Why the Harness stopped the process, when it did so on purpose.
    pub(super) stop_reason: Arc<Mutex<Option<String>>>,
    pub(super) shutdown: Mutex<Option<oneshot::Sender<()>>>,
}

impl AgentSlot {
    pub fn status(&self) -> SessionStatus {
        Self::status_of(&self.state.lock())
    }

    pub(super) fn status_of(s: &SlotState) -> SessionStatus {
        if !s.pending.is_empty() {
            SessionStatus::NeedsAttention
        } else if s.turns.values().any(|n| *n > 0) {
            SessionStatus::Working
        } else {
            SessionStatus::Idle
        }
    }

    /// Applies `f` to the slot state and logs the Session status if it changed.
    pub(super) fn update(&self, session: &Session, f: impl FnOnce(&mut SlotState)) {
        let (before, after) = {
            let mut s = self.state.lock();
            let before = Self::status_of(&s);
            f(&mut s);
            s.last_active = Some(Instant::now());
            (before, Self::status_of(&s))
        };
        if before != after {
            session.set_status(after);
        }
    }

    /// Registers a pending permission request, then runs `announce` (logs the request), then logs
    /// the status change. Registered first so whoever sees the request can answer it at once;
    /// the status follows the request in the log.
    pub(super) fn add_pending(&self, session: &Session, request_id: String, pending: Pending, announce: impl FnOnce()) {
        let before = {
            let mut s = self.state.lock();
            let before = Self::status_of(&s);
            s.pending.insert(request_id, pending);
            s.last_active = Some(Instant::now());
            before
        };
        announce();
        let after = self.status();
        if before != after {
            session.set_status(after);
        }
    }

    pub(super) fn cancelling(&self, thread: &ThreadId) -> bool {
        self.state.lock().cancelling.contains(thread)
    }

    pub(super) fn conn(&self) -> Option<Arc<AgentConn>> {
        self.state.lock().conn.clone()
    }

    pub async fn cancel(&self, session: &Arc<Session>, thread: &ThreadId) -> anyhow::Result<()> {
        let Some(conn) = self.conn() else { return Ok(()) };
        let id = conn.acp_sessions.lock().get(thread).cloned();
        if let Some(id) = id {
            conn.cx.send_notification(acp::CancelNotification::new(id))?;
        }
        let in_turn = self.state.lock().turns.get(thread).is_some_and(|n| *n > 0);
        if in_turn {
            self.state.lock().cancelling.insert(thread.clone());
            // ACP wants the Agent to answer the prompt with `cancelled`. One that never does would
            // leave the Turn running forever, so after a grace period its process is stopped (the
            // next prompt restarts it and resumes the Agent Session).
            let (weak, thread, conn, grace) = (Arc::downgrade(session), thread.clone(), conn.clone(), session.shared().cancel_grace);
            tokio::spawn(async move {
                tokio::time::sleep(grace).await;
                let Some(session) = weak.upgrade() else { return };
                let stuck = {
                    let s = session.agent_slot().state.lock();
                    s.conn.as_ref().is_some_and(|c| c.generation == conn.generation) && s.cancelling.contains(&thread)
                };
                if stuck {
                    conn.stop("the Agent did not end the cancelled Turn");
                }
            });
        }
        // Pending permission requests of the Thread must be answered "cancelled" per ACP.
        let mut cancelled = Vec::new();
        self.update(session, |s| {
            let ids: Vec<String> = s.pending.iter().filter(|(_, p)| p.thread.as_ref() == Some(thread)).map(|(id, _)| id.clone()).collect();
            for id in ids {
                if let Some(p) = s.pending.remove(&id) {
                    cancelled.push((id, p));
                }
            }
        });
        for (request_id, p) in cancelled {
            let _ = session.log().append(p.thread, EventKind::PermissionResolved { request_id, option_id: None, by: Resolver::Cancelled, rule_id: None });
            let _ = p.responder.send(None);
        }
        Ok(())
    }

    pub fn resolve_permission(&self, session: &Session, request_id: &str, option_id: Option<String>, global: bool) -> anyhow::Result<()> {
        // First answer wins: later answers find nothing pending.
        let mut pending = None;
        self.update(session, |s| pending = s.pending.remove(request_id));
        let Some(pending) = pending else {
            return Err(crate::error::not_found(format!("permission request {request_id} is not pending")));
        };
        session.log().append(
            pending.thread.clone(),
            EventKind::PermissionResolved {
                request_id: request_id.to_owned(),
                option_id: option_id.clone(),
                by: if option_id.is_some() { Resolver::View } else { Resolver::Cancelled },
                rule_id: None,
            },
        )?;
        let kind = pending.options.iter().find(|o| Some(&o.option_id) == option_id.as_ref()).map(|o| o.kind.as_str());
        if let Some(rule) = remembered_rule(session, kind, &pending.facts, global) {
            let rule = session.policy().add(rule)?;
            session.log().append(None, EventKind::PermissionRuleAdded { rule })?;
        }
        session.log().sync()?;
        // Answer last so the Agent's follow-up lands after the resolution in the log.
        pending.responder.send(option_id)?;
        Ok(())
    }

    /// Marks a prompt as starting until the returned guard drops, so the idle watchdog never stops
    /// an Agent that a prompt is still starting or resuming (that can take longer than the idle
    /// timeout).
    pub(super) fn preparing(&self) -> Preparing<'_> {
        let mut s = self.state.lock();
        s.preparing += 1;
        s.last_active = Some(Instant::now());
        Preparing(self)
    }

    /// Stops the process of `generation` if it has been idle long enough. Returns `false` once
    /// that process is gone, ending its watchdog.
    pub(super) fn stop_if_idle(&self, session: &Session, generation: u64) -> bool {
        let conn = {
            let s = self.state.lock();
            let Some(conn) = s.conn.as_ref().filter(|c| c.generation == generation) else { return false };
            let idle = s.pending.is_empty()
                && s.preparing == 0
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
        let conn = self.conn().ok_or_else(|| crate::error::agent_unavailable("the Agent is not running; send a message first"))?;
        conn.cx.send_request(acp::AuthenticateRequest::new(method_id.clone())).block_task().await?;
        session.log().append(None, EventKind::AgentUpdate { update: serde_json::json!({ "harness": "authenticated", "methodId": method_id }) })?;
        Ok(())
    }

    /// The launch spec plus the extra args and env of a terminal auth method.
    pub fn terminal_auth(&self, session: &Session, method_id: &str) -> anyhow::Result<(crate::api::AgentInfo, Vec<String>, HashMap<String, String>)> {
        let state = self.state.lock();
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
    pub(super) fn stop(&self, reason: &str) {
        *self.stop_reason.lock() = Some(reason.to_owned());
        if let Some(tx) = self.shutdown.lock().take() {
            let _ = tx.send(());
        }
    }
}

pub(super) async fn ensure_conn(session: &Arc<Session>) -> anyhow::Result<Arc<AgentConn>> {
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
pub(super) fn spawn_watchdog(session: Weak<Session>, generation: u64) {
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

/// `env` arguments that launch `spec` the way the Harness runs Agents: `env -u` strips leaked
/// host vars; PATH puts the managed toolchain before the login-shell PATH; `overrides` go last.
pub(crate) fn launch_args(spec: &crate::api::AgentInfo, path: &str, overrides: &[(String, String)]) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    for var in crate::agent_quirks::stripped_env() {
        args.push("-u".into());
        args.push(var);
    }
    args.push(format!("PATH={path}"));
    // Quirk env goes before `spec.env` so a Custom Agent can override it.
    for (k, v) in crate::agent_quirks::extra_env() {
        args.push(format!("{k}={v}"));
    }
    for (k, v) in &spec.env {
        args.push(format!("{k}={v}"));
    }
    for (k, v) in overrides {
        args.push(format!("{k}={v}"));
    }
    args.push(spec.command.clone());
    args.extend(spec.args.iter().cloned());
    args
}

pub(super) async fn spawn_agent(session: Arc<Session>) -> anyhow::Result<Arc<AgentConn>> {
    let meta = session.meta();
    let log = |kind| {
        let _ = session.log().append(None, kind);
    };
    log(EventKind::AgentProcessState { state: ProcessState::Starting, message: None });

    // Last stderr lines, attached to startup and crash reports.
    let stderr: Arc<Mutex<std::collections::VecDeque<String>>> = Default::default();
    // The current install wins over the launch spec the Session was created with (updates).
    let spec = session.agents().get(&meta.agent.id).unwrap_or(meta.agent.clone());
    let args = launch_args(&spec, &session.agents().toolchain.path(), &[]);
    let agent = AcpAgent::new(agent_client_protocol::AcpAgentConfig::new("/usr/bin/env").args(args)).with_debug({
        let tail = stderr.clone();
        move |line, dir| {
            if matches!(dir, LineDirection::Stderr) {
                tracing::debug!(target: "agent_stderr", "{line}");
                let mut t = tail.lock();
                if t.len() == STDERR_TAIL {
                    t.pop_front();
                }
                t.push_back(line.to_owned());
            }
        }
    });

    let generation = GENERATION.fetch_add(1, Ordering::SeqCst);
    let replaying = Arc::new(AtomicBool::new(false));
    let forking = Arc::new(AtomicBool::new(false));
    let stop_reason = Arc::new(Mutex::new(None::<String>));
    let (ready_tx, ready_rx) = oneshot::channel::<Result<(ConnectionTo<Agent>, acp::InitializeResponse), String>>();
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

    let s_notify = session.clone();
    let s_perm = session.clone();
    let s_exit = session.clone();
    let replaying_n = replaying.clone();
    let forking_n = forking.clone();
    let stop_reason_exit = stop_reason.clone();
    let stderr_exit = stderr.clone();
    tokio::spawn(async move {
        let result = Client
            .builder()
            .name("harness")
            .on_receive_notification(
                async move |n: acp::SessionNotification, _cx| {
                    let fork_replay = forking_n.load(Ordering::SeqCst) && thread_of(&s_notify, &n.session_id).is_none();
                    if !replaying_n.load(Ordering::SeqCst) && !fork_replay {
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
                            .client_capabilities(
                                acp::ClientCapabilities::new().session(acp::ClientSessionCapabilities::new().notices(acp::NoticeCapabilities::new())),
                            )
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
        let stopped = stop_reason_exit.lock().clone();
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
    session.agent_slot().state.lock().auth_methods = methods;
    Ok(Arc::new(AgentConn {
        generation,
        cx,
        init,
        acp_sessions: Mutex::new(HashMap::new()),
        replaying,
        forking,
        stop_reason,
        shutdown: Mutex::new(Some(shutdown_tx)),
    }))
}

/// The process is gone: forget its connection and cancel what it left pending. In-flight Turns
/// end on their own when their prompt request fails.
pub(super) fn on_exit(session: &Arc<Session>, generation: u64, stopped: Option<String>, error: Option<String>) {
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
        let _ = session.log().append(p.thread, EventKind::PermissionResolved { request_id, option_id: None, by: Resolver::Cancelled, rule_id: None });
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
