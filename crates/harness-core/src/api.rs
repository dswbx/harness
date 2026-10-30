//! Public, transport-neutral API of the Harness core: Commands in, Events out.
//! Everything here is exported to TypeScript (see `export_ts`).

use serde::{Deserialize, Serialize};
use specta::Type;

pub type SessionId = String;
pub type ThreadId = String;
pub type TurnId = String;
/// Raw JSON passed through from ACP where the Harness does not normalize further.
pub type Json = serde_json::Value;

// ---------- Commands ----------

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type")]
pub enum Command {
    ListAgents,
    /// ACP Registry entries, from the local cache unless `refresh`.
    ListRegistry {
        #[serde(default)]
        refresh: bool,
    },
    /// Installs (or updates) an Agent from the ACP Registry onto the managed toolchain. Slow:
    /// may download a runtime and the Agent's package.
    InstallAgent {
        registry_id: String,
    },
    AddCustomAgent {
        name: String,
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: std::collections::BTreeMap<String, String>,
    },
    /// Removes an installed or Custom Agent. Sessions using it keep their own copy of its launch
    /// spec until next started.
    RemoveAgent {
        agent_id: String,
    },
    /// Runs an Agent-handled auth method (ACP `authenticate`) on the Session's Agent.
    Authenticate {
        session_id: SessionId,
        method_id: String,
    },
    /// Opens Terminal.app running the Agent's terminal auth method.
    OpenAuthTerminal {
        session_id: SessionId,
        method_id: String,
    },
    ListFrontends,
    ListSessions,
    CreateSession {
        /// Primary Workspace Folder (v1: exactly one).
        folder: String,
        agent_id: String,
        frontend_id: String,
        title: Option<String>,
        /// Branch to work on. With `worktree`, the base of the new Worktree's branch; without,
        /// the folder is checked out to it (refused when the folder has changes).
        #[serde(default)]
        branch: Option<String>,
        /// Work in a new Worktree on its own `harness/...` branch.
        #[serde(default)]
        worktree: bool,
        /// Create this branch from `branch` (default: the current one) and work on it; with
        /// `worktree`, it becomes the Worktree's branch instead of a `harness/...` one.
        #[serde(default)]
        new_branch: Option<String>,
        /// Start from this pull request (needs `gh`), on the PR's head branch: in a new Worktree
        /// with `worktree`, else checked out in the folder (refused when it has changes).
        /// `branch` and `new_branch` are ignored.
        #[serde(default)]
        pr: Option<u32>,
        /// MCP Library servers (ids) to give the Agent, besides the Harness MCP.
        #[serde(default)]
        mcp_servers: Vec<String>,
    },
    ListMcpServers,
    /// Adds or replaces an MCP Library server. `secrets` holds values for `secret_keys`; they go
    /// to the Keychain, never to disk. A missing secret keeps the stored one.
    SaveMcpServer {
        server: McpServerDef,
        #[serde(default)]
        secrets: std::collections::BTreeMap<String, String>,
    },
    RemoveMcpServer {
        server_id: String,
    },
    /// Reads a file of the Session's Frontend state (`frontend/` in the Session Directory).
    FrontendRead {
        session_id: SessionId,
        path: String,
    },
    /// An app setting (appearance, imported themes): JSON the app owns, null until saved.
    GetAppSetting {
        key: AppSettingKey,
    },
    /// Saves an app setting; null removes it.
    SetAppSetting {
        key: AppSettingKey,
        #[specta(type = Option<specta_typescript::Unknown>)]
        value: Option<Json>,
    },
    /// Reads the JSON at an https URL, e.g. a theme's shadcn registry item (tweakcn), for the app to import.
    FetchJson {
        url: String,
    },
    /// The user's editor for "Open in editor" (None until chosen).
    GetEditor,
    SetEditor {
        editor: Option<Editor>,
    },
    /// Opens the Session's folder, or `path` in it (relative or absolute, at `line`), in the user's editor.
    OpenInEditor {
        session_id: SessionId,
        #[serde(default)]
        path: Option<String>,
        #[serde(default)]
        line: Option<u32>,
    },
    /// The Session State (ADR 0015).
    GetState {
        session_id: SessionId,
    },
    /// Changes the Session State as the user (e.g. a bound UI component).
    PatchState {
        session_id: SessionId,
        ops: Vec<StatePatchOp>,
    },
    /// An image in `frontend/` (base64), e.g. one a Frontend Tool call named.
    FrontendReadImage {
        session_id: SessionId,
        path: String,
    },
    FrontendWrite {
        session_id: SessionId,
        path: String,
        content: String,
    },
    /// Files under `dir` (recursive, relative to `frontend/`).
    FrontendList {
        session_id: SessionId,
        #[serde(default)]
        dir: String,
    },
    /// Branches of the repository containing `folder`.
    ListBranches {
        folder: String,
    },
    /// Open pull requests of the GitHub repository containing `folder` (via `gh`). Fails when
    /// `gh` is missing, not signed in, or the folder has no GitHub remote.
    ListPullRequests {
        folder: String,
        #[serde(default)]
        filter: PrFilter,
    },
    /// Stops the Agent; a Worktree is WIP-committed (when dirty) and removed, its branch kept.
    ArchiveSession {
        session_id: SessionId,
    },
    /// Restores an archived Session's Worktree.
    UnarchiveSession {
        session_id: SessionId,
    },
    /// Deletes the Session and its Worktree and branch. Refuses unmerged or uncommitted work
    /// unless `force`.
    DeleteSession {
        session_id: SessionId,
        #[serde(default)]
        force: bool,
    },
    GitStatus {
        session_id: SessionId,
    },
    /// Diff of the Workspace. `from` defaults to where the Session's changes start (merge base
    /// with the Worktree's base branch, else HEAD); `to` defaults to the working tree now.
    GitDiff {
        session_id: SessionId,
        from: Option<String>,
        to: Option<String>,
    },
    /// Commits since where the Session's changes start (see GitDiff), newest first.
    GitLog {
        session_id: SessionId,
    },
    /// A file's content at `rev` (a commit or tree id, e.g. `Diff.from`/`Diff.to`); empty if absent there.
    GitShowFile {
        session_id: SessionId,
        rev: String,
        path: String,
    },
    /// Stages everything and commits (hooks run).
    GitCommit {
        session_id: SessionId,
        message: String,
    },
    /// Pushes the current branch to `origin`, setting upstream.
    GitPush {
        session_id: SessionId,
    },
    /// Start a Turn in a Thread (Main Thread when `thread_id` is absent). Returns immediately;
    /// progress arrives as Events.
    Prompt {
        session_id: SessionId,
        thread_id: Option<ThreadId>,
        text: String,
        /// Sent after `text`, in order. `text` may be empty when there are attachments.
        #[serde(default)]
        attachments: Vec<AttachmentInput>,
    },
    Cancel {
        session_id: SessionId,
        thread_id: Option<ThreadId>,
    },
    /// Starts the Agent and the Main Thread's Agent Session in the background, so its config
    /// options (models, modes) arrive before the first prompt. Returns at once; failures show up
    /// as events. Views send it when they open a Session. A no-op once the Main Thread has had an
    /// Agent Session: a stopped Agent is resumed by the next prompt, not by opening a View.
    WarmUp {
        session_id: SessionId,
    },
    /// Starts a new Agent Session for a Thread, seeded with a summary of the Thread so far. The
    /// way out of a read-only Thread. `text`, when given, is prompted right away.
    ContinueWithSummary {
        session_id: SessionId,
        thread_id: Option<ThreadId>,
        text: Option<String>,
    },
    /// Opens a Side Thread on the Session's Agent. `seed` is given to the Agent with its first prompt.
    StartSideThread {
        session_id: SessionId,
        seed: Option<String>,
    },
    ResolvePermission {
        session_id: SessionId,
        request_id: String,
        /// `None` answers "cancelled". Choosing an `*_always` option also adds a Session rule.
        option_id: Option<String>,
    },
    ListPermissionRules,
    AddPermissionRule {
        rule: NewPermissionRule,
    },
    RemovePermissionRule {
        rule_id: String,
    },
    SetConfigOption {
        session_id: SessionId,
        thread_id: Option<ThreadId>,
        config_id: String,
        value: String,
    },
    SetMode {
        session_id: SessionId,
        thread_id: Option<ThreadId>,
        mode_id: String,
    },
    /// Reads a stored attachment (base64). Only files in the Session Directory's `attachments/`.
    ReadAttachment {
        session_id: SessionId,
        path: String,
    },
    /// Reads an image file picked or dropped in the prompt box (base64), for its preview and
    /// scaling. Only image files by extension.
    ReadImageFile {
        path: String,
    },
}

/// App settings kept as JSON files in the data dir (`app_settings.rs`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum AppSettingKey {
    Appearance,
    Themes,
}

/// The editor "Open in editor" uses: a known editor's URL scheme, a custom URL template
/// (`{path}`, `{line}`), or the system default app (no line).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Editor {
    Vscode,
    Cursor,
    Windsurf,
    Zed,
    Custom { template: String },
    System,
}

/// One Session State patch operation (lenient JSON Patch, see `state.rs`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum StatePatchOp {
    Add {
        path: String,
        #[specta(type = specta_typescript::Unknown)]
        value: Json,
    },
    Replace {
        path: String,
        #[specta(type = specta_typescript::Unknown)]
        value: Json,
    },
    Remove {
        path: String,
    },
    Test {
        path: String,
        #[specta(type = specta_typescript::Unknown)]
        value: Json,
    },
}

/// Who changed the Session State.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum StateWriter {
    Agent,
    User,
}

/// A file given with a prompt.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AttachmentInput {
    /// A file on disk. Images are copied into the Session; other files are referenced in place.
    Path { path: String },
    /// Pasted bytes, stored in the Session. `data` is base64 (standard alphabet, no `data:` prefix).
    Data { name: String, mime: String, data: String },
}

/// An attachment as sent with a Turn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct Attachment {
    pub name: String,
    pub mime: String,
    /// Absolute path: the stored copy in `attachments/`, or the original file.
    pub path: String,
    pub kind: AttachmentKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum AttachmentKind {
    Image,
    File,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type")]
pub enum CommandResult {
    Ok,
    Agents { agents: Vec<AgentInfo> },
    Registry { agents: Vec<RegistryAgent> },
    AgentInstalled { agent: AgentInfo },
    Frontends { frontends: Vec<FrontendManifest> },
    Sessions { sessions: Vec<SessionSummary> },
    SessionCreated { session_id: SessionId },
    ThreadStarted { thread_id: ThreadId },
    Branches { branches: Branches },
    PullRequests { prs: Vec<PullRequest> },
    GitStatus { status: GitStatus },
    GitLog { commits: Vec<Commit> },
    Diff { diff: Diff },
    Committed { commit: String },
    McpServers { servers: Vec<McpServerDef> },
    McpServerSaved { server: McpServerDef },
    FileContent { content: String },
    State {
        #[specta(type = specta_typescript::Unknown)]
        state: Json,
    },
    Editor { editor: Option<Editor> },
    /// An app setting's value, or fetched JSON (`FetchJson`).
    Json {
        #[specta(type = Option<specta_typescript::Unknown>)]
        value: Option<Json>,
    },
    Files { files: Vec<String> },
    PermissionRules { rules: Vec<PermissionRule> },
    PermissionRuleAdded { rule: PermissionRule },
    /// `data` is base64.
    Attachment { mime: String, data: String },
}

/// A Permission Policy rule. The narrowest matching scope wins, then the more specific rule
/// (kind + pattern), then the stricter decision.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct PermissionRule {
    pub id: String,
    pub scope: RuleScope,
    /// ACP tool kind (read, edit, delete, move, search, execute, fetch, other); `None` = any.
    pub tool_kind: Option<String>,
    /// Command prefix for `execute`, otherwise a path glob (relative to the Workspace Folder).
    pub pattern: Option<String>,
    pub decision: Decision,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct NewPermissionRule {
    pub scope: RuleScope,
    pub tool_kind: Option<String>,
    pub pattern: Option<String>,
    pub decision: Decision,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RuleScope {
    Global,
    Agent { agent_id: String },
    Session { session_id: SessionId },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    Allow,
    Ask,
    Deny,
}

/// How to launch an Agent.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AgentInfo {
    pub id: String,
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub source: AgentSource,
    pub version: Option<String>,
    pub icon: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentSource {
    Registry {
        registry_id: String,
    },
    #[default]
    Custom,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RegistryAgent {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub icon: Option<String>,
    pub website: Option<String>,
    /// `binary`, `npx` or `uvx`; `None` when nothing installs on this machine.
    pub install_method: Option<String>,
    pub installed_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AuthMethodInfo {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    /// `agent` (call Authenticate) or `terminal` (call OpenAuthTerminal).
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct FrontendManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    /// Guidance for the Agent about this Frontend (its `instructions.md`), sent in `<harness_context>`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    #[serde(default)]
    pub frontend_tools: Vec<FrontendToolDecl>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct FrontendToolDecl {
    pub name: String,
    pub description: String,
    #[specta(type = specta_typescript::Unknown)]
    pub input_schema: Json,
}

/// An MCP server in the MCP Library.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct McpServerDef {
    /// Stable id; empty on first save means "derive from name".
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub transport: McpTransport,
    /// Env vars (stdio) or headers (http) whose values live in the Keychain.
    #[serde(default)]
    pub secret_keys: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum McpTransport {
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: std::collections::BTreeMap<String, String>,
    },
    Http {
        url: String,
        #[serde(default)]
        headers: std::collections::BTreeMap<String, String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Branches {
    /// `None` when the folder is not in a git repository.
    pub repo_root: Option<String>,
    /// `None` when HEAD is detached.
    pub current: Option<String>,
    /// Local branches, most recently committed first.
    pub branches: Vec<BranchInfo>,
    /// Remote branches with no local branch of the same name (`origin/x`), most recent first.
    pub remote: Vec<BranchInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct BranchInfo {
    pub name: String,
    /// Unix seconds of the last commit.
    #[specta(type = specta_typescript::Number)]
    pub time: i64,
    /// Commits ahead of / behind its upstream (0 without one).
    pub ahead: u32,
    pub behind: u32,
    /// Checked out in another Worktree (it can't be checked out again).
    pub worktree: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum PrFilter {
    #[default]
    Open,
    Mine,
    ReviewRequested,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct PullRequest {
    pub number: u32,
    pub title: String,
    pub author: String,
    /// Head branch name (on the fork when `fork`).
    pub head: String,
    pub base: String,
    pub draft: bool,
    pub fork: bool,
    pub checks: PrChecks,
    /// RFC 3339.
    pub updated_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum PrChecks {
    Passing,
    Failing,
    Pending,
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct GitStatus {
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<FileChange>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct FileChange {
    pub path: String,
    /// git status letter: M, A, D, R, T, U, or ? (untracked).
    pub status: String,
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Commit {
    pub sha: String,
    pub short: String,
    pub subject: String,
    pub author: String,
    pub author_email: String,
    pub committer: String,
    /// Message after the subject line (trailers such as `Co-authored-by:` included).
    pub body: String,
    /// Unix seconds, committer time.
    #[specta(type = specta_typescript::Number)]
    pub time: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Diff {
    pub from: String,
    pub to: String,
    pub files: Vec<FileChange>,
    /// Unified diff.
    pub patch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct WorkspaceInfo {
    pub repo_root: Option<String>,
    /// The Session's own `harness/...` branch when it has a Worktree.
    pub worktree_branch: Option<String>,
    pub base_branch: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SessionSummary {
    pub id: SessionId,
    pub title: String,
    pub frontend_id: String,
    pub agent_id: String,
    pub folder: String,
    #[specta(type = specta_typescript::Number)]
    pub created_ms: i64,
    pub status: SessionStatus,
    pub archived: bool,
    pub workspace: WorkspaceInfo,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Idle,
    Working,
    NeedsAttention,
}

// ---------- Events ----------

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
    },
    /// The Agent needs the user to sign in before it can work.
    AuthRequired {
        methods: Vec<AuthMethodInfo>,
        message: String,
    },
    /// The Thread's Agent Session cannot be continued; the Thread stays readable and can be
    /// continued with a summary.
    ThreadReadOnly {
        reason: String,
    },
    /// A new Agent Session now backs the Thread. Anything but `initial` is a visible boundary.
    AgentSessionStarted {
        acp_session_id: String,
        boundary: Boundary,
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
    },
    TurnEnded {
        turn_id: TurnId,
        /// ACP stop reason (`end_turn`, `cancelled`, ...) or `error`.
        stop_reason: String,
    },
    AgentMessageChunk {
        text: String,
    },
    AgentThoughtChunk {
        text: String,
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
        report: Option<String>,        /// The Harness MCP tool this calls (`git_status`), when it is one.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        harness_tool: Option<String>,
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
        background: bool,        /// Set when the update changes the title to a Harness MCP tool.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        harness_tool: Option<String>,
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
    /// The Session State changed (ADR 0015). Applying every `ops` in order to `{}` gives the
    /// current state.
    StateChanged {
        ops: Vec<StatePatchOp>,
        by: StateWriter,
    },
    GitCommitted {
        commit: String,
        message: String,
    },
    GitPushed {
        branch: String,
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
}

/// Harness-wide notifications (session list, attention), separate from Session Logs.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type")]
pub enum AppEvent {
    /// Sessions were created, deleted, archived or unarchived: reload the list.
    SessionsChanged,
    SessionStatus {
        session_id: SessionId,
        title: String,
        status: SessionStatus,
    },
    /// A Turn ended (`stop_reason` as in `TurnEnded`).
    TurnFinished {
        session_id: SessionId,
        title: String,
        stop_reason: String,
    },
    /// Agents were installed, updated or removed.
    AgentsChanged,
}

/// Receives Events for one subscription. Returns `false` once the receiver is gone.
pub trait EventSink: Send + Sync + 'static {
    fn send(&self, event: &Event) -> bool;
}

impl<F: Fn(&Event) -> bool + Send + Sync + 'static> EventSink for F {
    fn send(&self, event: &Event) -> bool {
        self(event)
    }
}

pub fn types() -> specta::Types {
    specta::Types::default()
        .register::<Command>()
        .register::<CommandResult>()
        .register::<Event>()
        .register::<AppEvent>()
}

pub fn export_ts() -> String {
    specta_typescript::Typescript::default()
        .header("// @generated by harness-core gen-ts. DO NOT EDIT.\n/* eslint-disable */")
        .export(&types(), specta_serde::Format)
        .expect("export ts")
}
