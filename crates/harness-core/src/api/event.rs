//! Session Log Events.

use serde::{Deserialize, Serialize};
use specta::Type;

use super::*;

/// One entry of a Session Log, as delivered to Views.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Event {
    /// Schema version of this event.
    pub v: u16,
    #[specta(type = specta_typescript::Number)]
    pub seq: u64,
    pub session_id: SessionId,
    pub thread_id: Option<ThreadId>,
    #[specta(type = specta_typescript::Number)]
    pub ts_ms: i64,
    pub kind: EventKind,
}

pub const EVENT_SCHEMA_VERSION: u16 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type")]
pub enum EventKind {
    SessionCreated {
        title: String,
        frontend_id: String,
        agent_id: String,
        folder: String,
    },
    SessionStatusChanged {
        status: SessionStatus,
    },
    ThreadStarted {
        agent_id: String,
        main: bool,
        /// Side Threads: the Main Thread's last finished Turn when this one started. `None` for the
        /// Main Thread and a fresh Side Thread.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        forked_from: Option<ForkPoint>,
    },
    /// The Agent needs the user to sign in before it can work.
    AuthRequired {
        methods: Vec<AuthMethodInfo>,
        message: String,
    },
    /// The Thread's Agent Session could not be restored; the Thread stays readable and can be
    /// continued from a transcript. `retryable`: the Agent supports resume or load, so the next
    /// prompt tries again. Logs from before these fields read as not retryable.
    ThreadReadOnly {
        reason: String,
        #[serde(default)]
        retryable: bool,
        /// Why each method failed, for the user.
        #[serde(default)]
        errors: Vec<String>,
        /// What a transcript would hold right now.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        transcript: Option<TranscriptSize>,
    },
    /// Restoring the Thread's Agent Session failed and is being tried again.
    AgentSessionRestoring {
        attempt: u32,
        of: u32,
    },
    /// A new Agent Session now backs the Thread. Anything but `initial` is a visible boundary.
    AgentSessionStarted {
        acp_session_id: String,
        boundary: Boundary,
        /// `continued_with_summary`: what its transcript held.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        transcript: Option<TranscriptSize>,
    },
    AgentProcessState {
        state: ProcessState,
        message: Option<String>,
    },
    /// What the Agent accepts in prompts, from its `initialize` answer.
    AgentCapabilities {
        image: bool,
        embedded_context: bool,
    },
    TurnStarted {
        turn_id: TurnId,
        text: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        attachments: Vec<Attachment>,
        /// The `<harness_context>` block sent before `text`, on the first prompt of an Agent Session.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        context: Option<String>,
        /// Set when another Session's Agent sent the prompt, not the user.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        origin: Option<PromptOrigin>,
    },
    TurnEnded {
        turn_id: TurnId,
        /// ACP stop reason (`end_turn`, `cancelled`, ...) or `error`.
        stop_reason: String,
    },
    AgentMessageChunk {
        text: String,
        /// The tool call (a subagent's Task) this chunk belongs to; `None` for the Thread's own text.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent_tool_call_id: Option<String>,
    },
    AgentThoughtChunk {
        text: String,
        /// The tool call (a subagent's Task) this chunk belongs to; `None` for the Thread's own text.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent_tool_call_id: Option<String>,
    },
    ToolCall {
        tool_call_id: String,
        title: String,
        kind: Option<String>,
        status: Option<String>,
        #[specta(type = specta_typescript::Unknown)]
        content: Json,
        #[specta(type = specta_typescript::Unknown)]
        locations: Json,
        #[specta(type = Option<specta_typescript::Unknown>)]
        raw_input: Option<Json>,
        /// The tool call that started the subagent which made this call.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent_tool_call_id: Option<String>,
        /// This call hands the subagent's final report to its parent: the text.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        report: Option<String>,
        /// The Harness MCP tool this calls (`git_status`), when it is one.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        harness_tool: Option<String>,
        /// A plan the Agent asks to be approved (a mode switch carrying one): Markdown.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        plan: Option<String>,
        /// This call starts a subagent: what it was asked to do.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        subagent: Option<SubagentInfo>,
        /// `git_commit`: the commit message.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        commit_message: Option<String>,
    },
    ToolCallUpdate {
        tool_call_id: String,
        title: Option<String>,
        kind: Option<String>,
        status: Option<String>,
        #[specta(type = Option<specta_typescript::Unknown>)]
        content: Option<Json>,
        #[specta(type = Option<specta_typescript::Unknown>)]
        locations: Option<Json>,
        /// Agents often send the full input only here (the `ToolCall` carries `{}` while streaming).
        #[specta(type = Option<specta_typescript::Unknown>)]
        raw_input: Option<Json>,
        #[specta(type = Option<specta_typescript::Unknown>)]
        raw_output: Option<Json>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent_tool_call_id: Option<String>,
        /// The call finished but its work goes on in the background (a background subagent,
        /// done when its report arrives).
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        background: bool,
        /// The call started a shell command that goes on running in the background: the job.
        /// Done when `BackgroundJobEnded` names it, or when the Agent process stopped after it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        background_job: Option<BackgroundJob>,
        /// Set when the update changes the title to a Harness MCP tool.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        harness_tool: Option<String>,
        /// Set when the update carries the plan (see `ToolCall`).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        plan: Option<String>,
        /// Set when the update carries the subagent's task (see `ToolCall`).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        subagent: Option<SubagentInfo>,
        /// Set when the update carries the commit message (see `ToolCall`).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        commit_message: Option<String>,
    },
    /// Appended by the Harness when a background job's output file is no longer open by any
    /// process: the job ended (see `ToolCallUpdate.background_job`).
    BackgroundJobEnded {
        job_id: String,
    },
    TaskListUpdated {
        entries: Vec<TaskEntry>,
    },
    ModeChanged {
        mode_id: String,
    },
    /// Config options (modes, models, thought level...) as offered by the Agent.
    ConfigOptionsChanged {
        #[specta(type = specta_typescript::Unknown)]
        options: Json,
        /// The mode option's value a new Side Thread starts in by default (the one that asks
        /// before writes), so Views can show it before the Side Thread exists.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        side_mode: Option<String>,
    },
    AvailableCommandsChanged {
        commands: Vec<SlashCommand>,
    },
    UsageUpdated {
        #[specta(type = specta_typescript::Unknown)]
        usage: Json,
    },
    SessionInfoUpdated {
        title: Option<String>,
    },
    PermissionRequested {
        request_id: String,
        #[specta(type = specta_typescript::Unknown)]
        tool_call: Json,
        options: Vec<PermissionOption>,
        /// The Harness MCP tool the request is for, when it is one.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        harness_tool: Option<String>,
        /// The request approves a plan (Plan Mode): Markdown.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        plan: Option<String>,
        /// `git_commit`: the commit message.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        commit_message: Option<String>,
        /// The request is for a Frontend Tool: its name.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        frontend_tool: Option<String>,
    },
    PermissionResolved {
        request_id: String,
        option_id: Option<String>,
        by: Resolver,
        /// The Permission Policy rule that decided, when `by` is `policy` (none for a default).
        #[serde(default)]
        rule_id: Option<String>,
    },
    /// The user's "always" answer was remembered as a Session-scoped rule.
    PermissionRuleAdded {
        rule: PermissionRule,
    },
    /// Files changed in the Workspace during a Turn (snapshot trees before and after).
    WorkspaceChanged {
        turn_id: TurnId,
        from_tree: String,
        to_tree: String,
        files: Vec<FileChange>,
    },
    /// An Agent called a Frontend Tool; its validated input is stored at `path` (relative to the
    /// Session's `frontend/` directory).
    FrontendToolOutput {
        tool: String,
        call_id: String,
        path: String,
        #[specta(type = specta_typescript::Unknown)]
        input: Json,
        /// Local images the input names (`"format": "harness-image"`): src as given -> the copy,
        /// relative to `frontend/`. Read them with `FrontendReadImage`.
        #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
        files: std::collections::BTreeMap<String, String>,
    },
    /// The UI reported an error in a Frontend Tool item (`ReportFrontendError`). The Agent sees
    /// it in `harness_info` and at the start of its next prompt on this Thread; a new call with
    /// the item's id clears it.
    FrontendError {
        tool: String,
        item: String,
        message: String,
    },
    /// The Session State changed (ADR 0015). Applying every `ops` in order to `{}` gives the
    /// current state.
    StateChanged {
        ops: Vec<StatePatchOp>,
        by: StateWriter,
    },
    /// The Session attached a Shared Artifact (ADR 0024): it shows as a Panel.
    ArtifactAttached {
        id: String,
        by: StateWriter,
    },
    ArtifactDetached {
        id: String,
        by: StateWriter,
    },
    /// This Session changed a Shared Artifact's state. Not replayed into any state: Views read the
    /// artifact's current state with `SharedArtifactRead` (ADR 0024 addendum).
    ArtifactStateChanged {
        id: String,
        ops: Vec<StatePatchOp>,
        by: StateWriter,
    },
    GitCommitted {
        commit: String,
        message: String,
        #[serde(default)]
        by: GitActor,
    },
    GitPushed {
        branch: String,
        #[serde(default)]
        by: GitActor,
    },
    SessionArchived {
        archived: bool,
    },
    /// An ACP session notice: information for the user outside the Agent's reply (e.g. hook
    /// output). `severity` is `info`, `warning`, `error` or a custom value.
    AgentNotice {
        severity: String,
        title: String,
        description: Option<String>,
    },
    /// An ACP update the Harness does not normalize yet; kept so nothing is lost.
    AgentUpdate {
        #[specta(type = specta_typescript::Unknown)]
        update: Json,
    },
    Error {
        message: String,
    },
    /// Stands in for a line whose `type` this build does not know (written by a newer build) or
    /// whose fields do not parse, so `seq` stays contiguous. The Session Log file keeps the
    /// original line; the Harness never writes this. Not `#[serde(other)]`: specta cannot export
    /// that on an internally tagged enum, so `log.rs` substitutes it when parsing.
    Unknown,
}

impl EventKind {
    /// `ConfigOptionsChanged` for the Agent's options, with the mode a new Side Thread starts in.
    pub fn config_options(options: Json) -> EventKind {
        let side_mode = options
            .as_array()
            .and_then(|a| a.iter().find(|o| crate::log::is_mode_option(o)))
            .and_then(|mode| crate::agent_quirks::asking_mode(&option_values(mode)).map(str::to_owned));
        EventKind::ConfigOptionsChanged { options, side_mode }
    }
}

/// The values a select config option offers.
pub(crate) fn option_values(option: &Json) -> Vec<&str> {
    option["options"].as_array().into_iter().flatten().filter_map(|o| o["value"].as_str()).collect()
}

/// A shell command an Agent runs in the background after its tool call finished.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct BackgroundJob {
    /// The Agent's id for the job.
    pub id: String,
    /// The file the job writes its output to.
    pub output_file: String,
}

/// What a tool call that starts a subagent asked it to do.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct SubagentInfo {
    pub prompt: String,
    /// The subagent's type (e.g. `Explore`), when the Agent names one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<String>,
    /// The model the subagent runs on, when the call sets one; else it inherits the Thread's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

/// How many of a Thread's Turns fit in a transcript.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct TranscriptSize {
    pub kept_turns: u32,
    pub total_turns: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum Boundary {
    Initial,
    Resumed,
    Loaded,
    Reseeded,
    AgentSwitched,
    ContinuedWithSummary,
    /// A Side Thread's Agent Session forked from the Main Thread's.
    Forked,
}

/// How a Side Thread's Agent Session starts. `Fork` falls back to `Seed` when the Agent cannot
/// fork, the Main Thread has no Agent Session or is mid-Turn, or the fork fails.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ThreadStart {
    #[default]
    Fork,
    Seed,
    /// A new Agent Session without the Main Thread's conversation (same Workspace). Transcript
    /// tools are not offered.
    Fresh,
}

/// A place in a Thread: after its `turn`-th finished Turn (1-based, 0 = none), at log `seq`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct ForkPoint {
    pub thread_id: ThreadId,
    pub turn: u32,
    #[specta(type = specta_typescript::Number)]
    pub seq: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ProcessState {
    Starting,
    Ready,
    /// Stopped by the Harness (idle); restarted on the next prompt.
    Stopped,
    Exited,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum Resolver {
    Policy,
    View,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct TaskEntry {
    pub content: String,
    pub priority: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SlashCommand {
    pub name: String,
    pub description: String,
    pub hint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct PermissionOption {
    pub option_id: String,
    pub name: String,
    /// ACP kind: allow_once, allow_always, reject_once, reject_always.
    pub kind: String,
    /// Plan approvals only: the Agent mode this option switches to (e.g. "acceptEdits").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_mode: Option<String>,
    /// Plan approvals only: this option also clears the context.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub clears_context: bool,
}

/// What a Session subscription delivers to a View: Events, then possibly one `Lagged`.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(untagged)]
#[allow(clippy::large_enum_variant, reason = "built per delivery, never stored")]
pub enum SessionMessage {
    Event(Event),
    Lagged(Lagged),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_options_reports_the_side_mode() {
        let mode = |values: &[&str]| {
            let options: Vec<Json> = values.iter().map(|v| serde_json::json!({ "value": v, "name": v })).collect();
            serde_json::json!([{ "id": "model", "currentValue": "m", "options": [{ "value": "m" }] }, { "id": "mode", "category": "mode", "currentValue": values[0], "options": options }])
        };
        let side = |options| match EventKind::config_options(options) {
            EventKind::ConfigOptionsChanged { side_mode, .. } => side_mode,
            _ => unreachable!(),
        };
        assert_eq!(side(mode(&["acceptEdits", "default", "plan"])), Some("default".into()));
        assert_eq!(side(mode(&["auto", "read-only"])), Some("read-only".into()));
        assert_eq!(side(mode(&["yolo"])), None);
        assert_eq!(side(serde_json::json!([{ "id": "model", "currentValue": "m" }])), None);
        assert_eq!(side(Json::Null), None);
        // Skipped when unknown, so older logs and Agents without a mode option stay unchanged.
        let json = serde_json::to_value(EventKind::config_options(Json::Null)).unwrap();
        assert!(json.get("side_mode").is_none());
    }
}
