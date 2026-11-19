//! Commands into the Harness core.

use serde::{Deserialize, Serialize};
use specta::Type;

use super::*;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type")]
pub enum Command {
    /// Settings files that did not load, once each: reset to defaults, the file kept. Call after
    /// subscribing to AppEvents and again on `NoticesChanged`.
    TakeNotices,
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
        /// Work in a new Worktree on its own branch (`BranchPrefix`).
        #[serde(default)]
        worktree: bool,
        /// Create this branch from `branch` (default: the current one) and work on it; with
        /// `worktree`, it becomes the Worktree's branch instead of a prefixed one (`BranchPrefix`).
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
        /// Start from this task: link the Session to it and seed its first prompt (ADR 0028).
        #[serde(default)]
        task: Option<TaskStart>,
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
    /// Reads a file-backed panel's source (ADR 0023): `name` is relative to the Session's
    /// `panels/` folder and must stay inside it. Starts the watch that sends `PanelSourceChanged`.
    PanelSourceRead {
        session_id: SessionId,
        name: String,
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
    /// What new Session branches start with (`BranchPrefix`).
    GetBranchPrefix,
    /// None resets to `harness`.
    SetBranchPrefix {
        prefix: Option<BranchPrefix>,
    },
    /// Custom Instructions scopes: Global, then every repository known from Sessions or saved
    /// instructions (`Instructions`).
    ListInstructions,
    /// The saved text of a scope (`InstructionsText`, empty when none).
    GetInstructions {
        scope: InstructionsScope,
    },
    /// Saves a scope's text; empty (or only whitespace) deletes it.
    SetInstructions {
        scope: InstructionsScope,
        text: String,
    },
    /// Moves a repository's instructions to another folder (it was moved); `to` must exist and counts as its main
    /// checkout when it is a Worktree. Fails when `to` already has some. Returns `InstructionsMoved`.
    MoveInstructions {
        from: String,
        to: String,
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
    /// Writes `markdown` to `<Session dir>/plans/<name>.md` (`name` is cut to `[a-z0-9-]`) and returns the path
    /// (`PlanFile`). With `open_in_editor` it also opens that file in the user's editor.
    ExportPlan {
        session_id: SessionId,
        name: String,
        markdown: String,
        #[serde(default)]
        open_in_editor: bool,
    },
    /// Files in the Session's folder: relative paths, `/` separators, sorted. In a git repository, the files `.gitignore`
    /// does not exclude; elsewhere, all but hidden and build folders. Capped. Replies `SessionFiles`.
    ListSessionFiles {
        session_id: SessionId,
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
    /// Names the Session. Titles the Agent sends no longer replace it.
    SetSessionTitle {
        session_id: SessionId,
        title: String,
    },
    /// The user viewed the Session: clears `SessionSummary::unseen`.
    MarkSessionSeen {
        session_id: SessionId,
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
        /// Pending Review Comments this prompt carries: they become open once it is accepted.
        #[serde(default)]
        comment_ids: Vec<String>,
    },
    /// Adds a pending Review Comment (ADR 0027) as the user. Returns it.
    AddComment {
        session_id: SessionId,
        path: String,
        line: u32,
        side: Option<CommentSide>,
        code: String,
        text: String,
    },
    /// Changes a pending comment's text.
    EditComment {
        session_id: SessionId,
        id: String,
        text: String,
    },
    /// Deletes a pending comment.
    DeleteComment {
        session_id: SessionId,
        id: String,
    },
    /// Resolves an open comment as the user.
    ResolveComment {
        session_id: SessionId,
        id: String,
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
    /// Shared Artifacts (ADR 0024), most recently updated first. With `query`: at most 20 whose
    /// title or content contains it (case-insensitive), title matches first, each with a snippet.
    ListSharedArtifacts {
        #[serde(default)]
        query: Option<String>,
    },
    /// A Shared Artifact's meta, content, hash and state. Needs no Session.
    SharedArtifactRead {
        id: String,
    },
    /// Makes a Session's `render_ui` item (`item_id`) shared: its file or tree moves to `shared/`,
    /// the item then shows `source: "shared:<id>"`, and the Session is attached.
    ShareArtifact {
        session_id: SessionId,
        item_id: String,
    },
    /// Shares a copy of Markdown from a message (a Mermaid diagram or a table) as a new `md`
    /// Shared Artifact and attaches the Session.
    ShareMarkdown {
        session_id: SessionId,
        markdown: String,
        #[serde(default)]
        title: Option<String>,
        /// The block's key in the Frontend, kept in `created_by.origin`.
        #[serde(default)]
        origin: Option<String>,
    },
    AttachSharedArtifact {
        session_id: SessionId,
        id: String,
    },
    DetachSharedArtifact {
        session_id: SessionId,
        id: String,
    },
    RenameSharedArtifact {
        id: String,
        title: String,
    },
    /// Removes the Shared Artifact's folder. Items that show it then show it as missing.
    DeleteSharedArtifact {
        id: String,
    },
    /// Opens a Shared Artifact's content file in the user's editor. Needs no Session.
    OpenSharedInEditor {
        id: String,
    },
    /// Changes a Shared Artifact's state as the user. With `session_id`, that Session logs
    /// `ArtifactStateChanged`; without, nothing is logged (the no-Session view).
    PatchArtifactState {
        id: String,
        ops: Vec<StatePatchOp>,
        #[serde(default)]
        session_id: Option<SessionId>,
    },
    /// All Tasks (ADR 0028), oldest first.
    ListTasks,
    ReadTask {
        id: String,
    },
    /// A new Task, last among its siblings. With `session_id`, that Session is its origin.
    CreateTask {
        title: String,
        #[serde(default)]
        body: Option<String>,
        #[serde(default)]
        parent_id: Option<String>,
        #[serde(default)]
        session_id: Option<SessionId>,
        #[serde(default)]
        status: Option<TaskStatus>,
        #[serde(default)]
        priority: Option<TaskPriority>,
        /// `YYYY-MM-DD`.
        #[serde(default)]
        due: Option<String>,
        #[serde(default)]
        upstream: Option<TaskUpstream>,
    },
    /// Changes a Task's fields. A `patch.body` is refused (`conflict`) when the body changed after
    /// `base_updated_ms` (the `updated_ms` the editor loaded).
    UpdateTask {
        id: String,
        patch: TaskPatch,
        #[serde(default)]
        #[specta(type = Option<specta_typescript::Number>)]
        base_updated_ms: Option<i64>,
    },
    /// Puts a Task under `parent_id` (`None`: top level), before its sibling `before` (`None`: last).
    /// Refuses the Task itself or one of its descendants as the parent.
    MoveTask {
        id: String,
        #[serde(default)]
        parent_id: Option<String>,
        #[serde(default)]
        before: Option<String>,
    },
    /// Deletes a Task; its children move to its parent.
    DeleteTask {
        id: String,
    },
    /// Copies files into the Task's `files/`.
    AddTaskAssets {
        id: String,
        files: Vec<AttachmentInput>,
    },
    RemoveTaskAsset {
        id: String,
        name: String,
    },
    /// A Task asset (base64), as `ReadAttachment`.
    ReadTaskAsset {
        id: String,
        name: String,
    },
    /// How much of a Session's Main Thread a transcript keeps (the Start Session dialog shows it
    /// for the origin transcript).
    ReadTranscriptSize {
        session_id: SessionId,
    },
    /// A Session's Session Note (ADR 0028).
    ReadNote {
        session_id: SessionId,
    },
    /// Replaces the Session Note. Refused (`conflict`) when `base_hash` is set and the note's
    /// hash is no longer it (another window wrote it); without it the write always wins.
    WriteNote {
        session_id: SessionId,
        content: String,
        #[serde(default)]
        base_hash: Option<String>,
    },
    /// Copies images into the Session Note's `attachments/note/`.
    AddNoteImages {
        session_id: SessionId,
        files: Vec<AttachmentInput>,
    },
    /// Deletes one of the Session Note's images: `path` as in `Note::images`. Only files directly
    /// in `attachments/note/`.
    RemoveNoteImage {
        session_id: SessionId,
        path: String,
    },
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
