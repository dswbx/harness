//! A Session: its Session Directory, Session Log, and the Agent connection backing its Threads.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::api::{AgentInfo, EventKind, GitActor, SessionId, SessionStatus, SessionSummary, ThreadId};
use crate::log::{SessionLog, now_ms};
use crate::permissions::Policy;

/// Harness-wide state every Session shares.
pub struct Shared {
    pub policy: Policy,
    /// How long an Agent process may sit with no Turn, no pending request and no View before it
    /// is stopped.
    pub idle_timeout: Duration,
    /// The waits before each new try at restoring an Agent Session whose resume and load failed.
    pub restore_retries: Vec<Duration>,
    pub agents: crate::agents::Agents,
    pub frontends: parking_lot::RwLock<Vec<crate::api::FrontendManifest>>,
    pub mcp: crate::mcp::HarnessMcp,
    pub library: crate::library::Library,
    /// How Agents without HTTP MCP start the stdio shim: command and args (the shim reads
    /// `HARNESS_MCP_URL` and `HARNESS_MCP_TOKEN`).
    pub mcp_shim: Option<(String, Vec<String>)>,
    pub app_events: AppEvents,
    /// Optional overrides of the `<harness_context>` texts (`harness.md`, `<frontend id>.md`).
    pub prompts_dir: PathBuf,
    /// PR lookups and the Sessions' GitHub repos, shared by all Sessions.
    pub pr_refs: crate::github_refs::PrRefs,
}

type AppSink = Box<dyn Fn(&crate::api::AppEvent) -> bool + Send + Sync>;

/// Fan-out of `AppEvent`s to subscribers (the app's windows).
#[derive(Default)]
pub struct AppEvents {
    subs: parking_lot::Mutex<(u64, Vec<(u64, AppSink)>)>,
}

impl AppEvents {
    pub fn subscribe(&self, sink: AppSink) -> u64 {
        let mut s = self.subs.lock();
        s.0 += 1;
        let id = s.0;
        s.1.push((id, sink));
        id
    }

    pub fn unsubscribe(&self, id: u64) {
        self.subs.lock().1.retain(|(i, _)| *i != id);
    }

    pub fn emit(&self, event: crate::api::AppEvent) {
        self.subs.lock().1.retain(|(_, sink)| sink(&event));
    }
}

/// Persisted as `session.json` in the Session Directory.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionMeta {
    pub id: SessionId,
    pub title: String,
    pub folder: String,
    pub agent: AgentInfo,
    pub frontend_id: String,
    pub created_ms: i64,
    pub main_thread_id: ThreadId,
    #[serde(default)]
    pub side_threads: Vec<ThreadId>,
    /// Last Agent Session id per Thread, used to resume or load.
    #[serde(default)]
    pub agent_sessions: HashMap<ThreadId, String>,
    /// Context Seeds waiting to be sent with a Thread's next prompt.
    #[serde(default)]
    pub seeds: HashMap<ThreadId, String>,
    /// Threads whose next prompt starts with `<harness_context>` (a new Agent Session).
    #[serde(default)]
    pub context_pending: HashSet<ThreadId>,
    /// Forked Threads whose next prompt starts with the short Side Thread note instead (the fork
    /// already has the full `<harness_context>`).
    #[serde(default)]
    pub fork_note_pending: HashSet<ThreadId>,
    /// Side Threads: where they came from (Main Thread Turn) and how their Agent Session starts.
    #[serde(default)]
    pub origins: HashMap<ThreadId, SideOrigin>,
    #[serde(default)]
    pub workspace: WorkspaceMeta,
    #[serde(default)]
    pub archived: bool,
    /// MCP Library servers given to the Agent.
    #[serde(default)]
    pub mcp_servers: Vec<String>,
    /// The title was taken from the log's `SessionInfoUpdated` events once (Sessions from before titles were kept here).
    #[serde(default)]
    pub title_backfilled: bool,
    /// A Quick Session: the Harness made `folder` for it and deletes it with the Session.
    #[serde(default)]
    pub quick: bool,
    /// Quick Session with no prompt yet on any Thread. It can be discarded (`is_discardable`).
    #[serde(default)]
    pub awaiting_first_prompt: bool,
    /// The title is a placeholder: the first Main Thread prompt replaces it.
    #[serde(default)]
    pub title_from_prompt: bool,
}

/// Title of a Quick Session until its first prompt.
pub const QUICK_TITLE: &str = "New Quick Session";

/// A title from the first line of a prompt: up to 40 characters.
fn title_from_text(text: &str) -> Option<String> {
    const MAX: usize = 40;
    let line = text.lines().map(str::trim).find(|l| !l.is_empty())?;
    let mut title: String = line.chars().take(MAX).collect();
    if line.chars().count() > MAX {
        title = format!("{}…", title.trim_end());
    }
    Some(title)
}

/// How a Side Thread starts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SideOrigin {
    pub point: crate::api::ForkPoint,
    pub source: crate::api::ThreadStart,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WorkspaceMeta {
    /// Repository containing the Workspace Folder, if any.
    pub repo_root: Option<PathBuf>,
    pub worktree: Option<crate::workspace::WorktreeMeta>,
    /// Base branch without a Worktree (a PR checked out in the folder); diffs and commits compare against it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
    /// PR number when the Session was started from a PR.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr: Option<u32>,
    /// The last PR found for the branch the Session works on, when it was not started from a PR.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_pr: Option<BranchPrMeta>,
}

/// A PR found by head branch; only shown while that branch is checked out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BranchPrMeta {
    pub branch: String,
    pub number: u32,
}

/// The PR a Session shows: the one it started from, else the stored one of the branch checked out.
fn shown_pr(pr: Option<u32>, branch_pr: Option<&BranchPrMeta>, head: Option<&str>) -> Option<u32> {
    pr.or_else(|| branch_pr.filter(|b| head == Some(b.branch.as_str())).map(|b| b.number))
}

impl SessionMeta {
    /// The repository a Session works in: a Worktree's main repo (it outlives the Worktree), else the folder's.
    pub fn repo_folder(&self) -> Option<PathBuf> {
        self.workspace.worktree.as_ref().map(|w| w.repo_root.clone()).or_else(|| self.workspace.repo_root.clone())
    }
}

/// Owned handle on what finding a Session's branch PR needs, so a spawned task can use it.
#[derive(Clone)]
pub struct PrWatch {
    dir: PathBuf,
    meta: Arc<parking_lot::Mutex<SessionMeta>>,
    shared: Arc<Shared>,
}

impl PrWatch {
    /// Stores the PR of a branch; tells the windows when it changed.
    fn set(&self, branch_pr: Option<BranchPrMeta>) {
        {
            let mut m = self.meta.lock();
            if m.workspace.branch_pr == branch_pr {
                return;
            }
            m.workspace.branch_pr = branch_pr;
            let _ = write_meta(&self.dir, &m);
        }
        self.shared.app_events.emit(crate::api::AppEvent::SessionsChanged);
    }

    /// Looks up the PR of `branch` and stores it. An error leaves the stored PR alone.
    pub async fn lookup(&self, repo: &crate::api::RepoId, branch: &str) -> anyhow::Result<Option<crate::api::PrInfo>> {
        let pr = self.shared.pr_refs.for_branch(repo, branch).await?;
        self.set(pr.as_ref().map(|p| BranchPrMeta { branch: branch.to_owned(), number: p.number }));
        Ok(pr)
    }

    /// For a Session that may have opened a PR: looks up the PR of its branch, ignoring errors.
    async fn find(&self) {
        let m = self.meta.lock().clone();
        let Some(folder) = m.repo_folder().filter(|_| m.workspace.pr.is_none()) else { return };
        let Some(branch) = crate::workspace::head_branch(Path::new(&m.folder)) else { return };
        let base = m.workspace.worktree.as_ref().map(|w| &w.base).or(m.workspace.base.as_ref());
        if base == Some(&branch) {
            return;
        }
        if let Some(repo) = self.shared.pr_refs.repo_of(&folder).await {
            let _ = self.lookup(&repo, &branch).await;
        }
    }
}

/// Most errors kept per Frontend Tool item, and the longest message (bytes).
pub const MAX_FRONTEND_ERRORS: usize = 5;
pub const MAX_FRONTEND_ERROR_LEN: usize = 300;

/// A `FrontendError` not cleared yet.
/// Frontend Tool items by `(tool, item id)`, with the Thread of their latest call.
type FrontendItems = HashMap<(String, String), ThreadId>;

#[derive(Debug, Clone)]
pub struct FrontendErrorEntry {
    pub seq: u64,
    pub thread: ThreadId,
    pub tool: String,
    pub item: String,
    pub message: String,
}

/// How long a Frontend Tool that `replies` waits for a window.
const FRONTEND_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

/// Frontend requests waiting for their answer: request id -> who waits.
#[derive(Default)]
struct FrontendRequests(parking_lot::Mutex<HashMap<String, tokio::sync::oneshot::Sender<crate::api::FrontendAnswer>>>);

/// Removes a request from `FrontendRequests` when the wait ends in any way, also when the future is dropped.
struct PendingFrontendRequest<'a>(&'a FrontendRequests, String);

impl Drop for PendingFrontendRequest<'_> {
    fn drop(&mut self) {
        self.0.0.lock().remove(&self.1);
    }
}

impl FrontendRequests {
    /// Adds a request, calls `emit` with its id, and waits for the answer.
    async fn wait(&self, timeout: Duration, emit: impl FnOnce(String)) -> anyhow::Result<crate::api::FrontendAnswer> {
        let request_id = uuid::Uuid::now_v7().to_string();
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.0.lock().insert(request_id.clone(), tx);
        let _pending = PendingFrontendRequest(self, request_id.clone());
        emit(request_id);
        match tokio::time::timeout(timeout, rx).await {
            Ok(answer) => Ok(answer?),
            Err(_) => anyhow::bail!("No app window answered in time. The window may be closed or the Mac asleep."),
        }
    }

    /// The first answer wins; later ones and unknown ids do nothing.
    fn answer(&self, request_id: &str, answer: crate::api::FrontendAnswer) {
        if let Some(tx) = self.0.lock().remove(request_id) {
            let _ = tx.send(answer);
        }
    }
}

pub struct Session {
    dir: PathBuf,
    meta: Arc<parking_lot::Mutex<SessionMeta>>,
    log: SessionLog,
    agent: crate::acp::AgentSlot,
    shared: Arc<Shared>,
    /// Serializes Session State writes (`state.json` + `StateChanged`).
    state_lock: parking_lot::Mutex<()>,
    frontend_requests: FrontendRequests,
}

impl Session {
    #[allow(clippy::too_many_arguments)]
    pub fn create(
        dir: &Path,
        id: SessionId,
        title: String,
        folder: String,
        agent: AgentInfo,
        frontend_id: String,
        workspace: WorkspaceMeta,
        mcp_servers: Vec<String>,
        shared: Arc<Shared>,
    ) -> anyhow::Result<Self> {
        std::fs::create_dir_all(dir.join("frontend"))?;
        let meta = SessionMeta {
            id: id.clone(),
            title: title.clone(),
            folder: folder.clone(),
            agent: agent.clone(),
            frontend_id: frontend_id.clone(),
            created_ms: now_ms(),
            main_thread_id: uuid::Uuid::now_v7().to_string(),
            side_threads: Vec::new(),
            agent_sessions: Default::default(),
            seeds: Default::default(),
            context_pending: Default::default(),
            fork_note_pending: Default::default(),
            origins: Default::default(),
            workspace,
            archived: false,
            mcp_servers,
            title_backfilled: true,
            quick: false,
            awaiting_first_prompt: false,
            title_from_prompt: false,
        };
        write_meta(dir, &meta)?;
        let log = SessionLog::open(id, &dir.join("log.jsonl"))?;
        log.append(None, EventKind::SessionCreated { title, frontend_id, agent_id: agent.id.clone(), folder })?;
        log.append(Some(meta.main_thread_id.clone()), EventKind::ThreadStarted { agent_id: agent.id, main: true, forked_from: None })?;
        log.sync()?;
        Ok(Self::from_parts(dir, meta, log, shared))
    }

    pub fn open(dir: &Path, shared: Arc<Shared>) -> anyhow::Result<Self> {
        let meta: SessionMeta = serde_json::from_slice(&std::fs::read(dir.join("session.json"))?)?;
        let log = SessionLog::open(meta.id.clone(), &dir.join("log.jsonl"))?;
        log.note_agent_gone()?;
        let session = Self::from_parts(dir, meta, log, shared);
        if !session.meta.lock().title_backfilled {
            let title = session.log.events()?.into_iter().rev().find_map(|e| match e.kind {
                EventKind::SessionInfoUpdated { title } if session.is_main(e.thread_id.as_ref()) => title.filter(|t| !t.trim().is_empty()),
                _ => None,
            });
            session.update_meta(|m| {
                if let Some(t) = title {
                    m.title = t;
                }
                m.title_backfilled = true;
            })?;
        }
        Ok(session)
    }

    pub(crate) fn is_main(&self, thread: Option<&ThreadId>) -> bool {
        thread.is_none_or(|t| *t == self.meta.lock().main_thread_id)
    }

    /// Keeps the Agent's title for the Session (`session_info_update` on the main Thread).
    pub fn set_agent_title(&self, thread: Option<&ThreadId>, title: &str) {
        let title = title.trim();
        if title.is_empty() || !self.is_main(thread) {
            return;
        }
        let changed = self.update_meta(|m| std::mem::replace(&mut m.title, title.to_owned()) != title).unwrap_or(false);
        if changed {
            let session_id = self.id();
            self.shared.app_events.emit(crate::api::AppEvent::SessionStatus { session_id, title: title.to_owned(), status: self.agent.status() });
        }
    }

    fn from_parts(dir: &Path, meta: SessionMeta, log: SessionLog, shared: Arc<Shared>) -> Self {
        Self {
            dir: dir.to_owned(),
            meta: Arc::new(parking_lot::Mutex::new(meta)),
            log,
            agent: Default::default(),
            shared,
            state_lock: Default::default(),
            frontend_requests: Default::default(),
        }
    }

    pub fn policy(&self) -> &Policy {
        &self.shared.policy
    }

    pub fn shared(&self) -> &Shared {
        &self.shared
    }

    /// The Session's Frontend.
    pub fn frontend(&self) -> Option<crate::api::FrontendManifest> {
        let id = self.meta.lock().frontend_id.clone();
        self.shared.frontends.read().iter().find(|f| f.id == id).cloned()
    }

    /// Frontend Tools of the Session's Frontend.
    pub fn frontend_tools(&self) -> Vec<crate::api::FrontendToolDecl> {
        let id = self.meta.lock().frontend_id.clone();
        self.shared.frontends.read().iter().find(|f| f.id == id).map(|f| f.frontend_tools.clone()).unwrap_or_default()
    }

    /// Asks the Session's windows to answer a Frontend Tool call (`FrontendToolDecl::replies`).
    pub async fn request_frontend(&self, tool: &str, input: serde_json::Value) -> anyhow::Result<crate::api::FrontendAnswer> {
        let last_seq = self.log.last_seq()?;
        self.frontend_requests
            .wait(FRONTEND_REQUEST_TIMEOUT, |request_id| {
                self.shared.app_events.emit(crate::api::AppEvent::FrontendRequest {
                    session_id: self.id(),
                    request_id,
                    tool: tool.to_owned(),
                    input,
                    last_seq,
                });
            })
            .await
    }

    pub fn answer_frontend_request(&self, request_id: &str, answer: crate::api::FrontendAnswer) {
        self.frontend_requests.answer(request_id, answer);
    }

    /// Stores a validated Frontend Tool call under `frontend/tools/<tool>/<call id>.json` and
    /// logs it. Returns the path relative to `frontend/`.
    pub fn write_frontend_tool_output(
        &self,
        thread: &ThreadId,
        tool: &str,
        input: serde_json::Value,
        files: std::collections::BTreeMap<String, String>,
    ) -> anyhow::Result<String> {
        let call_id = uuid::Uuid::now_v7().to_string();
        let rel = format!("tools/{tool}/{call_id}.json");
        let path = self.dir.join("frontend").join(&rel);
        std::fs::create_dir_all(crate::env::parent_of(&path)?)?;
        std::fs::write(&path, serde_json::to_vec_pretty(&input)?)?;
        self.log.append(Some(thread.clone()), EventKind::FrontendToolOutput { tool: tool.to_owned(), call_id, path: rel.clone(), input, files })?;
        Ok(rel)
    }

    /// A path inside `frontend/`; refuses absolute paths and `..`.
    fn frontend_path(&self, rel: &str) -> anyhow::Result<PathBuf> {
        let p = Path::new(rel);
        anyhow::ensure!(
            p.components().all(|c| matches!(c, std::path::Component::Normal(_) | std::path::Component::CurDir)),
            "{rel} is outside the Frontend's directory"
        );
        Ok(self.dir.join("frontend").join(p))
    }

    pub fn frontend_read(&self, rel: &str) -> anyhow::Result<String> {
        Ok(std::fs::read_to_string(self.frontend_path(rel)?)?)
    }

    /// The Session State (ADR 0015); `{}` before the first change.
    pub fn state(&self) -> anyhow::Result<serde_json::Value> {
        match std::fs::read(self.dir.join("state.json")) {
            Ok(b) => Ok(serde_json::from_slice(&b)?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::json!({})),
            Err(e) => Err(e.into()),
        }
    }

    /// Applies `ops` to the Session State (all or nothing), stores it and logs `StateChanged`.
    pub fn patch_state(&self, thread: Option<ThreadId>, ops: Vec<crate::api::StatePatchOp>, by: crate::api::StateWriter) -> anyhow::Result<serde_json::Value> {
        anyhow::ensure!(!ops.is_empty(), "no operations");
        let _guard = self.state_lock.lock();
        let next = crate::state::apply(&self.state()?, &ops)?;
        let tmp = self.dir.join("state.json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(&next)?)?;
        std::fs::rename(tmp, self.dir.join("state.json"))?;
        self.log.append(thread, EventKind::StateChanged { ops, by })?;
        Ok(next)
    }

    /// Frontend Tool calls that named an `id` and were not removed since (`remove: true`), in the
    /// order first seen: the live items a Frontend shows (e.g. `render_ui` slots), latest input each.
    pub fn frontend_items(&self) -> anyhow::Result<Vec<(String, String, serde_json::Value)>> {
        let mut items: Vec<(String, String, serde_json::Value)> = Vec::new();
        for e in self.log.events()? {
            let EventKind::FrontendToolOutput { tool, input, .. } = e.kind else { continue };
            let Some(id) = input.get("id").and_then(|v| v.as_str()).map(str::to_owned) else { continue };
            let at = items.iter().position(|(t, i, _)| *t == tool && *i == id);
            match (input.get("remove") == Some(&serde_json::Value::Bool(true)), at) {
                (true, Some(i)) => {
                    items.remove(i);
                }
                (true, None) => {}
                (false, Some(i)) => items[i].2 = input,
                (false, None) => items.push((tool, id, input)),
            }
        }
        Ok(items)
    }

    /// Errors the UI reported for Frontend Tool items (`FrontendError`) and not cleared since: a
    /// new call with the item's id, or its removal, clears them. Also the items errors can be
    /// reported for, with the Thread of their latest call.
    fn frontend_error_scan(&self) -> anyhow::Result<(FrontendItems, Vec<FrontendErrorEntry>)> {
        let mut items: FrontendItems = HashMap::new();
        let mut errors: Vec<FrontendErrorEntry> = Vec::new();
        for e in self.log.events()? {
            match e.kind {
                EventKind::FrontendToolOutput { tool, call_id, input, .. } => {
                    let Some(thread) = e.thread_id else { continue };
                    match input.get("id").and_then(|v| v.as_str()) {
                        Some(id) => {
                            errors.retain(|x| !(x.tool == tool && x.item == id));
                            let key = (tool, id.to_owned());
                            if input.get("remove") == Some(&serde_json::Value::Bool(true)) {
                                items.remove(&key);
                            } else {
                                items.insert(key, thread);
                            }
                        }
                        None => {
                            items.insert((tool, call_id), thread);
                        }
                    }
                }
                EventKind::FrontendError { tool, item, message } => {
                    errors.push(FrontendErrorEntry { seq: e.seq, thread: e.thread_id.unwrap_or_default(), tool, item, message })
                }
                _ => {}
            }
        }
        errors.retain(|x| items.contains_key(&(x.tool.clone(), x.item.clone())));
        Ok((items, errors))
    }

    /// Current errors of Frontend Tool items, oldest first (see `frontend_error_scan`).
    pub fn frontend_errors(&self) -> anyhow::Result<Vec<FrontendErrorEntry>> {
        Ok(self.frontend_error_scan()?.1)
    }

    /// Logs `FrontendError` for a live item (its `id`, or the call id of a call without one), on
    /// the Thread that made it. Ignores items that are gone, repeats of a current error, and more
    /// than `MAX_FRONTEND_ERRORS` per item; cuts long messages.
    pub fn report_frontend_error(&self, tool: &str, item: &str, message: &str) -> anyhow::Result<()> {
        let mut message = message.trim().to_owned();
        anyhow::ensure!(!message.is_empty(), "message is required");
        if message.len() > MAX_FRONTEND_ERROR_LEN {
            message.truncate(message.floor_char_boundary(MAX_FRONTEND_ERROR_LEN));
            message.push('…');
        }
        let (items, errors) = self.frontend_error_scan()?;
        let Some(thread) = items.get(&(tool.to_owned(), item.to_owned())) else { return Ok(()) };
        let current: Vec<_> = errors.iter().filter(|x| x.tool == tool && x.item == item).collect();
        if current.len() >= MAX_FRONTEND_ERRORS || current.iter().any(|x| x.message == message) {
            return Ok(());
        }
        self.log.append(Some(thread.clone()), EventKind::FrontendError { tool: tool.to_owned(), item: item.to_owned(), message })?;
        Ok(())
    }

    pub fn frontend_dir(&self) -> PathBuf {
        self.dir.join("frontend")
    }

    pub fn frontend_read_image(&self, rel: &str) -> anyhow::Result<(String, String)> {
        use base64::Engine;
        let p = self.frontend_path(rel)?;
        let mime = crate::attachments::guess_mime(&p);
        anyhow::ensure!(crate::attachments::is_image(mime), "{rel} is not an image");
        Ok((mime.to_owned(), base64::engine::general_purpose::STANDARD.encode(std::fs::read(&p)?)))
    }

    pub fn frontend_write(&self, rel: &str, content: &str) -> anyhow::Result<()> {
        let path = self.frontend_path(rel)?;
        anyhow::ensure!(!rel.trim().is_empty(), "path is required");
        std::fs::create_dir_all(crate::env::parent_of(&path)?)?;
        let tmp = path.with_extension("tmp-write");
        std::fs::write(&tmp, content)?;
        std::fs::rename(tmp, path)?;
        Ok(())
    }

    pub fn frontend_list(&self, rel: &str) -> anyhow::Result<Vec<String>> {
        let root = self.dir.join("frontend");
        let start = self.frontend_path(rel)?;
        let mut out = Vec::new();
        let mut stack = vec![start];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else { continue };
            for e in entries.flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                } else if let Ok(r) = p.strip_prefix(&root) {
                    out.push(r.display().to_string());
                }
            }
        }
        out.sort();
        Ok(out)
    }

    pub fn agents(&self) -> &crate::agents::Agents {
        &self.shared.agents
    }

    pub async fn authenticate(&self, method_id: String) -> anyhow::Result<()> {
        self.agent.authenticate(self, method_id).await
    }

    /// Writes a `.command` script that runs the Agent's terminal auth and opens it in Terminal.
    pub async fn open_auth_terminal(&self, method_id: &str) -> anyhow::Result<()> {
        let (agent, extra_args, extra_env) = self.agent.terminal_auth(self, method_id)?;
        let quote = |s: &str| format!("'{}'", s.replace('\'', r"'\''"));
        let mut script = String::from("#!/bin/sh\n");
        script.push_str(&format!("export PATH={}\n", quote(&self.shared.agents.toolchain.path())));
        for (k, v) in agent.env.iter().chain(extra_env.iter()) {
            script.push_str(&format!("export {k}={}\n", quote(v)));
        }
        script.push_str(&format!("cd {}\n", quote(&self.meta().folder)));
        let argv: Vec<String> = std::iter::once(&agent.command).chain(agent.args.iter()).chain(extra_args.iter()).map(|a| quote(a)).collect();
        script.push_str(&format!("exec {}\n", argv.join(" ")));
        let path = std::env::temp_dir().join(format!("harness-auth-{}.command", uuid::Uuid::now_v7()));
        std::fs::write(&path, script)?;
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))?;
        let status = tokio::process::Command::new("open").args(["-a", "Terminal"]).arg(&path).status().await?;
        anyhow::ensure!(status.success(), "could not open Terminal");
        Ok(())
    }

    pub fn idle_timeout(&self) -> Duration {
        self.shared.idle_timeout
    }

    pub fn id(&self) -> SessionId {
        self.meta.lock().id.clone()
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn log(&self) -> &SessionLog {
        &self.log
    }

    pub fn meta(&self) -> SessionMeta {
        self.meta.lock().clone()
    }

    pub fn update_meta<R>(&self, f: impl FnOnce(&mut SessionMeta) -> R) -> anyhow::Result<R> {
        let mut meta = self.meta.lock();
        let r = f(&mut meta);
        write_meta(&self.dir, &meta)?;
        Ok(r)
    }

    /// A folder can become a repository after the Session started (`git init`, by the Agent or
    /// in the terminal), so a Session with no repository looks again each time it is asked.
    fn adopt_repo(&self) {
        let folder = {
            let m = self.meta.lock();
            if m.workspace.repo_root.is_some() {
                return;
            }
            PathBuf::from(&m.folder)
        };
        if let Some(root) = crate::workspace::find_repo_root(&folder) {
            let _ = self.update_meta(|m| m.workspace.repo_root = Some(root));
        }
    }

    pub fn summary(&self) -> SessionSummary {
        self.adopt_repo();
        let m = self.meta.lock();
        let branch = crate::workspace::head_branch(Path::new(&m.folder));
        SessionSummary {
            id: m.id.clone(),
            title: m.title.clone(),
            frontend_id: m.frontend_id.clone(),
            agent_id: m.agent.id.clone(),
            folder: m.folder.clone(),
            created_ms: m.created_ms,
            updated_ms: self.log.last_ts_ms().unwrap_or(m.created_ms),
            status: self.agent.status(),
            archived: m.archived,
            quick: m.quick,
            workspace: crate::api::WorkspaceInfo {
                repo_root: m.workspace.repo_root.as_ref().map(|p| p.display().to_string()),
                worktree_branch: m.workspace.worktree.as_ref().map(|w| w.branch.clone()),
                base_branch: m.workspace.worktree.as_ref().map(|w| w.base.clone()),
                pr: shown_pr(m.workspace.pr, m.workspace.branch_pr.as_ref(), branch.as_deref()),
                branch,
            },
        }
    }

    fn thread(&self, thread_id: Option<ThreadId>) -> anyhow::Result<ThreadId> {
        let m = self.meta.lock();
        match thread_id {
            None => Ok(m.main_thread_id.clone()),
            Some(t) if t == m.main_thread_id || m.side_threads.contains(&t) => Ok(t),
            Some(t) => Err(crate::error::not_found(format!("unknown thread {t}"))),
        }
    }

    pub async fn prompt(self: &Arc<Self>, thread_id: Option<ThreadId>, text: String, attachments: Vec<crate::api::AttachmentInput>) -> anyhow::Result<()> {
        let thread = self.thread(thread_id)?;
        self.note_first_prompt(&thread, &text)?;
        self.adopt_repo();
        crate::acp::prompt(self.clone(), thread, text, attachments).await
    }

    /// A Quick Session is used from its first prompt on, and takes its title from the first one
    /// on the Main Thread. The Agent's own title replaces that later (`set_agent_title`).
    fn note_first_prompt(&self, thread: &ThreadId, text: &str) -> anyhow::Result<()> {
        let is_main = self.is_main(Some(thread));
        let m = self.meta();
        if !m.awaiting_first_prompt && !(m.title_from_prompt && is_main) {
            return Ok(());
        }
        let title = if is_main && m.title_from_prompt { title_from_text(text) } else { None };
        self.update_meta(|m| {
            m.awaiting_first_prompt = false;
            if is_main && title.is_some() {
                m.title_from_prompt = false;
            }
            if let Some(t) = &title {
                m.title = t.clone();
            }
        })?;
        if let Some(title) = title {
            let session_id = self.id();
            self.shared.app_events.emit(crate::api::AppEvent::SessionStatus { session_id, title, status: self.agent.status() });
        }
        Ok(())
    }

    /// A Quick Session nobody used: no prompt, nothing in its folder, not archived.
    pub fn is_discardable(&self) -> bool {
        let m = self.meta();
        m.quick && m.awaiting_first_prompt && !m.archived && std::fs::read_dir(&m.folder).map(|mut d| d.next().is_none()).unwrap_or(true)
    }

    /// Removes the Session Directory and, for a Quick Session, the folder the Harness made.
    /// The folder's name must be the Session id, so bad metadata can never delete another folder.
    pub fn remove_files(&self) -> anyhow::Result<()> {
        let m = self.meta();
        std::fs::remove_dir_all(&self.dir)?;
        let folder = Path::new(&m.folder);
        if m.quick && folder.file_name().is_some_and(|n| n == m.id.as_str()) && folder.exists() {
            std::fs::remove_dir_all(folder)?;
        }
        Ok(())
    }

    /// A stored attachment as `(mime, base64)`.
    pub fn read_attachment(&self, path: &str) -> anyhow::Result<(String, String)> {
        crate::attachments::read(&self.dir, path)
    }

    pub async fn continue_with_summary(
        self: &Arc<Self>,
        thread_id: Option<ThreadId>,
        text: Option<String>,
        attachments: Vec<crate::api::AttachmentInput>,
    ) -> anyhow::Result<()> {
        let thread = self.thread(thread_id)?;
        crate::acp::continue_with_summary(self.clone(), thread.clone()).await?;
        if let Some(text) = text {
            crate::acp::prompt(self.clone(), thread, text, attachments).await?;
        }
        Ok(())
    }

    /// Starts the Agent and the Main Thread's Agent Session in the background (see `Command::WarmUp`).
    /// Only for a Thread that never had one: resuming waits for the next prompt.
    pub fn warm_up(self: &Arc<Self>) {
        let m = self.meta();
        if m.archived || m.agent_sessions.contains_key(&m.main_thread_id) {
            return;
        }
        let session = self.clone();
        tokio::spawn(async move {
            if let Err(e) = crate::acp::warm_up(session, m.main_thread_id).await {
                tracing::debug!("warm-up: {e:#}");
            }
        });
    }

    /// Opens a Side Thread; its Agent Session starts with the first prompt. Returns the Thread and
    /// whether that will be a fork of the Main Thread's Agent Session.
    pub fn start_side_thread(&self, seed: Option<String>, source: crate::api::ThreadStart) -> anyhow::Result<(ThreadId, bool)> {
        let thread = uuid::Uuid::now_v7().to_string();
        let main = self.meta().main_thread_id;
        let point = crate::summary::last_finished_turn(&self.log.events()?, &main);
        let forked = source == crate::api::ThreadStart::Fork && self.meta().agent_sessions.contains_key(&main);
        let agent_id = self.update_meta(|m| {
            m.side_threads.push(thread.clone());
            if let Some(seed) = seed {
                m.seeds.insert(thread.clone(), seed);
            }
            m.origins.insert(thread.clone(), SideOrigin { point: point.clone(), source });
            m.agent.id.clone()
        })?;
        self.log.append(Some(thread.clone()), EventKind::ThreadStarted { agent_id, main: false, forked_from: Some(point) })?;
        Ok((thread, forked))
    }

    pub async fn cancel(&self, thread_id: Option<ThreadId>) -> anyhow::Result<()> {
        let thread = self.thread(thread_id)?;
        self.agent.cancel(self, &thread).await
    }

    pub fn resolve_permission(&self, request_id: &str, option_id: Option<String>, global: bool) -> anyhow::Result<()> {
        self.agent.resolve_permission(self, request_id, option_id, global)
    }

    pub async fn set_config_option(self: &Arc<Self>, thread_id: Option<ThreadId>, config_id: String, value: String) -> anyhow::Result<()> {
        let thread = self.thread(thread_id)?;
        crate::acp::set_config_option(self.clone(), thread, config_id, value).await
    }

    pub async fn set_mode(self: &Arc<Self>, thread_id: Option<ThreadId>, mode_id: String) -> anyhow::Result<()> {
        let thread = self.thread(thread_id)?;
        crate::acp::set_mode(self.clone(), thread, mode_id).await
    }

    /// The branch diffs and commits compare against: the Worktree's base, else a PR's.
    fn base(&self) -> Option<String> {
        let w = self.meta().workspace;
        w.worktree.map(|w| w.base).or(w.base)
    }

    fn folder(&self) -> anyhow::Result<PathBuf> {
        self.adopt_repo();
        let m = self.meta.lock();
        anyhow::ensure!(m.workspace.repo_root.is_some(), "the Workspace is not a git repository");
        Ok(PathBuf::from(&m.folder))
    }

    pub async fn git_status(&self) -> anyhow::Result<crate::api::GitStatus> {
        crate::workspace::status(&self.folder()?).await
    }

    pub async fn git_diff(&self, from: Option<String>, to: Option<String>) -> anyhow::Result<crate::api::Diff> {
        let folder = self.folder()?;
        let base = self.base();
        let from = match from {
            Some(f) => f,
            None => crate::workspace::diff_base(&folder, base.as_deref()).await?,
        };
        let to = match to {
            Some(t) => t,
            None => crate::workspace::snapshot(&folder).await?,
        };
        crate::workspace::diff(&folder, &from, &to).await
    }

    pub async fn git_log(&self) -> anyhow::Result<Vec<crate::api::Commit>> {
        let folder = self.folder()?;
        let base = self.base();
        let base = crate::workspace::diff_base(&folder, base.as_deref()).await?;
        crate::workspace::log(&folder, &base).await
    }

    pub async fn git_show_file(&self, rev: &str, path: &str) -> anyhow::Result<String> {
        crate::workspace::show_file(&self.folder()?, rev, path).await
    }

    pub async fn git_commit(&self, message: String, by: GitActor) -> anyhow::Result<String> {
        let commit = crate::workspace::commit(&self.folder()?, &message).await?;
        self.log.append(None, EventKind::GitCommitted { commit: commit.clone(), message, by })?;
        Ok(commit)
    }

    pub async fn git_push(&self, by: GitActor) -> anyhow::Result<String> {
        let branch = crate::workspace::push(&self.folder()?).await?;
        self.log.append(None, EventKind::GitPushed { branch: branch.clone(), by })?;
        Ok(branch)
    }

    pub async fn archive(&self) -> anyhow::Result<()> {
        if self.meta().archived {
            return Err(crate::error::conflict("already archived"));
        }
        self.agent.shutdown("archived");
        if let Some(wt) = self.meta().workspace.worktree {
            if wt.path.exists() && crate::workspace::is_dirty(&wt.path).await? {
                crate::workspace::wip_commit(&wt.path).await?;
            }
            crate::workspace::remove_worktree(&wt).await?;
        }
        self.update_meta(|m| m.archived = true)?;
        self.shared.app_events.emit(crate::api::AppEvent::SessionsChanged);
        self.log.append(None, EventKind::SessionArchived { archived: true })?;
        self.log.sync()
    }

    pub async fn unarchive(&self) -> anyhow::Result<()> {
        if !self.meta().archived {
            return Err(crate::error::conflict("not archived"));
        }
        if let Some(wt) = self.meta().workspace.worktree {
            crate::workspace::restore_worktree(&wt).await?;
        }
        self.update_meta(|m| m.archived = false)?;
        self.shared.app_events.emit(crate::api::AppEvent::SessionsChanged);
        self.log.append(None, EventKind::SessionArchived { archived: false })?;
        self.log.sync()
    }

    /// Removes the Worktree and its branch; the caller removes the Session Directory.
    pub async fn delete_workspace(&self, force: bool) -> anyhow::Result<()> {
        if let Some(wt) = self.meta().workspace.worktree {
            if !force {
                if wt.path.exists() && crate::workspace::is_dirty(&wt.path).await? {
                    return Err(crate::error::conflict("the Worktree has uncommitted changes"));
                }
                let n = crate::workspace::unmerged_count(&wt.repo_root, &wt.base, &wt.branch).await?;
                if n != 0 {
                    return Err(crate::error::conflict(format!("branch {} has {n} commit(s) not on {}", wt.branch, wt.base)));
                }
            }
            self.agent.shutdown("deleted");
            crate::workspace::remove_worktree(&wt).await?;
            crate::workspace::delete_branch(&wt.repo_root, &wt.branch).await?;
            if let Some(parent) = wt.path.parent() {
                let _ = std::fs::remove_dir(parent);
            }
        } else {
            self.agent.shutdown("deleted");
        }
        Ok(())
    }

    pub(crate) fn agent_slot(&self) -> &crate::acp::AgentSlot {
        &self.agent
    }

    pub fn pr_watch(&self) -> PrWatch {
        PrWatch { dir: self.dir.clone(), meta: self.meta.clone(), shared: self.shared.clone() }
    }

    pub fn set_status(&self, status: SessionStatus) {
        let _ = self.log.append(None, EventKind::SessionStatusChanged { status });
        let (session_id, title) = {
            let m = self.meta.lock();
            (m.id.clone(), m.title.clone())
        };
        self.shared.app_events.emit(crate::api::AppEvent::SessionStatus { session_id, title, status });
        // The Agent may have opened a PR; look in the background (not without a runtime, e.g. sync tests).
        if status == SessionStatus::Idle
            && let Ok(rt) = tokio::runtime::Handle::try_current()
        {
            let watch = self.pr_watch();
            drop(rt.spawn(async move { watch.find().await }));
        }
    }
}

fn write_meta(dir: &Path, meta: &SessionMeta) -> anyhow::Result<()> {
    let tmp = dir.join("session.json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(meta)?)?;
    std::fs::rename(tmp, dir.join("session.json"))?;
    Ok(())
}

#[cfg(test)]
mod frontend_request_tests {
    use super::*;

    #[tokio::test]
    async fn a_timeout_or_a_dropped_wait_removes_the_request() {
        let requests = FrontendRequests::default();
        let err = requests.wait(Duration::from_millis(1), |_| {}).await.unwrap_err();
        assert_eq!(err.to_string(), "No app window answered in time. The window may be closed or the Mac asleep.");
        assert!(requests.0.lock().is_empty());

        let wait = requests.wait(Duration::from_secs(60), |_| {});
        assert!(tokio::time::timeout(Duration::from_millis(1), wait).await.is_err());
        assert!(requests.0.lock().is_empty());
    }
}

#[cfg(test)]
mod branch_pr_tests {
    use super::*;

    fn stored() -> BranchPrMeta {
        BranchPrMeta { branch: "feat".into(), number: 7 }
    }

    #[test]
    fn a_stored_pr_shows_only_while_its_branch_is_checked_out() {
        assert_eq!(shown_pr(None, Some(&stored()), Some("feat")), Some(7));
        assert_eq!(shown_pr(None, Some(&stored()), Some("main")), None);
        assert_eq!(shown_pr(None, Some(&stored()), None), None);
        assert_eq!(shown_pr(Some(3), Some(&stored()), Some("feat")), Some(3));
        assert_eq!(shown_pr(None, None, Some("feat")), None);
    }

    #[test]
    fn old_workspace_meta_without_branch_pr_loads() {
        let m: WorkspaceMeta = serde_json::from_str(r#"{"repo_root":null,"worktree":null,"pr":4}"#).unwrap();
        assert_eq!(m.pr, Some(4));
        assert_eq!(m.branch_pr, None);
        assert!(!serde_json::to_string(&m).unwrap().contains("branch_pr"));
    }
}
