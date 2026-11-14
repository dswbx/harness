//! Agent-specific handling: the only place for it (ADR 0008 keeps the Harness strict ACP).
//!
//! An entry belongs here only when an Agent needs it to work right and ACP has no standard way.
//! Each one maps an Agent's own signal (a `_meta` namespace, a tool name) onto a generic field,
//! so Frontends never see Agent-specific data. Keep them small, say why each is vital, and remove
//! one when ACP covers it.

use serde_json::Value;

use crate::api::{BackgroundJob, EventKind, McpTool, ReadDetail, ToolDetail, ToolOp, ToolRef};

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

/// Whether a mode is the Agent's plan mode (Claude `plan`; Codex plans through its
/// `collaboration_mode` option, not the mode). Views read `ModeInfo.plan`, never the id. ACP has no standard for this.
pub fn is_plan_mode(mode_id: &str) -> bool {
    mode_id == "plan"
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

/// What a plan approval option does besides approving: the Agent mode it switches to and whether
/// it clears the context. ACP has no field for either.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct PlanOptionFacts {
    pub mode: Option<String>,
    pub clears_context: bool,
}

/// Read from the option name (Claude). Codex options (`implement_plan` / `revise_plan`) match nothing: no mode, no clear.
pub fn plan_option_facts(name: &str) -> PlanOptionFacts {
    let n = name.to_lowercase();
    let mode = if n.starts_with("no,") {
        None
    } else if n.contains("auto mode") {
        Some("auto")
    } else if n.contains("bypass permissions") {
        Some("bypassPermissions")
    } else if n.contains("accept edits") {
        Some("acceptEdits")
    } else if n.contains("manually approve edits") {
        Some("default")
    } else {
        None
    };
    PlanOptionFacts { mode: mode.map(str::to_owned), clears_context: mode.is_some() && n.contains("clear context") }
}

/// What a tool call that starts a subagent asked it to do. ACP has no notion of subagents.
pub fn subagent_info(raw_input: Option<&Value>) -> Option<crate::api::SubagentInfo> {
    claude::subagent_info(raw_input)
}

/// The facts a View needs to show a tool call, out of the call as the Agent sent it (`kind`,
/// `title`, `locations`, `rawInput`, `rawOutput`, `content`, merged over its updates). ACP carries
/// some of them (kind, locations); the rest are Agents' own conventions.
///
/// Why: ACP has no field for a command, a loaded tool or an MCP server, and Views must not parse
/// titles. Whose: Claude's titles and tool output (`Write <path>`, `Read <path>`, `mcp__s__t`,
/// `Terminal` while a command streams, `ToolSearch` output, `N<tab>` line numbers), and Codex's argv
/// `command` (a shell wrapper). They are applied to every Agent: another Agent's tool that happens
/// to look the same gets the same facts, and one that does not gets none, so a View falls back to
/// the plain title. Remove a convention once ACP carries the fact. The same cases run in
/// `@harness/api` (`toolDetail`, the fallback for logs recorded before this) from
/// `tests/cases/tool_detail.json`, so the two cannot drift.
pub fn tool_detail(call: &Value) -> ToolDetail {
    claude::tool_detail(call)
}

/// Claude Agent (claude-agent-acp).
mod claude {
    use super::*;

    /// Plan Mode: the exit-plan tool is a `switch_mode` call with the plan in `rawInput.plan`.
    pub fn plan(kind: Option<&str>, raw_input: Option<&Value>) -> Option<String> {
        let plan = raw_input?.get("plan")?.as_str()?;
        (kind == Some("switch_mode") && !plan.is_empty()).then(|| plan.to_owned())
    }

    /// The Task tool: `rawInput` is `{ description, prompt, subagent_type, model? }`.
    pub fn subagent_info(raw_input: Option<&Value>) -> Option<crate::api::SubagentInfo> {
        let i = raw_input?;
        let prompt = i.get("prompt")?.as_str()?;
        let str_of = |k: &str| i.get(k).and_then(Value::as_str).filter(|v| !v.is_empty()).map(str::to_owned);
        (i.get("subagent_type").is_some() || i.get("description").is_some()).then(|| crate::api::SubagentInfo {
            prompt: prompt.to_owned(),
            agent_type: str_of("subagent_type"),
            model: str_of("model"),
        })
    }

    const BARE_TITLES: &[&str] = &["Terminal", "Read File", "Fetch", "Edit", "Web search"];

    /// Facts read from Claude's tool conventions: titles (`Write <path>`, `Read <path>`,
    /// `mcp__<server>__<tool>`, `Terminal` while the command streams), the `ToolSearch` output,
    /// and `N<tab>` line numbers on Read output.
    pub fn tool_detail(call: &Value) -> ToolDetail {
        let kind = call.get("kind").and_then(Value::as_str);
        let title = call.get("title").and_then(Value::as_str).unwrap_or("");
        let raw_input = call.get("rawInput");
        let mut d = ToolDetail::default();
        if kind == Some("execute") {
            d.command = command(raw_input, title);
        }
        if kind == Some("read") {
            let path = call
                .pointer("/locations/0/path")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or_else(|| title.strip_prefix("Read ").filter(|p| !BARE_TITLES.contains(&title) && !p.is_empty() && !p.contains('\n')).map(str::to_owned));
            d.read = Some(ReadDetail { path, line_numbered: call.get("content").is_some_and(line_numbered) });
        }
        d.mcp = mcp_of(title);
        if title == "ToolSearch" {
            d.loaded_tools = Some(loaded_tools(call));
            d.search_query =
                raw_input.and_then(|i| i.get("query")).and_then(Value::as_str).filter(|q| !q.is_empty() && !q.starts_with("select:")).map(str::to_owned);
        }
        let blank = BARE_TITLES.contains(&title);
        let (op, target) = if let Some(path) = title.strip_prefix("Write ") {
            (Some(ToolOp::Write), path.to_owned())
        } else if let Some(query) = title.strip_prefix("Search ").filter(|q| q.starts_with('"')) {
            (Some(ToolOp::WebSearch), query.to_owned())
        } else if blank {
            (None, String::new())
        } else {
            (None, strip_verb(title).to_owned())
        };
        d.op = op;
        d.target = (target != title).then_some(target);
        d
    }

    /// `Read file `, `Read `, `Edit ` or `Fetch ` at the start of a title.
    fn strip_verb(title: &str) -> &str {
        ["Read file ", "Read ", "Edit ", "Fetch "].iter().find_map(|p| title.strip_prefix(p)).unwrap_or(title)
    }

    /// `rawInput.command` (a string, or argv), else the title unless it only says `Terminal`.
    fn command(raw_input: Option<&Value>, title: &str) -> Option<String> {
        match raw_input.and_then(|i| i.get("command")) {
            Some(Value::String(s)) if !s.trim().is_empty() => return Some(s.clone()),
            Some(Value::Array(parts)) => {
                let parts: Option<Vec<&str>> = parts.iter().map(Value::as_str).collect();
                if let Some(parts) = parts {
                    return Some(shown_command(&parts)).filter(|c| !c.is_empty());
                }
            }
            _ => {}
        }
        (!title.is_empty() && title != "Terminal").then(|| title.to_owned())
    }

    /// An argv as the command line to show: only a shell's `-c` wrapper (`bash -lc "<script>"`) shows
    /// its script; any other argv is joined (`grep -ic foo` is not a wrapper).
    fn shown_command(parts: &[&str]) -> String {
        const SHELLS: &[&str] = &["sh", "bash", "zsh", "dash", "fish", "ksh"];
        match parts {
            [shell, flag, script] if SHELLS.contains(&shell.rsplit('/').next().unwrap_or(shell)) && flag.starts_with('-') && flag.ends_with('c') => {
                (*script).to_owned()
            }
            _ => parts.join(" "),
        }
    }

    /// `mcp__<server>__<tool>`; the server is the shortest name followed by `__` and a tool.
    fn mcp_of(name: &str) -> Option<McpTool> {
        let rest = name.strip_prefix("mcp__")?;
        if rest.contains(['\n', '\r', '\u{2028}', '\u{2029}']) {
            return None;
        }
        let at = (1..rest.len()).find(|&i| rest.is_char_boundary(i) && rest[i..].starts_with("__") && rest.len() > i + 2)?;
        Some(McpTool { server: rest[..at].to_owned(), tool: rest[at + 2..].to_owned() })
    }

    /// A `ToolSearch` call's loaded tools: `tool_reference` items in its output, else `Tool: <name>` text blocks.
    fn loaded_tools(call: &Value) -> Vec<ToolRef> {
        let name_ref = |n: &str| ToolRef { name: n.to_owned(), mcp: mcp_of(n) };
        let refs: Vec<ToolRef> = call
            .get("rawOutput")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|r| r.get("type").and_then(Value::as_str) == Some("tool_reference"))
            .filter_map(|r| r.get("tool_name").and_then(Value::as_str))
            .map(name_ref)
            .collect();
        if !refs.is_empty() {
            return refs;
        }
        content_texts(call.get("content"))
            .filter_map(|t| t.trim().strip_prefix("Tool: ").filter(|n| !n.is_empty() && !n.contains(char::is_whitespace)).map(name_ref))
            .collect()
    }

    /// The text of each `{ type: "content", content: { type: "text", text } }` block.
    fn content_texts(content: Option<&Value>) -> impl Iterator<Item = &str> {
        content
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|b| (b.get("type").and_then(Value::as_str) == Some("content")).then(|| b.pointer("/content/text").and_then(Value::as_str)).flatten())
    }

    /// Some text block is one code fence whose lines are all `N<tab>code`, counting up by one.
    fn line_numbered(content: &Value) -> bool {
        content_texts(Some(content)).any(|t| fence_code(t).is_some_and(|code| numbers(code).is_some()))
    }

    /// The code of a text that is one fenced block (a closing fence inside means several).
    fn fence_code(text: &str) -> Option<&str> {
        let t = text.trim();
        let ticks = t.len() - t.trim_start_matches('`').len();
        if ticks < 3 {
            return None;
        }
        let (fence, rest) = t.split_at(ticks);
        let (lang, body) = rest.split_once('\n')?;
        if !lang.chars().all(|c| c.is_ascii_alphanumeric() || "_+#.-".contains(c)) {
            return None;
        }
        let body = body.strip_suffix(fence)?;
        let code = body.strip_suffix('\n').unwrap_or(body);
        (!code.lines().any(|l| l.trim_end() == fence)).then_some(code)
    }

    /// The first line number of `N<tab>`-prefixed lines that count up by one.
    fn numbers(code: &str) -> Option<u64> {
        let mut first = None;
        for (i, line) in code.split('\n').enumerate() {
            let (n, _) = line.trim_start().split_once('\t')?;
            let n: u64 = n.parse().ok().filter(|_| n.bytes().all(|b| b.is_ascii_digit()))?;
            if n != *first.get_or_insert(n) + i as u64 {
                return None;
            }
        }
        first
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
    /// - `_meta.claudeCode.parentToolUseId`: the Task call that started the subagent. It is on
    ///   message and thought chunks too; without it the subagent's text joins the main Agent's.
    /// - A Task call for a background subagent completes at once ("Async agent launched").
    /// - The background subagent's `SubagentHandback` call carries its final report.
    ///
    /// Background shell commands: a Bash call that runs in the background (or was moved there on
    /// timeout) completes at once, and the Agent sends no signal when the job ends. Without this,
    /// the Session looks idle while the job works.
    pub fn adjust(u: &Value, kind: &mut EventKind) {
        let parent = u.pointer("/_meta/claudeCode/parentToolUseId").and_then(Value::as_str).map(str::to_owned);
        match kind {
            EventKind::ToolCall { title, raw_input, parent_tool_call_id, report, .. } => {
                if title == "SubagentHandback" && parent.is_some() {
                    *report = raw_input.as_ref().and_then(|i| i["message"].as_str()).map(str::to_owned);
                }
                *parent_tool_call_id = parent;
            }
            EventKind::ToolCallUpdate { content, parent_tool_call_id, background, background_job, .. } => {
                let texts =
                    || content.as_ref().and_then(Value::as_array).into_iter().flatten().filter_map(|b| b.pointer("/content/text").and_then(Value::as_str));
                *background = texts().any(|t| t.starts_with("Async agent launched"));
                *background_job = texts().find_map(background_job_of);
                *parent_tool_call_id = parent;
            }
            EventKind::AgentMessageChunk { parent_tool_call_id, .. } | EventKind::AgentThoughtChunk { parent_tool_call_id, .. } => {
                *parent_tool_call_id = parent;
            }
            _ => {}
        }
    }

    /// Reads "Command running in background with ID: <id>. Output is being written to: <file>.output"
    /// or "... was moved to the background (ID: <id>). Output is being written to: ...".
    fn background_job_of(text: &str) -> Option<BackgroundJob> {
        let after = |marker: &str| text.find(marker).map(|i| &text[i + marker.len()..]);
        let rest = after("Command running in background with ID: ").or_else(|| after("moved to the background (ID: "))?;
        let id: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-').collect();
        let file = after("Output is being written to: ")?;
        let end = file.find(".output")? + ".output".len();
        let output_file = file[..end].trim().to_owned();
        (!id.is_empty() && output_file.starts_with('/')).then_some(BackgroundJob { id, output_file })
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
            detail: None,
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
    fn claude_subagent_chunks_get_parent() {
        let u = json!({ "_meta": { "claudeCode": { "parentToolUseId": "task1" } } });
        let mut t = EventKind::AgentThoughtChunk { text: "hm".into(), parent_tool_call_id: None };
        adjust(&u, &mut t);
        assert!(matches!(&t, EventKind::AgentThoughtChunk { parent_tool_call_id: Some(p), .. } if p == "task1"));
        let mut m = EventKind::AgentMessageChunk { text: "hi".into(), parent_tool_call_id: None };
        adjust(&u, &mut m);
        assert!(matches!(&m, EventKind::AgentMessageChunk { parent_tool_call_id: Some(p), .. } if p == "task1"));

        // The main Agent's chunks have no `_meta`.
        let mut m = EventKind::AgentMessageChunk { text: "hi".into(), parent_tool_call_id: None };
        adjust(&json!({}), &mut m);
        assert!(matches!(&m, EventKind::AgentMessageChunk { parent_tool_call_id: None, .. }));
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
        let info = subagent_info(Some(&task)).unwrap();
        assert_eq!((info.prompt.as_str(), info.agent_type.as_deref(), info.model), ("Look for X", Some("Explore"), None));
        let task = json!({ "description": "Find it", "prompt": "P", "subagent_type": "Plan", "model": "opus" });
        assert_eq!(subagent_info(Some(&task)).unwrap().model.as_deref(), Some("opus"));
        // A bare `prompt` is not a subagent task.
        assert_eq!(subagent_info(Some(&json!({ "prompt": "hi" }))), None);
        assert_eq!(subagent_info(None), None);
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
            background_job: None,
            harness_tool: None,
            plan: None,
            subagent: None,
            commit_message: None,
            detail: None,
        };
        adjust(&json!({}), &mut k);
        assert!(matches!(k, EventKind::ToolCallUpdate { background: true, .. }));
    }

    fn update_with_text(text: &str) -> EventKind {
        EventKind::ToolCallUpdate {
            tool_call_id: "bash1".into(),
            title: None,
            kind: None,
            status: Some("completed".into()),
            content: Some(json!([{ "type": "content", "content": { "type": "text", "text": text } }])),
            locations: None,
            raw_input: None,
            raw_output: None,
            parent_tool_call_id: None,
            background: false,
            background_job: None,
            harness_tool: None,
            plan: None,
            subagent: None,
            commit_message: None,
            detail: None,
        }
    }

    #[test]
    fn claude_background_shell_job() {
        let job = |text: &str| {
            let mut k = update_with_text(text);
            adjust(&json!({}), &mut k);
            match k {
                EventKind::ToolCallUpdate { background_job, background, .. } => {
                    assert!(!background);
                    background_job
                }
                _ => unreachable!(),
            }
        };
        let want = |id: &str, f: &str| Some(BackgroundJob { id: id.into(), output_file: f.into() });

        let started = "```console\nCommand running in background with ID: b771yrkd7. Output is being written to: /private/tmp/claude-501/-Users-x/abc/tasks/b771yrkd7.output. You will be notified when it completes.\n```";
        assert_eq!(job(started), want("b771yrkd7", "/private/tmp/claude-501/-Users-x/abc/tasks/b771yrkd7.output"));

        let moved = "Command did not complete within its 600s timeout and was moved to the background (ID: btk0ee6s2). Output is being written to: /private/tmp/x/tasks/btk0ee6s2.output. Check on it later.";
        assert_eq!(job(moved), want("btk0ee6s2", "/private/tmp/x/tasks/btk0ee6s2.output"));

        assert_eq!(job("total 0\ndrwxr-xr-x  2 me  staff  64 a"), None);
        assert_eq!(job("Command running in background with ID: x1."), None);
    }

    #[test]
    fn plan_option_facts_by_name() {
        let f = |n: &str, _id: &str| plan_option_facts(n);
        let want = |m: Option<&str>, c: bool| PlanOptionFacts { mode: m.map(str::to_owned), clears_context: c };
        assert_eq!(f("Yes, clear context and use auto mode", "a"), want(Some("auto"), true));
        assert_eq!(f("Yes, clear context and bypass permissions", "a"), want(Some("bypassPermissions"), true));
        assert_eq!(f("Yes, clear context and auto-accept edits", "a"), want(Some("acceptEdits"), true));
        assert_eq!(f("Yes, and use auto mode", "a"), want(Some("auto"), false));
        assert_eq!(f("Yes, and bypass permissions", "a"), want(Some("bypassPermissions"), false));
        assert_eq!(f("Yes, manually approve edits", "a"), want(Some("default"), false));
        assert_eq!(f("No, keep planning", "a"), want(None, false));
        assert_eq!(f("Implement plan", "implement_plan"), want(None, false));
        assert_eq!(f("Revise plan", "revise_plan"), want(None, false));
        assert_eq!(f("whatever", "x"), PlanOptionFacts::default());
    }
}
