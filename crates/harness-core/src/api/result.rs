//! What a Command returns.

use serde::{Deserialize, Serialize};
use specta::Type;

use super::*;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type")]
pub enum CommandResult {
    Ok,
    Notices {
        notices: Vec<StartupNotice>,
    },
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
    /// A panel source file; `hash`: sha256 of `content` (hex), to skip re-renders when unchanged;
    /// `mtime_ms`: when the file was last written (ms epoch, 0 when unknown); `path`: the file,
    /// absolute (for "copy path").
    PanelSource {
        content: String,
        hash: String,
        path: String,
        #[specta(type = specta_typescript::Number)]
        mtime_ms: i64,
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
    /// The file `ExportPlan` wrote (absolute).
    PlanFile {
        path: String,
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
    /// `ListSessionFiles`. `prefix`: the folder's path in its git repository (`crates/`, empty at the root or
    /// outside git), to match repo-relative paths such as git status to `files`.
    SessionFiles {
        files: Vec<String>,
        prefix: String,
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
    SharedArtifactList {
        artifacts: Vec<SharedArtifactEntry>,
    },
    /// A Shared Artifact that was shared, attached or renamed.
    SharedArtifactInfo {
        meta: SharedArtifactMeta,
    },
    /// `content`: `content.md`, `content.html` or `ui.json` (`{root, files}`, `files` relative to
    /// `dir`); `hash`: its sha256 (hex); `mtime_ms`: when it was last written (0 when unknown);
    /// `state`: the artifact's state (`{}` when none).
    SharedArtifact {
        meta: SharedArtifactMeta,
        content: String,
        hash: String,
        #[specta(type = specta_typescript::Number)]
        mtime_ms: i64,
        #[specta(type = specta_typescript::Unknown)]
        state: Json,
        /// The artifact's folder (absolute).
        dir: String,
    },
}
