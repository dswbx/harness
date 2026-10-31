//! Agent-specific handling: the only place for it (ADR 0008 keeps the Harness strict ACP).
//!
//! An entry belongs here only when an Agent needs it to work right and ACP has no standard way.
//! Each one maps an Agent's own signal (a `_meta` namespace, a tool name) onto a generic field,
//! so Frontends never see Agent-specific data. Keep them small, say why each is vital, and remove
//! one when ACP covers it.

use serde_json::Value;

use crate::api::EventKind;

/// Host env vars removed before spawning any Agent.
pub fn stripped_env() -> Vec<String> {
    claude::stripped_env()
}

/// Fills generic event fields from an Agent's own signals in the raw ACP `session/update`.
pub fn adjust(update: &Value, kind: &mut EventKind) {
    claude::adjust(update, kind);
}

/// The value of an Agent's mode option that asks the user before every write, out of `values`.
/// Side Threads start in it (ADR 0018): in modes that auto-approve (Codex "agent", Claude
/// "acceptEdits"), writes never reach the Permission Policy. ACP has no standard for this.
pub fn asking_mode<'a>(values: &[&'a str]) -> Option<&'a str> {
    // Codex: "read-only" asks for edits and network; Claude: "default" ("Manual") always asks.
    ["read-only", "default"].into_iter().find_map(|m| values.iter().find(|v| **v == m).copied())
}

/// Claude Agent (claude-agent-acp).
mod claude {
    use super::*;

    /// When the Harness itself runs under another agent app (e.g. launched from a Claude desktop
    /// terminal), `CLAUDE*` vars make a spawned Claude Code use the host's auth and IPC instead of
    /// the user's own login.
    pub fn stripped_env() -> Vec<String> {
        const KEEP: &[&str] = &["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR"];
        std::env::vars_os()
            .filter_map(|(k, _)| k.into_string().ok())
            .filter(|k| (k.starts_with("CLAUDE") && !KEEP.contains(&k.as_str())) || k == "ANTHROPIC_BASE_URL")
            .collect()
    }

    /// Subagents. ACP has no notion of them; without this, a subagent's tool calls look like the
    /// main Agent's and it is unclear how far each subagent is.
    /// - `_meta.claudeCode.parentToolUseId`: the Task call that started the subagent.
    /// - A Task call for a background subagent completes at once ("Async agent launched").
    /// - The background subagent's `SubagentHandback` call carries its final report.
    pub fn adjust(u: &Value, kind: &mut EventKind) {
        let parent = u.pointer("/_meta/claudeCode/parentToolUseId").and_then(Value::as_str).map(str::to_owned);
        match kind {
            EventKind::ToolCall { title, raw_input, parent_tool_call_id, report, .. } => {
                if title == "SubagentHandback" && parent.is_some() {
                    *report = raw_input.as_ref().and_then(|i| i["message"].as_str()).map(str::to_owned);
                }
                *parent_tool_call_id = parent;
            }
            EventKind::ToolCallUpdate { content, parent_tool_call_id, background, .. } => {
                let launched = |b: &Value| b.pointer("/content/text").and_then(Value::as_str).is_some_and(|t| t.starts_with("Async agent launched"));
                *background = content.as_ref().and_then(Value::as_array).is_some_and(|c| c.iter().any(launched));
                *parent_tool_call_id = parent;
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn call(title: &str, raw_input: Value) -> EventKind {
        EventKind::ToolCall {
            tool_call_id: "c".into(),
            title: title.into(),
            kind: None,
            status: None,
            content: json!([]),
            locations: json!([]),
            raw_input: Some(raw_input),
            parent_tool_call_id: None,
            report: None,
            harness_tool: None,
        }
    }

    #[test]
    fn claude_subagent_parent_and_report() {
        let u = json!({ "_meta": { "claudeCode": { "parentToolUseId": "task1" } } });
        let mut k = call("SubagentHandback", json!({ "message": "No." }));
        adjust(&u, &mut k);
        assert!(matches!(&k, EventKind::ToolCall { parent_tool_call_id: Some(p), report: Some(r), .. } if p == "task1" && r == "No."));

        // Without a parent it is not a subagent's report.
        let mut k = call("SubagentHandback", json!({ "message": "No." }));
        adjust(&json!({}), &mut k);
        assert!(matches!(&k, EventKind::ToolCall { parent_tool_call_id: None, report: None, .. }));
    }

    #[test]
    fn claude_background_launch() {
        let mut k = EventKind::ToolCallUpdate {
            tool_call_id: "task1".into(),
            title: None,
            kind: None,
            status: Some("completed".into()),
            content: Some(json!([{ "type": "content", "content": { "type": "text", "text": "Async agent launched successfully." } }])),
            locations: None,
            raw_input: None,
            raw_output: None,
            parent_tool_call_id: None,
            background: false,
            harness_tool: None,
        };
        adjust(&json!({}), &mut k);
        assert!(matches!(k, EventKind::ToolCallUpdate { background: true, .. }));
    }
}
