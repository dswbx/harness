//! Permission requests from the Agent and from Harness MCP tools: Policy, pending answers, remembered rules.

use std::sync::Arc;

use agent_client_protocol::Responder;
use agent_client_protocol::schema::v1 as acp;
use serde_json::Value;
use tokio::sync::oneshot;

use super::normalize::merge;
use super::process::{Answer, Pending};
use super::{enum_str, thread_of};
use crate::api::{Decision, EventKind, NewPermissionRule, PermissionOption, Resolver, RuleScope, ThreadId};
use crate::session::Session;

/// A `PermissionRequested` Event with its typed facts read from the (merged) tool call.
pub(super) fn permission_requested(request_id: String, tool_call: Value, options: Vec<PermissionOption>, harness_tool: Option<String>) -> EventKind {
    let f = crate::tool_facts::tool_facts(&tool_call, harness_tool.as_deref());
    EventKind::PermissionRequested {
        request_id,
        tool_call,
        options,
        harness_tool,
        plan: f.plan,
        commit_message: f.commit_message,
        frontend_tool: f.frontend_tool,
    }
}

pub(super) fn on_permission(session: &Arc<Session>, req: acp::RequestPermissionRequest, responder: Responder<acp::RequestPermissionResponse>) {
    let request_id = uuid::Uuid::now_v7().to_string();
    let thread = thread_of(session, &req.session_id);
    let options: Vec<PermissionOption> =
        req.options.iter().map(|o| PermissionOption { option_id: o.option_id.to_string(), name: o.name.clone(), kind: enum_str(&o.kind) }).collect();
    let slot = session.agent_slot();
    // A request that arrives after the user cancelled the Turn gets no dialog nobody would answer:
    // the Agent is waiting for it, so the Turn could not end.
    if thread.as_ref().is_some_and(|t| slot.cancelling(t)) {
        let _ = responder.respond(acp::RequestPermissionResponse::new(acp::RequestPermissionOutcome::Cancelled));
        return;
    }
    let requested = serde_json::to_value(&req.tool_call).unwrap_or(Value::Null);
    let mut tool_call = requested
        .get("toolCallId")
        .and_then(Value::as_str)
        .and_then(|id| slot.state.lock().tool_calls.get(id).cloned())
        .unwrap_or_else(|| Value::Object(Default::default()));
    merge(&mut tool_call, &requested);

    let meta = session.meta();
    let folder = std::path::PathBuf::from(&meta.folder);
    let facts = crate::permissions::facts_of(&tool_call, &folder);
    let panels = session.panels_dir();
    let cx = crate::permissions::Context { session_id: &meta.id, agent_id: &meta.agent.id, folder: &folder, panels: Some(&panels) };
    // Calls to the Harness MCP pass the Policy inside the Harness MCP itself; don't ask twice. The
    // title is the Agent's own text: it skips the Policy only for a tool the Harness MCP really
    // serves for this Session and a call that is not a command, edit or fetch.
    let title = tool_call.get("title").and_then(Value::as_str).unwrap_or_default();
    let harness_tool = crate::mcp::harness_tool_name(title).map(str::to_owned);
    let trusted = harness_tool.as_deref().is_some_and(|n| crate::mcp::trusted_harness_call(crate::mcp::serves_tool(session, n), &facts));
    let verdict = if trusted { crate::permissions::Verdict { decision: Decision::Allow, rule_id: None } } else { session.policy().evaluate(&cx, &facts) };
    let auto = match verdict.decision {
        Decision::Allow => pick(&options, &["allow_once", "allow_always"]),
        Decision::Deny => pick(&options, &["reject_once", "reject_always"]),
        Decision::Ask => None,
    };

    if let Some(option_id) = auto {
        let _ = session.log().append(thread.clone(), permission_requested(request_id.clone(), tool_call, options.clone(), harness_tool));
        let _ = session.log().append(
            thread.clone(),
            EventKind::PermissionResolved { request_id, option_id: Some(option_id.clone()), by: Resolver::Policy, rule_id: verdict.rule_id },
        );
        let _ = session.log().sync();
        let _ = responder.respond(acp::RequestPermissionResponse::new(acp::RequestPermissionOutcome::Selected(acp::SelectedPermissionOutcome::new(option_id))));
        return;
    }
    let pending = Pending { thread: thread.clone(), responder: Answer::Acp(responder), options: options.clone(), facts };
    slot.add_pending(session, request_id.clone(), pending, || {
        let _ = session.log().append(thread, permission_requested(request_id, tool_call, options, harness_tool));
    });
    let _ = session.log().sync();
}

/// Checks a Harness MCP tool call against the Permission Policy, asking the user when the Policy
/// says so. Errors when denied. A default Allow (no rule) is silent. An explicit Allow rule, and a
/// default Ask (no explicit rule, not a plan approval) in a Thread whose Agent mode decides without
/// asking (`agent_quirks::auto_mode`, the Agent could do the same through its shell), pass without
/// asking but log a `PermissionRequested` + `PermissionResolved` (by Policy, option "allow") pair so
/// the UI can show why.
pub async fn authorize(session: &Arc<Session>, thread: &ThreadId, tool: &str, title: &str, kind: &str, args: &Value) -> anyhow::Result<()> {
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
    let panels = session.panels_dir();
    let cx = crate::permissions::Context { session_id: &meta.id, agent_id: &meta.agent.id, folder: &folder, panels: Some(&panels) };
    let verdict = session.policy().evaluate(&cx, &facts);
    let request_id = uuid::Uuid::now_v7().to_string();
    let options = vec![
        PermissionOption { option_id: "allow".into(), name: "Allow".into(), kind: "allow_once".into() },
        PermissionOption { option_id: "always".into(), name: "Always allow".into(), kind: "allow_always".into() },
        PermissionOption { option_id: "reject".into(), name: "Deny".into(), kind: "reject_once".into() },
    ];
    let requested = permission_requested(request_id.clone(), tool_call, options.clone(), Some(tool.to_owned()));
    let passes = match verdict.decision {
        Decision::Allow => verdict.rule_id.is_some(),
        Decision::Ask if verdict.rule_id.is_none() && kind != "switch_mode" => {
            session.log().thread_mode(thread).ok().flatten().is_some_and(|m| crate::agent_quirks::auto_mode(&m))
        }
        _ => false,
    };
    if verdict.decision == Decision::Allow && !passes {
        return Ok(());
    }
    if passes {
        session.log().append(Some(thread.clone()), requested)?;
        session.log().append(
            Some(thread.clone()),
            EventKind::PermissionResolved { request_id, option_id: Some("allow".into()), by: Resolver::Policy, rule_id: verdict.rule_id },
        )?;
        return Ok(());
    }
    if verdict.decision == Decision::Deny {
        session.log().append(Some(thread.clone()), requested)?;
        session.log().append(
            Some(thread.clone()),
            EventKind::PermissionResolved { request_id, option_id: Some("reject".into()), by: Resolver::Policy, rule_id: verdict.rule_id },
        )?;
        anyhow::bail!("denied by the Harness Permission Policy");
    }
    let (tx, rx) = oneshot::channel();
    let pending = Pending { thread: Some(thread.clone()), responder: Answer::Local(tx), options, facts };
    let mut logged = Ok(());
    session.agent_slot().add_pending(session, request_id, pending, || {
        logged = session.log().append(Some(thread.clone()), requested).map(drop);
    });
    logged?;
    session.log().sync()?;
    match rx.await {
        Ok(Some(o)) if o != "reject" => Ok(()),
        Ok(Some(_)) => anyhow::bail!("the user denied this"),
        _ => anyhow::bail!("cancelled"),
    }
}

/// First option of the preferred kinds, in order.
pub(super) fn pick(options: &[PermissionOption], kinds: &[&str]) -> Option<String> {
    kinds.iter().find_map(|k| options.iter().find(|o| o.kind == *k)).map(|o| o.option_id.clone())
}

/// An "always" answer becomes a Session rule (Global when `global`): the exact command for `execute`, else the whole kind.
pub(super) fn remembered_rule(session: &Session, option_kind: Option<&str>, facts: &crate::permissions::ToolFacts, global: bool) -> Option<NewPermissionRule> {
    let decision = match option_kind? {
        "allow_always" => Decision::Allow,
        "reject_always" => Decision::Deny,
        _ => return None,
    };
    let kind = facts.kind.clone().filter(|k| k != "switch_mode")?;
    let pattern = if kind == "execute" { Some(facts.command.clone()?) } else { None };
    Some(NewPermissionRule {
        scope: if global { RuleScope::Global } else { RuleScope::Session { session_id: session.id() } },
        tool_kind: Some(kind),
        pattern,
        decision,
    })
}
