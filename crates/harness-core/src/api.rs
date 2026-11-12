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
    ///
    /// A binary without a sha256 in the registry is refused unless `allow_unverified`. An update
    /// is installed side by side and switched to only if the headless conformance check passes;
    /// the previous version is kept for `RollbackAgent`. A held Agent is not updated.
    InstallAgent {
        registry_id: String,
        #[serde(default)]
        allow_unverified: bool,
    },
    /// Switches an Agent back to its previous version (and holds it there).
    RollbackAgent {
        agent_id: String,
    },
    /// Holds an Agent at its current version (`hold`) or releases it.
    HoldAgentVersion {
        agent_id: String,
        hold: bool,
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
        /// Branch to work on. With `worktree`, the base of the new Worktree's branch (started from its
        /// fetched origin copy when there is one); without, the folder is checked out to it
        /// (refused when the folder has changes).
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
    /// Creates a Quick Session: a Session with no folder from the user. The core makes an empty
    /// folder for it in `<data_dir>/quick/<id>/`, because an Agent needs a folder to start.
    CreateQuickSession {
        agent_id: String,
        frontend_id: String,
        title: Option<String>,
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
    /// Answers a `FrontendRequest` AppEvent. The first answer wins; an answer for an unknown
    /// `request_id` does nothing (several windows may answer).
    AnswerFrontendRequest {
        session_id: SessionId,
        request_id: String,
        answer: FrontendAnswer,
    },
    /// Reads the JSON at an https URL, e.g. a theme's shadcn registry item (tweakcn), for the app to import.
    FetchJson {
        url: String,
    },
    /// Where new Worktrees go (`WorktreeDir`).
    GetWorktreeDir,
    /// `dir`: relative to the repository folder, or absolute (`~` is home). None resets to `.harness`.
    SetWorktreeDir {
        dir: Option<String>,
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
    /// Lines `start..=end` (1-based, clipped; default: the whole file) of a text file in the Session's folder
    /// (relative or absolute inside it; a relative path may also be the end of one, see `editor::find_by_suffix`), e.g.
    /// for a file reference in a message. Fails for files outside the folder,
    /// missing, too large, binary or not UTF-8.
    ReadSessionFile {
        session_id: SessionId,
        path: String,
        #[serde(default)]
        start: Option<u32>,
        #[serde(default)]
        end: Option<u32>,
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
    /// A Frontend Tool item failed in the UI (e.g. a script error in a render_ui Html frame).
    /// `item` is the call's `id`, or its `call_id` when it has none. Logged as `FrontendError`
    /// (repeats and items that are gone are ignored) so the Agent learns about it.
    ReportFrontendError {
        session_id: SessionId,
        tool: String,
        item: String,
        message: String,
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
    /// Fast-forwards a local `branch` of the repository containing `folder` to its `origin` counterpart:
    /// a pull when it is checked out in `folder`, else a fetch into the branch (fails when it is checked
    /// out elsewhere or has diverged).
    UpdateBranch {
        folder: String,
        branch: String,
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
    /// Deletes a Quick Session that nobody used: no prompt was sent and its folder is empty.
    /// Does nothing for any other Session or an unknown id, so an out-of-date caller loses no work.
    DiscardEmptySession {
        session_id: SessionId,
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
    /// What PR references in this Session resolve against: its GitHub repo (`upstream`, else `origin`), the repos of
    /// all Sessions (best first) and the `gh` user.
    PrContext {
        session_id: SessionId,
    },
    /// PRs by reference via `gh`, in the same order; `None` for one that does not exist. Cached.
    LookupPrs {
        session_id: SessionId,
        refs: Vec<PrRefKey>,
    },
    /// Up to 30 PRs of `repo` in any state, the user's own first; `query` matches titles.
    SearchPrs {
        session_id: SessionId,
        repo: RepoId,
        query: Option<String>,
    },
    /// The Session's GitHub repo, the PR it works on (the one it started from, else the newest PR, open
    /// first, whose head is the current branch) and `base`, where the branch merges to: the Worktree's
    /// base, else the PR's, else the remote's default branch. `repo` and `pr` None without a GitHub
    /// remote; `pr` None without `gh`. Cached like PR references, unless `refresh` (drops the cached
    /// PR the Session started from).
    BranchPr {
        session_id: SessionId,
        #[serde(default)]
        refresh: bool,
    },
    /// The Session's Terminal tabs (a first one exists implicitly; ADR 0017).
    ListTerminals {
        session_id: SessionId,
    },
    /// A new Terminal tab; its shell starts on the first attach. Returns its id.
    TerminalOpen {
        session_id: SessionId,
    },
    /// Kills the tab's shell and removes the tab.
    TerminalClose {
        session_id: SessionId,
        terminal_id: u32,
    },
    /// Keystrokes or pasted text for a Terminal (attach first, ADR 0017).
    TerminalInput {
        session_id: SessionId,
        terminal_id: u32,
        data: String,
    },
    TerminalResize {
        session_id: SessionId,
        terminal_id: u32,
        cols: u16,
        rows: u16,
    },
    /// The Frontend has drawn `bytes` of Terminal output (flow control).
    TerminalAck {
        session_id: SessionId,
        terminal_id: u32,
        bytes: u32,
    },
    /// Ends the tab's shell; the tab stays and the next attach starts a new one.
    TerminalKill {
        session_id: SessionId,
        terminal_id: u32,
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
    /// Starts a new Agent Session for a Thread, seeded with a transcript of the Thread so far. The
    /// way out of a Thread whose Agent Session cannot be restored. `text`, when given, is prompted
    /// right away, with `attachments`.
    ContinueWithSummary {
        session_id: SessionId,
        thread_id: Option<ThreadId>,
        text: Option<String>,
        #[serde(default)]
        attachments: Vec<AttachmentInput>,
    },
    /// Opens a Side Thread on the Session's Agent. `seed` is given to the Agent with its first
    /// prompt. `source` says how its Agent Session starts (a fork of the Main Thread's, a text
    /// seed of the Main Thread's transcript, or fresh without it).
    StartSideThread {
        session_id: SessionId,
        #[serde(default)]
        seed: Option<String>,
        #[serde(default)]
        source: ThreadStart,
        /// The mode option value the Side Thread starts in. `None`, or a value the Agent does not
        /// offer, starts it in the mode that asks before writes.
        #[serde(default)]
        mode: Option<String>,
    },
    ResolvePermission {
        session_id: SessionId,
        request_id: String,
        /// `None` answers "cancelled". Choosing an `*_always` option also adds a Session rule.
        option_id: Option<String>,
        /// With an `*_always` option, the rule applies to every Session (Global scope) instead of this Session.
        #[serde(default)]
        global: bool,
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
    /// `OverlaySettings`: the Quick overlay's global shortcut and where it opens.
    Overlay,
}

/// The Quick overlay's settings (`AppSettingKey::Overlay`, `overlay.json`). Missing fields take
/// their defaults, so an older or hand-edited file still loads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default)]
pub struct OverlaySettings {
    /// Global shortcut in the `global-hotkey` format, e.g. `Alt+Space`, `CmdOrCtrl+Shift+K`.
    pub shortcut: String,
    pub position: OverlayPosition,
    /// While the overlay is open, a removable chip shows the app the user is looking at (and its
    /// window, page, selection); each message sends it as an attachment (ADR 0022 Phase 3).
    pub window_context: bool,
}

impl Default for OverlaySettings {
    fn default() -> Self {
        Self { shortcut: "Alt+Space".to_owned(), position: OverlayPosition::Cursor, window_context: true }
    }
}

/// Where the overlay's prompt box opens: at the mouse, or at the bottom center of that screen.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum OverlayPosition {
    #[default]
    Cursor,
    Bottom,
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

/// Who ran a git action.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum GitActor {
    Agent,
    #[default]
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
    Agents {
        agents: Vec<AgentInfo>,
    },
    Registry {
        agents: Vec<RegistryAgent>,
    },
    AgentInstalled {
        agent: AgentInfo,
    },
    Frontends {
        frontends: Vec<FrontendManifest>,
    },
    Sessions {
        sessions: Vec<SessionSummary>,
    },
    SessionCreated {
        session_id: SessionId,
    },
    /// `forked`: the Agent Session will be a fork of the Main Thread's. The Thread's
    /// `AgentSessionStarted` boundary tells how it started (a fork can fall back to a seed).
    ThreadStarted {
        thread_id: ThreadId,
        forked: bool,
    },
    Branches {
        branches: Branches,
    },
    PullRequests {
        prs: Vec<PullRequest>,
    },
    /// `me`: the `gh` user, None when `gh` is not signed in.
    PrContext {
        session_repo: Option<RepoId>,
        known_repos: Vec<KnownRepo>,
        me: Option<String>,
    },
    PrLookup {
        prs: Vec<Option<PrInfo>>,
    },
    PrSearch {
        prs: Vec<PrInfo>,
    },
    BranchPr {
        repo: Option<RepoId>,
        pr: Option<PrInfo>,
        base: Option<String>,
    },
    GitStatus {
        status: GitStatus,
    },
    GitLog {
        commits: Vec<Commit>,
    },
    Terminals {
        terminals: Vec<TerminalInfo>,
    },
    TerminalOpened {
        terminal_id: u32,
    },
    Diff {
        diff: Diff,
    },
    Committed {
        commit: String,
    },
    McpServers {
        servers: Vec<McpServerDef>,
    },
    McpServerSaved {
        server: McpServerDef,
    },
    FileContent {
        content: String,
    },
    /// `lines` start at line `start` (1-based); `total`: the file's line count; `path`: the file, relative to the folder.
    FileLines {
        path: String,
        start: u32,
        lines: Vec<String>,
        total: u32,
    },
    State {
        #[specta(type = specta_typescript::Unknown)]
        state: Json,
    },
    Editor {
        editor: Option<Editor>,
    },
    /// Where new Worktrees go: relative to the repository folder, or absolute (`~` is home).
    WorktreeDir {
        dir: String,
    },
    /// An app setting's value, or fetched JSON (`FetchJson`).
    Json {
        #[specta(type = Option<specta_typescript::Unknown>)]
        value: Option<Json>,
    },
    Files {
        files: Vec<String>,
    },
    PermissionRules {
        rules: Vec<PermissionRule>,
    },
    PermissionRuleAdded {
        rule: PermissionRule,
    },
    /// `data` is base64.
    Attachment {
        mime: String,
        data: String,
    },
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
    /// Hash, previous version, hold and last check of an installed Agent (ADR 0007).
    #[serde(default)]
    pub install: InstallInfo,
}

/// What the Harness knows about an installed Agent's files.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct InstallInfo {
    /// sha256 of the downloaded artifact (binary installs); `None` for npx/uvx.
    #[serde(default)]
    pub sha256: Option<String>,
    /// The registry listed no sha256: installed on the user's say-so.
    #[serde(default)]
    pub unverified: bool,
    /// The version kept for rollback.
    #[serde(default)]
    pub previous: Option<PreviousInstall>,
    /// Not updated while held.
    #[serde(default)]
    pub held: bool,
    /// The last conformance check (of this version, or of an update that was refused).
    #[serde(default)]
    pub check: Option<ConformanceCheck>,
}

/// Launch spec of the version an Agent can roll back to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct PreviousInstall {
    pub version: String,
    pub command: String,
    pub args: Vec<String>,
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub unverified: bool,
}

/// Result of the headless conformance check of one Agent version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct ConformanceCheck {
    pub version: Option<String>,
    pub passed: bool,
    /// The Agent needs sign-in: spawn and protocol passed, `session/new` was not completed.
    pub auth_required: bool,
    /// Why it failed, with the stderr tail.
    pub error: Option<String>,
    #[specta(type = specta_typescript::Number)]
    pub at_ms: u64,
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
    /// The Frontend answers the call: the result goes back to the Agent, nothing goes in the Session Log.
    #[serde(default)]
    pub replies: bool,
}

/// A Frontend's answer to a `FrontendRequest`. `error` makes it a tool error for the Agent; else
/// the Agent gets `text` then `image`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
pub struct FrontendAnswer {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<FrontendImage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct FrontendImage {
    pub mime: String,
    /// Base64 (standard alphabet, no `data:` prefix).
    pub data: String,
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
    /// The repo's main line, as named in `branches` (or in `remote` when it has no local branch). `None` when unknown.
    pub default_branch: Option<String>,
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
    /// Branch of an archived Session's removed Worktree. Set by the Host's `ListBranches` only.
    pub archived: bool,
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

/// A GitHub repository, e.g. `supabase/spark`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
pub struct RepoId {
    pub owner: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
pub struct PrRefKey {
    pub repo: RepoId,
    pub number: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum PrState {
    Open,
    Draft,
    Merged,
    Closed,
}

/// A PR of any GitHub repository, as shown by a PR reference.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct PrInfo {
    pub repo: RepoId,
    pub number: u32,
    pub title: String,
    pub author: String,
    pub state: PrState,
    pub checks: PrChecks,
    /// Checks that passed (success, neutral, skipped) of all checks.
    pub checks_passed: u32,
    pub checks_total: u32,
    pub additions: u32,
    pub deletions: u32,
    pub changed_files: u32,
    /// RFC 3339.
    pub updated_at: String,
    pub url: String,
}

/// A GitHub repository some Sessions work in. `score` adds up each Session's recency (1 now, halving every ~3 weeks).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct KnownRepo {
    pub repo: RepoId,
    pub sessions: u32,
    #[specta(type = specta_typescript::Number)]
    pub score: f64,
    /// Last activity of its Sessions.
    #[specta(type = specta_typescript::Number)]
    pub last_ms: i64,
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
    /// The folder the Session was started in: for a Worktree Session the same folder in the
    /// repository the Worktree came from, else the Session's folder.
    pub source_folder: String,
    /// The Session's own `harness/...` branch when it has a Worktree.
    pub worktree_branch: Option<String>,
    pub base_branch: Option<String>,
    /// Branch checked out in the Session's folder; None when not a git repo or HEAD is detached.
    pub branch: Option<String>,
    /// The PR the Session started from, else the last PR found for its current branch.
    pub pr: Option<u32>,
}

/// One Terminal tab of a Session (ADR 0017).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct TerminalInfo {
    pub id: u32,
    /// Foreground program while one runs, else the shell name and tab index.
    pub title: String,
    /// A shell runs (false after it ended, until the next attach).
    pub running: bool,
    /// A program other than the shell is in the foreground.
    pub busy: bool,
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
    /// Time of the Session's last activity (last Session Log Event), else `created_ms`.
    #[specta(type = specta_typescript::Number)]
    pub updated_ms: i64,
    pub status: SessionStatus,
    pub archived: bool,
    /// A Quick Session: `folder` is a folder the Harness made for it.
    pub quick: bool,
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

/// What a tool call that starts a subagent asked it to do.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct SubagentInfo {
    pub prompt: String,
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
    /// A Session's Terminal tabs opened, closed, or a shell started or ended: re-list them.
    /// Titles and `busy` change silently: poll while a Terminal is shown.
    TerminalsChanged {
        session_id: SessionId,
    },
    /// The Agent called a Frontend Tool that `replies`: a window answers with `AnswerFrontendRequest`.
    /// `last_seq` is the newest Session Log event at request time, so a UI can replay the log up to
    /// it. Live only and not logged: Views still render only from the Session Log.
    FrontendRequest {
        session_id: SessionId,
        request_id: String,
        tool: String,
        #[specta(type = specta_typescript::Unknown)]
        input: Json,
        #[specta(type = specta_typescript::Number)]
        last_seq: u64,
    },
}

/// Why a Command failed, so Frontends branch on a code and never on the message text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// The Agent needs the user to sign in first.
    AuthRequired,
    /// A Session, Thread, Agent or other id the Command names does not exist.
    NotFound,
    /// The Command conflicts with the current state (already exists, archived, unmerged work).
    Conflict,
    /// The Permission Policy or a sandbox rule forbids it (a path outside the Session's folder).
    PolicyDenied,
    /// The Agent is not running, not installed or its Agent Session could not be restored.
    AgentUnavailable,
    /// The Command's input is wrong (empty, malformed, not supported here).
    Invalid,
    /// Anything else.
    Internal,
}

/// The error of a Command: a code to branch on and a message for the user.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct HarnessError {
    pub code: ErrorCode,
    pub message: String,
}

impl std::fmt::Display for HarnessError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for HarnessError {}

/// What a Session subscription delivers to a View: Events, then possibly one `Lagged`.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(untagged)]
#[allow(clippy::large_enum_variant, reason = "built per delivery, never stored")]
pub enum SessionMessage {
    Event(Event),
    Lagged(Lagged),
}

/// The View fell too far behind and its subscription was dropped. Events up to `last_seq` were
/// delivered (`null`: none yet); resubscribe from `last_seq + 1` (from the first `from_seq`
/// when `null`).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Lagged {
    #[specta(type = Option<specta_typescript::Number>)]
    pub last_seq: Option<u64>,
}

/// Receives Events for one subscription. Returns `false` once the receiver is gone.
pub trait EventSink: Send + Sync + 'static {
    fn send(&self, event: &Event) -> bool;
    /// The subscription was dropped because the receiver was too slow (see `Lagged`).
    fn lagged(&self, _last_seq: Option<u64>) {}
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
        .register::<HarnessError>()
        .register::<SessionMessage>()
        .register::<OverlaySettings>()
}

pub fn export_ts() -> String {
    specta_typescript::Typescript::default()
        .header("// @generated by harness-core gen-ts. DO NOT EDIT.\n/* eslint-disable */")
        .export(&types(), specta_serde::Format)
        .expect("export ts")
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
