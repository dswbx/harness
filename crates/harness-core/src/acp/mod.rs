//! ACP client side: one Agent process per Session (shared by its Threads), normalized into the
//! Session Log. See docs/spikes/acp-client.md for the crate's behaviour.

mod normalize;
mod permission;
mod process;
mod restore;

use std::sync::Arc;

use agent_client_protocol::schema::v1 as acp;
use serde_json::Value;

use crate::api::{AttachmentInput, EventKind, ThreadId};
use crate::session::Session;

pub use permission::authorize;
pub use process::AgentSlot;
pub use restore::{continue_with_summary, set_config_option, set_mode, warm_up};

#[cfg(test)]
pub(crate) use normalize::normalize;
use process::ensure_conn;
pub(crate) use process::{launch_args, with_tail};
use restore::{ensure_agent_session, follow_main_config};

/// Why a Thread's Agent Session is not available; see `ThreadReadOnly`.
const NOT_RESTORED: &str = "The Agent could not reopen its earlier session.";

/// Starts a Turn: ensures the Agent process and the Thread's Agent Session, then sends the prompt
/// in the background. Returns once the Turn has started. Attachments are checked first: a rejected
/// one fails the prompt before any Turn is logged.
pub async fn prompt(session: Arc<Session>, thread: ThreadId, text: String, attachments: Vec<AttachmentInput>) -> anyhow::Result<()> {
    let meta = session.meta();
    if meta.archived {
        return Err(crate::error::conflict("this Session is archived; unarchive it first"));
    }
    let folder = std::path::PathBuf::from(&meta.folder);
    let tracked = meta.workspace.repo_root.is_some();
    let before = if tracked { crate::workspace::snapshot(&folder).await.ok() } else { None };
    let conn = ensure_conn(&session).await?;
    let acp_session = match ensure_agent_session(&session, &conn, &thread).await {
        Err(e) if is_auth_required(&e) => {
            report_auth_required(&session, Some(&thread), &e.to_string());
            return Err(crate::error::auth_required("The Agent needs you to sign in first."));
        }
        r => r?,
    };
    let Some(acp_session) = acp_session else {
        return Err(crate::error::agent_unavailable(format!("{NOT_RESTORED} Try again, or continue from a transcript.")));
    };
    if thread != meta.main_thread_id {
        follow_main_config(&session, &conn, &thread, &acp_session).await;
    }
    let caps = &conn.init.agent_capabilities.prompt_capabilities;
    let attachments = crate::attachments::resolve(session.dir(), &folder, &meta.agent.name, caps, attachments)?;
    crate::attachments::store(&attachments)?;
    let (seed, full_context, fork_note) =
        session.update_meta(|m| (m.seeds.remove(&thread), m.context_pending.remove(&thread), m.fork_note_pending.remove(&thread)))?;
    let context = if full_context {
        Some(crate::harness_context::build(&session, &thread))
    } else {
        fork_note.then(|| crate::harness_context::fork_note(&session, &thread))
    };
    let errors = crate::harness_context::frontend_errors(&session, &thread).unwrap_or_default();
    let context = match (context, errors) {
        (Some(c), Some(e)) => Some(format!("{c}\n\n{e}")),
        (c, e) => c.or(e),
    };
    let turn_id = uuid::Uuid::now_v7().to_string();
    session.log().append(
        Some(thread.clone()),
        EventKind::TurnStarted {
            turn_id: turn_id.clone(),
            text: text.clone(),
            attachments: attachments.iter().map(|a| a.attachment.clone()).collect(),
            context: context.clone(),
        },
    )?;
    let slot = session.agent_slot();
    slot.update(&session, |s| *s.turns.entry(thread.clone()).or_default() += 1);
    tokio::spawn(async move {
        let mut blocks = Vec::new();
        if let Some(context) = context {
            blocks.push(acp::ContentBlock::Text(acp::TextContent::new(context)));
        }
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
            // A Cancel the Agent did not answer: its process was stopped, which is what ended the Turn.
            Err(_) if session.agent_slot().cancelling(&thread) => "cancelled".to_owned(),
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
            let _ = session.log().append(Some(thread.clone()), EventKind::WorkspaceChanged { turn_id: turn_id.clone(), from_tree, to_tree, files: diff.files });
        }
        // The Turn stops counting before `TurnEnded` is logged, so a View that sees the end never
        // reads the Session as still working.
        session.agent_slot().update(&session, |s| {
            if let Some(n) = s.turns.get_mut(&thread) {
                *n = n.saturating_sub(1);
            }
            if s.turns.get(&thread).is_none_or(|n| *n == 0) {
                s.cancelling.remove(&thread);
            }
            if s.turns.values().all(|n| *n == 0) {
                s.tool_calls.clear();
            }
        });
        let _ = session.log().append(Some(thread.clone()), EventKind::TurnEnded { turn_id, stop_reason: stop_reason.clone() });
        let meta = session.meta();
        session.shared().app_events.emit(crate::api::AppEvent::TurnFinished { session_id: meta.id, title: meta.title, stop_reason });
        let _ = session.log().sync();
    });
    Ok(())
}

fn is_auth_required(e: &anyhow::Error) -> bool {
    e.downcast_ref::<agent_client_protocol::Error>().is_some_and(|e| e.code == agent_client_protocol::ErrorCode::AuthRequired)
}

fn report_auth_required(session: &Session, thread: Option<&ThreadId>, message: &str) {
    let methods = session
        .agent_slot()
        .state
        .lock()
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
    meta.agent_sessions.iter().find(|(_, id)| id.as_str() == acp_session.to_string()).map(|(t, _)| t.clone())
}

fn enum_str<T: serde::Serialize>(v: &T) -> String {
    match serde_json::to_value(v) {
        Ok(Value::String(s)) => s,
        Ok(other) => other.to_string(),
        Err(_) => String::new(),
    }
}
