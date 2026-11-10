//! Agent Session setup: resume, load, fork, new, continue with a summary, and config/mode setters.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use agent_client_protocol::schema::v1 as acp;
use serde_json::Value;

use super::process::{AgentConn, ensure_conn};
use super::{NOT_RESTORED, is_auth_required, report_auth_required};
use crate::api::{Boundary, EventKind, ForkPoint, ThreadId, ThreadStart};
use crate::session::Session;

/// MCP servers for a Thread's Agent Session: the Harness MCP (HTTP, or the stdio shim) plus the
/// Session's MCP Library servers.
pub(super) async fn mcp_servers(session: &Arc<Session>, conn: &AgentConn, thread: &ThreadId) -> anyhow::Result<Vec<acp::McpServer>> {
    let shared = session.shared();
    let http_ok = conn.init.agent_capabilities.mcp_capabilities.http;
    let url = shared.mcp.url().await?;
    let token = shared.mcp.issue(session, thread);
    let mut out = Vec::new();
    if http_ok {
        out.push(acp::McpServer::Http(acp::McpServerHttp::new("harness", url).headers(vec![acp::HttpHeader::new("Authorization", format!("Bearer {token}"))])));
    } else if let Some((command, args)) = &shared.mcp_shim {
        out.push(acp::McpServer::Stdio(
            acp::McpServerStdio::new("harness", command)
                .args(args.clone())
                .env(vec![acp::EnvVariable::new("HARNESS_MCP_URL", url), acp::EnvVariable::new("HARNESS_MCP_TOKEN", token)]),
        ));
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
                session.log().append(
                    Some(thread.clone()),
                    EventKind::Error { message: format!("{} is an HTTP MCP server, which this Agent does not support; skipped.", def.name) },
                )?;
            }
        }
    }
    Ok(out)
}

/// The Thread's Agent Session, starting the Agent (and resuming its session) if needed.
pub(super) async fn live_agent_session(session: &Arc<Session>, thread: &ThreadId) -> anyhow::Result<(Arc<AgentConn>, acp::SessionId)> {
    let meta = session.meta();
    if meta.archived {
        return Err(crate::error::conflict("this Session is archived; unarchive it first"));
    }
    let conn = ensure_conn(session).await?;
    match ensure_agent_session(session, &conn, thread).await {
        Ok(Some(id)) => Ok((conn, id)),
        Ok(None) => Err(crate::error::agent_unavailable(format!("{NOT_RESTORED} Try again, or continue from a transcript."))),
        Err(e) if is_auth_required(&e) => {
            report_auth_required(session, Some(thread), &e.to_string());
            Err(crate::error::auth_required("The Agent needs you to sign in first."))
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
    let mode = session.is_main(Some(&thread)) || {
        let events = session.log().events()?;
        events
            .iter()
            .rev()
            .find_map(|e| match &e.kind {
                EventKind::ConfigOptionsChanged { options } if e.thread_id.as_ref() == Some(&thread) => options.as_array().cloned(),
                _ => None,
            })
            .is_some_and(|o| o.iter().any(|o| o["id"] == config_id.as_str() && is_mode(o)))
    };
    anyhow::ensure!(mode, "Side Threads follow the Main Thread's config, except for the mode");
    let (conn, id) = live_agent_session(&session, &thread).await?;
    let r = conn.cx.send_request(acp::SetSessionConfigOptionRequest::new(id, config_id.clone(), value.as_str())).block_task().await?;
    let main = session.is_main(Some(&thread));
    session.log().append(Some(thread), EventKind::ConfigOptionsChanged { options: serde_json::to_value(&r.config_options)? })?;
    // A Side Thread's mode is a detour, not the user's choice for new Sessions.
    if main && let Err(e) = session.shared().agents.remember_config(&session.meta().agent.id, &config_id, &value) {
        tracing::warn!("could not remember config option: {e:#}");
    }
    Ok(())
}

/// A config option that is the Agent's mode (ACP category `mode`).
pub(super) fn is_mode(option: &Value) -> bool {
    crate::log::is_mode_option(option)
}

/// The legacy mode after config options were applied: the mode option's value when it names one of
/// the legacy modes (Agents keep both in step), else the mode the Agent answered with.
pub(super) fn current_mode(options: Option<&Value>, modes: &acp::SessionModeState) -> String {
    let set = options.and_then(Value::as_array).and_then(|a| a.iter().find(|o| is_mode(o))).and_then(|o| o["currentValue"].as_str());
    match set {
        Some(v) if modes.available_modes.iter().any(|m| m.id.to_string() == v) => v.to_owned(),
        _ => modes.current_mode_id.to_string(),
    }
}

/// Puts a new Side Thread Agent Session in the Agent's mode that asks before writes (a fork inherits
/// the Main Thread's mode, which may auto-approve). Returns the options to log.
pub(super) async fn start_asking(conn: &Arc<AgentConn>, id: &acp::SessionId, options: Value) -> Value {
    let Some(mode) = options.as_array().and_then(|a| a.iter().find(|o| is_mode(o))).cloned() else { return options };
    let values: Vec<&str> = mode["options"].as_array().into_iter().flatten().filter_map(|o| o["value"].as_str()).collect();
    let (Some(config_id), Some(asking)) = (mode["id"].as_str(), crate::agent_quirks::asking_mode(&values)) else { return options };
    if mode["currentValue"] == asking {
        return options;
    }
    match conn.cx.send_request(acp::SetSessionConfigOptionRequest::new(id.clone(), config_id.to_owned(), asking)).block_task().await {
        Ok(r) => serde_json::to_value(&r.config_options).unwrap_or(options),
        Err(e) => {
            tracing::warn!("asking mode for Side Thread: {e}");
            options
        }
    }
}

/// Gives a Side Thread the Main Thread's current config option values (model, effort, ...): Side
/// Threads follow the Main Thread, except for the mode, which is their own. Skips values the Side
/// Thread's Agent Session does not offer.
pub(super) async fn follow_main_config(session: &Arc<Session>, conn: &Arc<AgentConn>, thread: &ThreadId, id: &acp::SessionId) {
    let Ok(events) = session.log().events() else { return };
    let main = session.meta().main_thread_id;
    let latest = |t: &ThreadId| {
        events.iter().rev().find_map(|e| match &e.kind {
            EventKind::ConfigOptionsChanged { options } if e.thread_id.as_ref() == Some(t) => options.as_array().cloned(),
            _ => None,
        })
    };
    let (Some(wanted), Some(mut current)) = (latest(&main), latest(thread)) else { return };
    let mut changed = None;
    for w in &wanted {
        let (Some(config_id), Some(value)) = (w["id"].as_str(), w["currentValue"].as_str()) else { continue };
        let Some(c) = current.iter().find(|c| c["id"] == config_id) else { continue };
        if is_mode(c) {
            continue;
        }
        let offered = c["options"].as_array().into_iter().flatten().any(|o| o["value"] == value);
        if c["currentValue"] == value || !offered {
            continue;
        }
        match conn.cx.send_request(acp::SetSessionConfigOptionRequest::new(id.clone(), config_id.to_owned(), value)).block_task().await {
            Ok(r) => match serde_json::to_value(&r.config_options) {
                Ok(o) => {
                    current = o.as_array().cloned().unwrap_or_default();
                    changed = Some(o);
                }
                Err(e) => tracing::warn!("config options: {e}"),
            },
            Err(e) => tracing::warn!("Side Thread {config_id}={value} rejected: {e}"),
        }
    }
    if let Some(options) = changed {
        let _ = session.log().append(Some(thread.clone()), EventKind::ConfigOptionsChanged { options });
    }
}

/// Sets the legacy session mode; its answer carries no state, so the change is logged here.
pub async fn set_mode(session: Arc<Session>, thread: ThreadId, mode_id: String) -> anyhow::Result<()> {
    let (conn, id) = live_agent_session(&session, &thread).await?;
    conn.cx.send_request(acp::SetSessionModeRequest::new(id, mode_id.clone())).block_task().await?;
    session.log().append(Some(thread), EventKind::ModeChanged { mode_id })?;
    Ok(())
}

/// Starts a fresh Agent Session for the Thread whose Context Seed is a transcript of the Thread so far.
pub async fn continue_with_summary(session: Arc<Session>, thread: ThreadId) -> anyhow::Result<()> {
    let events = session.log().events()?;
    let summary = crate::summary::summarize(&events, &thread);
    let size = crate::summary::transcript_size(&events, &thread);
    let conn = ensure_conn(&session).await?;
    conn.acp_sessions.lock().remove(&thread);
    new_agent_session(&session, &conn, &thread, Boundary::ContinuedWithSummary, Some(size)).await?;
    session.update_meta(|m| {
        m.seeds.insert(thread.clone(), summary);
    })?;
    session.log().sync()?;
    Ok(())
}

/// The Thread's Agent Session: the live one, else the previous one resumed or loaded, else a new
/// one (a fork of the Main Thread's for a Side Thread, if it can) if the Thread never had one.
/// `None` when a previous Agent Session cannot be continued.
pub(super) async fn ensure_agent_session(session: &Arc<Session>, conn: &Arc<AgentConn>, thread: &ThreadId) -> anyhow::Result<Option<acp::SessionId>> {
    let _guard = session.agent_slot().setup.lock().await;
    if let Some(id) = conn.acp_sessions.lock().get(thread) {
        return Ok(Some(id.clone()));
    }
    let meta = session.meta();
    if let Some(prev) = meta.agent_sessions.get(thread) {
        return continue_previous(session, conn, thread, prev.clone()).await;
    }
    if let Some(origin) = meta.origins.get(thread) {
        if origin.source == ThreadStart::Fork
            && let Some(id) = fork_agent_session(session, conn, thread, &origin.point).await?
        {
            return Ok(Some(id));
        }
        // No fork: the Main Thread's transcript up to the fork point is the Context Seed.
        let events = session.log().events()?;
        if let Some(transcript) = crate::summary::side_thread_seed(&events, &origin.point.thread_id, origin.point.seq) {
            session.update_meta(|m| {
                let seed = match m.seeds.remove(thread) {
                    Some(own) => format!("{transcript}\n\n{own}"),
                    None => transcript,
                };
                m.seeds.insert(thread.clone(), seed);
            })?;
        }
    }
    Ok(Some(new_agent_session(session, conn, thread, Boundary::Initial, None).await?))
}

/// Resumes (else loads) the Thread's previous Agent Session, trying again a few times if that fails.
/// `None`, logged as `ThreadReadOnly`, when it could not: the Agent can do neither, or every try failed.
pub(super) async fn continue_previous(
    session: &Arc<Session>,
    conn: &Arc<AgentConn>,
    thread: &ThreadId,
    prev: String,
) -> anyhow::Result<Option<acp::SessionId>> {
    let caps = &conn.init.agent_capabilities;
    let retryable = caps.session_capabilities.resume.is_some() || caps.load_session;
    let prev_id = acp::SessionId::new(prev);
    let mut errors = Vec::new();
    if retryable {
        let retries = &session.shared().restore_retries;
        let of = retries.len() as u32;
        for (attempt, wait) in std::iter::once(None).chain(retries.iter().copied().map(Some)).enumerate() {
            if let Some(wait) = wait {
                session.log().append(Some(thread.clone()), EventKind::AgentSessionRestoring { attempt: attempt as u32, of })?;
                tokio::time::sleep(wait).await;
            }
            match restore_once(session, conn, thread, &prev_id).await? {
                Ok(boundary) => {
                    conn.acp_sessions.lock().insert(thread.clone(), prev_id.clone());
                    session
                        .log()
                        .append(Some(thread.clone()), EventKind::AgentSessionStarted { acp_session_id: prev_id.to_string(), boundary, transcript: None })?;
                    return Ok(Some(prev_id));
                }
                Err(e) => errors = e,
            }
        }
    }
    let transcript = Some(crate::summary::transcript_size(&session.log().events()?, thread));
    session.log().append(Some(thread.clone()), EventKind::ThreadReadOnly { reason: NOT_RESTORED.to_owned(), retryable, errors, transcript })?;
    session.log().sync()?;
    Ok(None)
}

/// One try at resume, else load. The inner `Err` holds why each failed; a sign-in error is the outer one.
pub(super) async fn restore_once(
    session: &Arc<Session>,
    conn: &Arc<AgentConn>,
    thread: &ThreadId,
    prev_id: &acp::SessionId,
) -> anyhow::Result<Result<Boundary, Vec<String>>> {
    let meta = session.meta();
    let cwd = std::path::PathBuf::from(&meta.folder);
    let caps = &conn.init.agent_capabilities;
    let mut errors = Vec::new();
    let mut boundary = None;
    if caps.session_capabilities.resume.is_some() {
        match conn
            .cx
            .send_request(acp::ResumeSessionRequest::new(prev_id.clone(), cwd.clone()).mcp_servers(mcp_servers(session, conn, thread).await?))
            .block_task()
            .await
        {
            Ok(_) => boundary = Some(Boundary::Resumed),
            Err(e) if e.code == agent_client_protocol::ErrorCode::AuthRequired => return Err(e.into()),
            Err(e) => {
                tracing::warn!("resume failed: {e}");
                errors.push(format!("resume: {e}"));
            }
        }
    }
    if boundary.is_none() && caps.load_session {
        conn.replaying.store(true, Ordering::SeqCst);
        let r =
            conn.cx.send_request(acp::LoadSessionRequest::new(prev_id.clone(), cwd).mcp_servers(mcp_servers(session, conn, thread).await?)).block_task().await;
        conn.replaying.store(false, Ordering::SeqCst);
        match r {
            Ok(_) => boundary = Some(Boundary::Loaded),
            Err(e) if e.code == agent_client_protocol::ErrorCode::AuthRequired => return Err(e.into()),
            Err(e) => {
                tracing::warn!("load failed: {e}");
                errors.push(format!("load: {e}"));
            }
        }
    }
    Ok(boundary.ok_or(errors))
}

/// Forks the Main Thread's Agent Session for a Side Thread. `None` (so: seed instead) when the
/// Agent cannot fork, the Main Thread has no Agent Session that can be continued or is mid-Turn
/// (the fork would catch a half-finished Turn), or the fork fails.
pub(super) async fn fork_agent_session(
    session: &Arc<Session>,
    conn: &Arc<AgentConn>,
    thread: &ThreadId,
    point: &ForkPoint,
) -> anyhow::Result<Option<acp::SessionId>> {
    let main = &point.thread_id;
    if conn.init.agent_capabilities.session_capabilities.fork.is_none() {
        return Ok(None);
    }
    if session.agent_slot().state.lock().turns.get(main).is_some_and(|n| *n > 0) {
        return Ok(None);
    }
    let live = conn.acp_sessions.lock().get(main).cloned();
    let source = match live {
        Some(id) => id,
        None => {
            let Some(prev) = session.meta().agent_sessions.get(main).cloned() else { return Ok(None) };
            match continue_previous(session, conn, main, prev).await {
                Ok(Some(id)) => id,
                Ok(None) => return Ok(None),
                Err(e) if is_auth_required(&e) => return Err(e),
                Err(e) => {
                    tracing::warn!("fork source: {e:#}");
                    return Ok(None);
                }
            }
        }
    };
    let cwd = std::path::PathBuf::from(session.meta().folder);
    let servers = mcp_servers(session, conn, thread).await?;
    // No `system_prompt`: the fork keeps the source's, which keeps the prompt cache warm.
    conn.forking.store(true, Ordering::SeqCst);
    let r = conn.cx.send_request(acp::ForkSessionRequest::new(source, cwd).mcp_servers(servers)).block_task().await;
    conn.forking.store(false, Ordering::SeqCst);
    let r = match r {
        Ok(r) => r,
        Err(e) if e.code == agent_client_protocol::ErrorCode::AuthRequired => return Err(e.into()),
        Err(e) => {
            tracing::warn!("fork failed: {e}");
            return Ok(None);
        }
    };
    let mut options = r.config_options.map(serde_json::to_value).transpose()?;
    if let Some(o) = options.take() {
        options = Some(start_asking(conn, &r.session_id, o).await);
    }
    if let Some(options) = &options {
        session.log().append(Some(thread.clone()), EventKind::ConfigOptionsChanged { options: options.clone() })?;
    }
    if let Some(modes) = &r.modes {
        session.log().append(Some(thread.clone()), EventKind::ModeChanged { mode_id: current_mode(options.as_ref(), modes) })?;
    }
    let id = r.session_id;
    conn.acp_sessions.lock().insert(thread.clone(), id.clone());
    session.update_meta(|m| {
        m.agent_sessions.insert(thread.clone(), id.to_string());
        m.fork_note_pending.insert(thread.clone());
    })?;
    session
        .log()
        .append(Some(thread.clone()), EventKind::AgentSessionStarted { acp_session_id: id.to_string(), boundary: Boundary::Forked, transcript: None })?;
    Ok(Some(id))
}

/// Sets the config option values last picked for this Agent on a brand-new Agent Session, in the
/// Agent's own option order (e.g. model before effort, whose choices can depend on it). Skips values
/// already current and any the Agent rejects. Returns the resulting options.
pub(super) async fn apply_remembered_config(session: &Arc<Session>, conn: &Arc<AgentConn>, id: &acp::SessionId, mut options: Value) -> Value {
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

pub(super) async fn new_agent_session(
    session: &Arc<Session>,
    conn: &Arc<AgentConn>,
    thread: &ThreadId,
    boundary: Boundary,
    transcript: Option<crate::api::TranscriptSize>,
) -> anyhow::Result<acp::SessionId> {
    let cwd = std::path::PathBuf::from(session.meta().folder);
    let servers = mcp_servers(session, conn, thread).await?;
    let r = conn.cx.send_request(acp::NewSessionRequest::new(cwd).mcp_servers(servers)).block_task().await?;
    let mut options = r.config_options.map(serde_json::to_value).transpose()?;
    if boundary == Boundary::Initial
        && let Some(o) = options.take()
    {
        options = Some(apply_remembered_config(session, conn, &r.session_id, o).await);
    }
    if !session.is_main(Some(thread))
        && let Some(o) = options.take()
    {
        options = Some(start_asking(conn, &r.session_id, o).await);
    }
    if let Some(options) = &options {
        session.log().append(Some(thread.clone()), EventKind::ConfigOptionsChanged { options: options.clone() })?;
    }
    if let Some(modes) = &r.modes {
        session.log().append(Some(thread.clone()), EventKind::ModeChanged { mode_id: current_mode(options.as_ref(), modes) })?;
    }
    let id = r.session_id;
    conn.acp_sessions.lock().insert(thread.clone(), id.clone());
    session.update_meta(|m| {
        m.agent_sessions.insert(thread.clone(), id.to_string());
        m.context_pending.insert(thread.clone());
    })?;
    session.log().append(Some(thread.clone()), EventKind::AgentSessionStarted { acp_session_id: id.to_string(), boundary, transcript })?;
    Ok(id)
}
