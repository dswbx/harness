//! Typed facts out of a tool call's raw ACP JSON, so no Frontend parses Agent payloads (ADR 0012).

use serde_json::Value;

/// What Frontends need out of a tool call's raw ACP JSON (`kind`, `title`, `rawInput`), read here
/// so none of them parses Agent payloads (ADR 0012). Agent-specific shapes live in `agent_quirks`.
#[derive(Debug, Default, PartialEq)]
pub struct ToolFacts {
    pub plan: Option<String>,
    pub subagent: Option<crate::api::SubagentInfo>,
    pub commit_message: Option<String>,
    pub frontend_tool: Option<String>,
}

pub(crate) fn tool_facts(call: &Value, harness_tool: Option<&str>) -> ToolFacts {
    let kind = call.get("kind").and_then(Value::as_str);
    let raw_input = call.get("rawInput");
    let commit_message = (kind == Some("git_commit") || harness_tool == Some("git_commit"))
        .then(|| raw_input.and_then(|i| i.get("message")).and_then(Value::as_str).map(|m| m.trim().to_owned()))
        .flatten()
        .filter(|m| !m.is_empty());
    // The Harness MCP titles its Frontend Tool requests "Frontend tool: <name>".
    let frontend_tool = (kind == Some("frontend_tool"))
        .then(|| {
            call.get("title")
                .and_then(Value::as_str)
                .and_then(|t| t.strip_prefix("Frontend tool:"))
                .map(|n| n.trim().to_owned())
                .or_else(|| harness_tool.map(str::to_owned))
        })
        .flatten()
        .filter(|n| !n.is_empty());
    ToolFacts {
        plan: crate::agent_quirks::plan(kind, raw_input),
        subagent: crate::agent_quirks::subagent_prompt(raw_input).map(|prompt| crate::api::SubagentInfo { prompt }),
        commit_message,
        frontend_tool,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::normalize;
    use crate::api::EventKind;
    use serde_json::json;

    /// Recorded `session/update` JSON in, typed Event fields out.
    fn call_fields(u: Value) -> (Option<String>, Option<String>, Option<String>, Option<String>) {
        match normalize(&u) {
            EventKind::ToolCall { harness_tool, plan, subagent, commit_message, .. } => (harness_tool, plan, subagent.map(|s| s.prompt), commit_message),
            EventKind::ToolCallUpdate { harness_tool, plan, subagent, commit_message, .. } => (harness_tool, plan, subagent.map(|s| s.prompt), commit_message),
            other => panic!("not a tool call: {other:?}"),
        }
    }

    #[test]
    fn claude_task_has_subagent_prompt() {
        let u = json!({
            "sessionUpdate": "tool_call", "toolCallId": "t1", "title": "Find the log", "kind": "think", "status": "pending",
            "rawInput": { "description": "Find the log", "prompt": "Where is the log written?", "subagent_type": "Explore" },
        });
        assert_eq!(call_fields(u), (None, None, Some("Where is the log written?".into()), None));
        // Streaming: the ToolCall carries `{}`, the update the full input.
        let u = json!({ "sessionUpdate": "tool_call", "toolCallId": "t1", "title": "Task", "rawInput": {} });
        assert_eq!(call_fields(u), (None, None, None, None));
        let u = json!({ "sessionUpdate": "tool_call_update", "toolCallId": "t1", "rawInput": { "prompt": "P", "subagent_type": "x" } });
        assert_eq!(call_fields(u).2.as_deref(), Some("P"));
    }

    #[test]
    fn switch_mode_carries_plan() {
        let u = json!({
            "sessionUpdate": "tool_call", "toolCallId": "p1", "title": "Ready to code?", "kind": "switch_mode",
            "rawInput": { "plan": "# Plan\n- step" },
        });
        assert_eq!(call_fields(u).1.as_deref(), Some("# Plan\n- step"));
        let u = json!({ "sessionUpdate": "tool_call", "toolCallId": "p1", "title": "Run", "kind": "execute", "rawInput": { "plan": "x" } });
        assert_eq!(call_fields(u).1, None);
    }

    #[test]
    fn harness_git_tools() {
        for title in ["mcp__harness__git_commit", "mcp.harness.git_commit"] {
            let u = json!({ "sessionUpdate": "tool_call", "toolCallId": "g", "title": title, "kind": "other", "rawInput": { "message": "  Fix it\n\nbody " } });
            let (tool, _, _, msg) = call_fields(u);
            assert_eq!(tool.as_deref(), Some("git_commit"));
            assert_eq!(msg.as_deref(), Some("Fix it\n\nbody"));
        }
        // Another tool's `message` is not a commit message.
        let u = json!({ "sessionUpdate": "tool_call", "toolCallId": "g", "title": "mcp__harness__git_push", "rawInput": { "message": "m" } });
        assert_eq!(call_fields(u).3, None);
    }

    #[test]
    fn permission_facts() {
        let commit = json!({ "kind": "git_commit", "title": "Commit: Fix", "rawInput": { "message": "Fix" } });
        assert_eq!(tool_facts(&commit, Some("git_commit")).commit_message.as_deref(), Some("Fix"));

        let ft = json!({ "kind": "frontend_tool", "title": "Frontend tool: render_ui", "rawInput": {} });
        assert_eq!(tool_facts(&ft, Some("render_ui")).frontend_tool.as_deref(), Some("render_ui"));
        // Without the title prefix the Harness tool name stands in.
        let ft = json!({ "kind": "frontend_tool", "title": "mcp__harness__render_ui" });
        assert_eq!(tool_facts(&ft, Some("render_ui")).frontend_tool.as_deref(), Some("render_ui"));
        assert_eq!(tool_facts(&json!({ "kind": "execute", "title": "Frontend tool: x" }), None).frontend_tool, None);

        let plan = json!({ "kind": "switch_mode", "rawInput": { "plan": "P" } });
        assert_eq!(tool_facts(&plan, None).plan.as_deref(), Some("P"));
    }

    #[test]
    fn old_logs_without_the_fields_parse() {
        let old =
            json!({ "type": "ToolCall", "tool_call_id": "a", "title": "t", "kind": null, "status": null, "content": [], "locations": [], "raw_input": null });
        let k: EventKind = serde_json::from_value(old).unwrap();
        assert!(matches!(k, EventKind::ToolCall { plan: None, subagent: None, commit_message: None, .. }));
        let old = json!({ "type": "PermissionRequested", "request_id": "r", "tool_call": {}, "options": [] });
        let k: EventKind = serde_json::from_value(old).unwrap();
        assert!(matches!(k, EventKind::PermissionRequested { plan: None, frontend_tool: None, .. }));
    }
}
