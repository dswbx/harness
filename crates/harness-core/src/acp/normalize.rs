//! ACP `session/update` to Harness Event, plus the tracked tool call state.

use std::collections::HashMap;
use std::sync::Arc;

use agent_client_protocol::schema::v1 as acp;
use serde_json::Value;

use super::thread_of;
use crate::api::{EventKind, SlashCommand, TaskEntry};
use crate::session::Session;

pub(super) fn on_update(session: &Arc<Session>, n: &acp::SessionNotification) {
    let thread = thread_of(session, &n.session_id);
    let update = serde_json::to_value(&n.update).unwrap_or(Value::Null);
    track_tool_call(session, &update);
    let mut kind = normalize(&update);
    crate::agent_quirks::adjust(&update, &mut kind);
    if let EventKind::SessionInfoUpdated { title: Some(t) } = &kind {
        session.set_agent_title(thread.as_ref(), t);
    }
    let job = match &kind {
        EventKind::ToolCallUpdate { background_job: Some(job), .. } => Some(job.clone()),
        _ => None,
    };
    let _ = session.log().append(thread.clone(), kind);
    // After the launch is logged, so the end always comes after it.
    if let Some(job) = job {
        super::jobs::watch(session, thread, job);
    }
}

pub(super) fn track_tool_call(session: &Session, u: &Value) {
    track(&mut session.agent_slot().state.lock().tool_calls, u);
}

/// Records `u` in the latest-known state of each tool call. A new `tool_call` starts over, even
/// with an id seen before: merging would keep fields it leaves out as defaults (e.g. a `kind` of
/// `other`), and the Policy would judge stale facts. A `tool_call_update` merges.
fn track(calls: &mut HashMap<String, Value>, u: &Value) {
    let Some(id) = u.get("toolCallId").and_then(Value::as_str) else { return };
    if u.get("sessionUpdate").and_then(Value::as_str) == Some("tool_call") {
        calls.insert(id.to_owned(), u.clone());
    } else {
        merge(calls.entry(id.to_owned()).or_insert_with(|| Value::Object(Default::default())), u);
    }
}

/// Overlays the non-null fields of `update` onto `base`.
pub(super) fn merge(base: &mut Value, update: &Value) {
    if let (Some(b), Some(u)) = (base.as_object_mut(), update.as_object()) {
        for (k, v) in u {
            if !v.is_null() {
                b.insert(k.clone(), v.clone());
            }
        }
    }
}

/// Maps an ACP `session/update` (as JSON, camelCase) to a Harness event.
pub(crate) fn normalize(u: &Value) -> EventKind {
    let s = |k: &str| u.get(k).and_then(Value::as_str).map(str::to_owned);
    let text = || u.pointer("/content/text").and_then(Value::as_str).map(str::to_owned);
    let tool = || {
        let harness_tool = s("title").as_deref().and_then(crate::mcp::harness_tool_name).map(str::to_owned);
        let facts = crate::tool_facts::tool_facts(u, harness_tool.as_deref());
        (harness_tool, facts)
    };
    match s("sessionUpdate").as_deref() {
        Some("agent_message_chunk") if let Some(text) = text() => EventKind::AgentMessageChunk { text, parent_tool_call_id: None },
        Some("agent_thought_chunk") if let Some(text) = text() => EventKind::AgentThoughtChunk { text, parent_tool_call_id: None },
        Some("tool_call") => {
            let (harness_tool, facts) = tool();
            EventKind::ToolCall {
                tool_call_id: s("toolCallId").unwrap_or_default(),
                title: s("title").unwrap_or_default(),
                kind: s("kind"),
                status: s("status"),
                content: u.get("content").cloned().unwrap_or(Value::Array(vec![])),
                locations: u.get("locations").cloned().unwrap_or(Value::Array(vec![])),
                raw_input: u.get("rawInput").cloned(),
                parent_tool_call_id: None,
                report: None,
                harness_tool,
                plan: facts.plan,
                subagent: facts.subagent,
                commit_message: facts.commit_message,
            }
        }
        Some("tool_call_update") => {
            let (harness_tool, facts) = tool();
            EventKind::ToolCallUpdate {
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
                background_job: None,
                harness_tool,
                plan: facts.plan,
                subagent: facts.subagent,
                commit_message: facts.commit_message,
            }
        }
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
        Some("config_option_update") => EventKind::config_options(u.get("configOptions").cloned().unwrap_or(Value::Null)),
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn message_and_thought_chunks() {
        let u = json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "Hello" } });
        assert!(matches!(normalize(&u), EventKind::AgentMessageChunk { text, .. } if text == "Hello"));
        let u = json!({ "sessionUpdate": "agent_thought_chunk", "content": { "type": "text", "text": "hm" } });
        assert!(matches!(normalize(&u), EventKind::AgentThoughtChunk { text, .. } if text == "hm"));
        // A chunk without text is kept raw, not dropped.
        let u = json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "image" } });
        assert!(matches!(normalize(&u), EventKind::AgentUpdate { .. }));
    }

    #[test]
    fn tool_call_and_update() {
        let u = json!({
            "sessionUpdate": "tool_call", "toolCallId": "t1", "title": "Read a.rs", "kind": "read", "status": "pending",
            "locations": [{ "path": "/a.rs" }], "rawInput": { "file_path": "/a.rs" },
        });
        match normalize(&u) {
            EventKind::ToolCall { tool_call_id, title, kind, status, locations, raw_input, harness_tool, .. } => {
                assert_eq!(tool_call_id, "t1");
                assert_eq!(title, "Read a.rs");
                assert_eq!(kind.as_deref(), Some("read"));
                assert_eq!(status.as_deref(), Some("pending"));
                assert_eq!(locations, json!([{ "path": "/a.rs" }]));
                assert_eq!(raw_input, Some(json!({ "file_path": "/a.rs" })));
                assert_eq!(harness_tool, None);
            }
            other => panic!("{other:?}"),
        }
        let u = json!({ "sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "completed", "rawOutput": { "out": "x" } });
        match normalize(&u) {
            EventKind::ToolCallUpdate { tool_call_id, title, kind, status, raw_output, .. } => {
                assert_eq!(tool_call_id, "t1");
                assert_eq!((title, kind), (None, None));
                assert_eq!(status.as_deref(), Some("completed"));
                assert_eq!(raw_output, Some(json!({ "out": "x" })));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn claude_task_carries_subagent_prompt() {
        let u = json!({
            "sessionUpdate": "tool_call", "toolCallId": "task1", "title": "Find the log", "kind": "think", "status": "pending",
            "rawInput": { "description": "Find the log", "prompt": "Where is the log written?", "subagent_type": "Explore" },
        });
        match normalize(&u) {
            EventKind::ToolCall { subagent: Some(s), plan: None, .. } => assert_eq!(s.prompt, "Where is the log written?"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn switch_mode_carries_plan() {
        let u = json!({
            "sessionUpdate": "tool_call", "toolCallId": "p1", "title": "Ready to code?", "kind": "switch_mode",
            "rawInput": { "plan": "# Plan\n- step" },
        });
        match normalize(&u) {
            EventKind::ToolCall { plan: Some(p), subagent: None, .. } => assert_eq!(p, "# Plan\n- step"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn plan_becomes_task_list() {
        let u = json!({
            "sessionUpdate": "plan",
            "entries": [
                { "content": "Write tests", "priority": "high", "status": "in_progress" },
                { "content": "Ship", "priority": "low", "status": "pending" },
            ],
        });
        match normalize(&u) {
            EventKind::TaskListUpdated { entries } => {
                assert_eq!(entries.len(), 2);
                assert_eq!(entries[0].content, "Write tests");
                assert_eq!(entries[0].priority, "high");
                assert_eq!(entries[0].status, "in_progress");
                assert_eq!(entries[1].status, "pending");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn mode_and_config_updates() {
        let u = json!({ "sessionUpdate": "current_mode_update", "currentModeId": "plan" });
        assert!(matches!(normalize(&u), EventKind::ModeChanged { mode_id } if mode_id == "plan"));
        let options = json!([{ "id": "model", "currentValue": "a", "options": [] }]);
        let u = json!({ "sessionUpdate": "config_option_update", "configOptions": options });
        assert!(matches!(normalize(&u), EventKind::ConfigOptionsChanged { options: o, .. } if o == options));
    }

    #[test]
    fn other_updates() {
        let u = json!({ "sessionUpdate": "notice", "title": "Hook ran" });
        assert!(matches!(normalize(&u), EventKind::AgentNotice { severity, title, description: None } if severity == "info" && title == "Hook ran"));
        let u = json!({ "sessionUpdate": "session_info_update", "title": "T" });
        assert!(matches!(normalize(&u), EventKind::SessionInfoUpdated { title: Some(t) } if t == "T"));
        let u =
            json!({ "sessionUpdate": "available_commands_update", "availableCommands": [{ "name": "init", "description": "d", "input": { "hint": "h" } }] });
        match normalize(&u) {
            EventKind::AvailableCommandsChanged { commands } => assert_eq!((commands[0].name.as_str(), commands[0].hint.as_deref()), ("init", Some("h"))),
            other => panic!("{other:?}"),
        }
        // Unknown kinds are kept raw.
        let u = json!({ "sessionUpdate": "something_new", "x": 1 });
        assert!(matches!(normalize(&u), EventKind::AgentUpdate { update } if update == u));
    }

    #[test]
    fn new_tool_call_replaces_tracked_entry_and_update_merges() {
        let mut calls = HashMap::new();
        track(&mut calls, &json!({ "sessionUpdate": "tool_call", "toolCallId": "t", "title": "Run", "kind": "execute", "rawInput": { "command": "ls" } }));
        // A later `tool_call` with the same id and no `kind` must not inherit `execute`.
        track(&mut calls, &json!({ "sessionUpdate": "tool_call", "toolCallId": "t", "title": "Run" }));
        assert!(calls["t"].get("kind").is_none());
        assert!(calls["t"].get("rawInput").is_none());
        // An update merges: non-null fields overlay, nulls and absent fields keep the old value.
        track(&mut calls, &json!({ "sessionUpdate": "tool_call_update", "toolCallId": "t", "kind": "edit", "title": null, "status": "in_progress" }));
        assert_eq!(calls["t"]["kind"], "edit");
        assert_eq!(calls["t"]["title"], "Run");
        assert_eq!(calls["t"]["status"], "in_progress");
        // An update for an unseen id starts from empty.
        track(&mut calls, &json!({ "sessionUpdate": "tool_call_update", "toolCallId": "u", "status": "completed" }));
        assert_eq!(calls["u"]["status"], "completed");
        // No id: ignored.
        track(&mut calls, &json!({ "sessionUpdate": "plan" }));
        assert_eq!(calls.len(), 2);
    }
}
