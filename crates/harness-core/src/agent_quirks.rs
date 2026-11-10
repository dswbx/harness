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

/// Env vars added when spawning any Agent. A Custom Agent's own env overrides them.
pub fn extra_env() -> Vec<(&'static str, &'static str)> {
    claude::extra_env()
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

/// Whether an Agent's mode is one where the Agent itself decides what runs without asking the user
/// (Claude "auto" and "bypassPermissions", Codex "agent" and "agent-full-access"). In it the Agent
/// could run `git push` in a shell unasked, so a Harness MCP tool the Permission Policy would only
/// ask about by default is allowed too. ACP has no standard for this.
pub fn auto_mode(mode_id: &str) -> bool {
    matches!(mode_id, "auto" | "bypassPermissions" | "agent" | "agent-full-access")
}

/// How Agents prefix the title of a Harness MCP tool call: Claude `mcp__harness__git_status`,
/// Codex `mcp.harness.git_status`. Titles are the Agent's own text, so they only name a tool; they
/// never vouch for it (`mcp::trusted_harness_call`).
pub fn harness_tool_prefixes() -> &'static [&'static str] {
    &["mcp__harness__", "mcp.harness."]
}

/// A tool call's `command` given as an argv array, as one command line. Codex wraps commands as
/// `["bash", "-lc", "<script>"]`; the script is what the Permission Policy must see.
pub fn command_from_parts(parts: &[&str]) -> String {
    match parts {
        [_, flag, script] if flag.starts_with('-') && flag.ends_with('c') => (*script).to_owned(),
        _ => parts.join(" "),
    }
}

/// The plan an Agent asks to have approved: Markdown. ACP has no field for it.
pub fn plan(kind: Option<&str>, raw_input: Option<&Value>) -> Option<String> {
    claude::plan(kind, raw_input)
}

/// What a tool call that starts a subagent asked it to do. ACP has no notion of subagents.
pub fn subagent_prompt(raw_input: Option<&Value>) -> Option<String> {
    claude::subagent_prompt(raw_input)
}

/// Claude Agent (claude-agent-acp).
mod claude {
    use super::*;

    /// Plan Mode: the exit-plan tool is a `switch_mode` call with the plan in `rawInput.plan`.
    pub fn plan(kind: Option<&str>, raw_input: Option<&Value>) -> Option<String> {
        let plan = raw_input?.get("plan")?.as_str()?;
        (kind == Some("switch_mode") && !plan.is_empty()).then(|| plan.to_owned())
    }

    /// The Task tool: `rawInput` is `{ description, prompt, subagent_type }`.
    pub fn subagent_prompt(raw_input: Option<&Value>) -> Option<String> {
        let i = raw_input?;
        let prompt = i.get("prompt")?.as_str()?;
        (i.get("subagent_type").is_some() || i.get("description").is_some()).then(|| prompt.to_owned())
    }

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

    /// Recent Claude models omit thinking text by default, so `agent_thought_chunk` updates are
    /// empty and no thinking shows. ACP has no standard way to ask for thinking text.
    pub fn extra_env() -> Vec<(&'static str, &'static str)> {
        vec![("CLAUDE_CODE_THINKING_DISPLAY", "summarized")]
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
            plan: None,
            subagent: None,
            commit_message: None,
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
    fn auto_modes() {
        for m in ["auto", "bypassPermissions", "agent", "agent-full-access"] {
            assert!(auto_mode(m), "{m}");
        }
        for m in ["default", "acceptEdits", "plan", "read-only", "workspace-write", ""] {
            assert!(!auto_mode(m), "{m}");
        }
    }

    #[test]
    fn claude_plan_and_subagent_prompt() {
        let plan = json!({ "plan": "# Plan\n- a" });
        assert_eq!(plan_of(Some("switch_mode"), &plan).as_deref(), Some("# Plan\n- a"));
        assert_eq!(plan_of(Some("execute"), &plan), None);
        assert_eq!(plan_of(Some("switch_mode"), &json!({})), None);

        let task = json!({ "description": "Find it", "prompt": "Look for X", "subagent_type": "Explore" });
        assert_eq!(subagent_prompt(Some(&task)).as_deref(), Some("Look for X"));
        // A bare `prompt` is not a subagent task.
        assert_eq!(subagent_prompt(Some(&json!({ "prompt": "hi" }))), None);
        assert_eq!(subagent_prompt(None), None);
    }

    fn plan_of(kind: Option<&str>, i: &Value) -> Option<String> {
        plan(kind, Some(i))
    }

    #[test]
    fn claude_thinking_display() {
        assert!(extra_env().contains(&("CLAUDE_CODE_THINKING_DISPLAY", "summarized")));
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
            plan: None,
            subagent: None,
            commit_message: None,
        };
        adjust(&json!({}), &mut k);
        assert!(matches!(k, EventKind::ToolCallUpdate { background: true, .. }));
    }
}
