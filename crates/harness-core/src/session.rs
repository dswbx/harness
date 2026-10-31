//! A Session: its Session Directory, Session Log, and the Agent connection backing its Threads.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::api::{AgentInfo, EventKind, SessionId, SessionStatus, SessionSummary, ThreadId};
use crate::log::{now_ms, SessionLog};
use crate::permissions::Policy;

/// Harness-wide state every Session shares.
pub struct Shared {
    pub policy: Policy,
    /// How long an Agent process may sit with no Turn, no pending request and no View before it
    /// is stopped.
    pub idle_timeout: Duration,
    pub agents: crate::agents::Agents,
    pub frontends: std::sync::RwLock<Vec<crate::api::FrontendManifest>>,
    pub mcp: crate::mcp::HarnessMcp,
    pub library: crate::library::Library,
    /// How Agents without HTTP MCP start the stdio shim: command and args (the shim reads
    /// `HARNESS_MCP_URL` and `HARNESS_MCP_TOKEN`).
    pub mcp_shim: Option<(String, Vec<String>)>,
    pub app_events: AppEvents,
    /// Optional overrides of the `<harness_context>` texts (`harness.md`, `<frontend id>.md`).
    pub prompts_dir: PathBuf,
}

type AppSink = Box<dyn Fn(&crate::api::AppEvent) -> bool + Send + Sync>;

/// Fan-out of `AppEvent`s to subscribers (the app's windows).
#[derive(Default)]
pub struct AppEvents {
    subs: std::sync::Mutex<(u64, Vec<(u64, AppSink)>)>,
}

impl AppEvents {
    pub fn subscribe(&self, sink: AppSink) -> u64 {
        let mut s = self.subs.lock().unwrap();
        s.0 += 1;
        let id = s.0;
        s.1.push((id, sink));
        id
    }

    pub fn unsubscribe(&self, id: u64) {
        self.subs.lock().unwrap().1.retain(|(i, _)| *i != id);
    }

    pub fn emit(&self, event: crate::api::AppEvent) {
        self.subs.lock().unwrap().1.retain(|(_, sink)| sink(&event));
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
    /// Threads whose Agent Session could not be continued.
    #[serde(default)]
    pub read_only_threads: HashSet<ThreadId>,
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
    /// Excerpts waiting to be sent in front of a Side Thread's first prompt.
    #[serde(default)]
    pub excerpts: HashMap<ThreadId, crate::api::Excerpt>,
    /// Side Threads whose Agent may write (the Main Thread always may).
    #[serde(default)]
    pub thread_writes: HashSet<ThreadId>,
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
}

/// How a Side Thread starts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SideOrigin {
    pub point: crate::api::ForkPoint,
    pub source: crate::api::ThreadStart,
}

impl SessionMeta {
    /// Whether the Thread's Agent may edit, delete, move, run commands, commit and push.
    pub fn is_writable(&self, thread: &ThreadId) -> bool {
        *thread == self.main_thread_id || self.thread_writes.contains(thread)
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WorkspaceMeta {
    /// Repository containing the Workspace Folder, if any.
    pub repo_root: Option<PathBuf>,
    pub worktree: Option<crate::workspace::WorktreeMeta>,
    /// Base branch without a Worktree (a PR checked out in the folder); diffs and commits compare against it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
}

pub struct Session {
    dir: PathBuf,
    meta: std::sync::Mutex<SessionMeta>,
    log: SessionLog,
    agent: crate::acp::AgentSlot,
    shared: Arc<Shared>,
    /// Serializes Session State writes (`state.json` + `StateChanged`).
    state_lock: std::sync::Mutex<()>,
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
            read_only_threads: Default::default(),
            seeds: Default::default(),
            context_pending: Default::default(),
            fork_note_pending: Default::default(),
            origins: Default::default(),
            excerpts: Default::default(),
            thread_writes: Default::default(),
            workspace,
            archived: false,
            mcp_servers,
            title_backfilled: true,
        };
        write_meta(dir, &meta)?;
        let log = SessionLog::open(id, &dir.join("log.jsonl"))?;
        log.append(None, EventKind::SessionCreated {
            title,
            frontend_id,
            agent_id: agent.id.clone(),
            folder,
        })?;
        log.append(Some(meta.main_thread_id.clone()), EventKind::ThreadStarted {
            agent_id: agent.id,
            main: true,
            forked_from: None,
            excerpt: None,
        })?;
        log.sync()?;
        Ok(Self::from_parts(dir, meta, log, shared))
    }

    pub fn open(dir: &Path, shared: Arc<Shared>) -> anyhow::Result<Self> {
        let meta: SessionMeta = serde_json::from_slice(&std::fs::read(dir.join("session.json"))?)?;
        let log = SessionLog::open(meta.id.clone(), &dir.join("log.jsonl"))?;
        let session = Self::from_parts(dir, meta, log, shared);
        if !session.meta.lock().unwrap().title_backfilled {
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

    fn is_main(&self, thread: Option<&ThreadId>) -> bool {
        thread.is_none_or(|t| *t == self.meta.lock().unwrap().main_thread_id)
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
        Self { dir: dir.to_owned(), meta: std::sync::Mutex::new(meta), log, agent: Default::default(), shared, state_lock: Default::default() }
    }

    pub fn policy(&self) -> &Policy {
        &self.shared.policy
    }

    pub fn shared(&self) -> &Shared {
        &self.shared
    }

    /// The Session's Frontend.
    pub fn frontend(&self) -> Option<crate::api::FrontendManifest> {
        let id = self.meta.lock().unwrap().frontend_id.clone();
        self.shared.frontends.read().unwrap().iter().find(|f| f.id == id).cloned()
    }

    /// Frontend Tools of the Session's Frontend.
    pub fn frontend_tools(&self) -> Vec<crate::api::FrontendToolDecl> {
        let id = self.meta.lock().unwrap().frontend_id.clone();
        self.shared.frontends.read().unwrap().iter().find(|f| f.id == id).map(|f| f.frontend_tools.clone()).unwrap_or_default()
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
        std::fs::create_dir_all(path.parent().unwrap())?;
        std::fs::write(&path, serde_json::to_vec_pretty(&input)?)?;
        self.log.append(Some(thread.clone()), EventKind::FrontendToolOutput {
            tool: tool.to_owned(),
            call_id,
            path: rel.clone(),
            input,
            files,
        })?;
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
        let _guard = self.state_lock.lock().unwrap();
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
        std::fs::create_dir_all(path.parent().unwrap())?;
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
        let argv: Vec<String> =
            std::iter::once(&agent.command).chain(agent.args.iter()).chain(extra_args.iter()).map(|a| quote(a)).collect();
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
        self.meta.lock().unwrap().id.clone()
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn log(&self) -> &SessionLog {
        &self.log
    }

    pub fn meta(&self) -> SessionMeta {
        self.meta.lock().unwrap().clone()
    }

    pub fn update_meta<R>(&self, f: impl FnOnce(&mut SessionMeta) -> R) -> anyhow::Result<R> {
        let mut meta = self.meta.lock().unwrap();
        let r = f(&mut meta);
        write_meta(&self.dir, &meta)?;
        Ok(r)
    }

    pub fn summary(&self) -> SessionSummary {
        let m = self.meta.lock().unwrap();
        SessionSummary {
            id: m.id.clone(),
            title: m.title.clone(),
            frontend_id: m.frontend_id.clone(),
            agent_id: m.agent.id.clone(),
            folder: m.folder.clone(),
            created_ms: m.created_ms,
            status: self.agent.status(),
            archived: m.archived,
            workspace: crate::api::WorkspaceInfo {
                repo_root: m.workspace.repo_root.as_ref().map(|p| p.display().to_string()),
                worktree_branch: m.workspace.worktree.as_ref().map(|w| w.branch.clone()),
                base_branch: m.workspace.worktree.as_ref().map(|w| w.base.clone()),
            },
        }
    }

    fn thread(&self, thread_id: Option<ThreadId>) -> anyhow::Result<ThreadId> {
        let m = self.meta.lock().unwrap();
        match thread_id {
            None => Ok(m.main_thread_id.clone()),
            Some(t) if t == m.main_thread_id || m.side_threads.contains(&t) => Ok(t),
            Some(t) => anyhow::bail!("unknown thread {t}"),
        }
    }

    pub async fn prompt(
        self: &Arc<Self>,
        thread_id: Option<ThreadId>,
        text: String,
        attachments: Vec<crate::api::AttachmentInput>,
    ) -> anyhow::Result<()> {
        let thread = self.thread(thread_id)?;
        crate::acp::prompt(self.clone(), thread, text, attachments).await
    }

    /// A stored attachment as `(mime, base64)`.
    pub fn read_attachment(&self, path: &str) -> anyhow::Result<(String, String)> {
        crate::attachments::read(&self.dir, path)
    }

    pub async fn continue_with_summary(
        self: &Arc<Self>,
        thread_id: Option<ThreadId>,
        text: Option<String>,
    ) -> anyhow::Result<()> {
        let thread = self.thread(thread_id)?;
        crate::acp::continue_with_summary(self.clone(), thread.clone()).await?;
        if let Some(text) = text {
            crate::acp::prompt(self.clone(), thread, text, Vec::new()).await?;
        }
        Ok(())
    }

    /// Starts the Agent and the Main Thread's Agent Session in the background (see `Command::WarmUp`).
    /// Only for a Thread that never had one: resuming waits for the next prompt.
    pub fn warm_up(self: &Arc<Self>) {
        let m = self.meta();
        if m.archived || m.read_only_threads.contains(&m.main_thread_id) || m.agent_sessions.contains_key(&m.main_thread_id) {
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
    pub fn start_side_thread(
        &self,
        seed: Option<String>,
        excerpt: Option<crate::api::Excerpt>,
        source: crate::api::ThreadStart,
    ) -> anyhow::Result<(ThreadId, bool)> {
        let thread = uuid::Uuid::now_v7().to_string();
        let main = self.meta().main_thread_id;
        let point = crate::summary::last_finished_turn(&self.log.events()?, &main);
        let forked = source == crate::api::ThreadStart::Fork && self.meta().agent_sessions.contains_key(&main);
        let agent_id = self.update_meta(|m| {
            m.side_threads.push(thread.clone());
            if let Some(seed) = seed {
                m.seeds.insert(thread.clone(), seed);
            }
            if let Some(e) = &excerpt {
                m.excerpts.insert(thread.clone(), e.clone());
            }
            m.origins.insert(thread.clone(), SideOrigin { point: point.clone(), source });
            m.agent.id.clone()
        })?;
        self.log.append(Some(thread.clone()), EventKind::ThreadStarted {
            agent_id,
            main: false,
            forked_from: Some(point),
            excerpt,
        })?;
        Ok((thread, forked))
    }

    /// Lets a Side Thread's Agent write, or stops it again.
    pub fn set_thread_writable(&self, thread_id: ThreadId, writable: bool) -> anyhow::Result<()> {
        let thread = self.thread(Some(thread_id))?;
        if thread == self.meta().main_thread_id {
            return Ok(());
        }
        let changed = self.update_meta(|m| {
            if writable { m.thread_writes.insert(thread.clone()) } else { m.thread_writes.remove(&thread) }
        })?;
        if changed {
            self.log.append(Some(thread), EventKind::ThreadWritableChanged { writable })?;
        }
        Ok(())
    }

    pub async fn cancel(&self, thread_id: Option<ThreadId>) -> anyhow::Result<()> {
        let thread = self.thread(thread_id)?;
        self.agent.cancel(self, &thread).await
    }

    pub fn resolve_permission(&self, request_id: &str, option_id: Option<String>) -> anyhow::Result<()> {
        self.agent.resolve_permission(self, request_id, option_id)
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
        let m = self.meta.lock().unwrap();
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

    pub async fn git_commit(&self, message: String) -> anyhow::Result<String> {
        let commit = crate::workspace::commit(&self.folder()?, &message).await?;
        self.log.append(None, EventKind::GitCommitted { commit: commit.clone(), message })?;
        Ok(commit)
    }

    pub async fn git_push(&self) -> anyhow::Result<()> {
        let branch = crate::workspace::push(&self.folder()?).await?;
        self.log.append(None, EventKind::GitPushed { branch })?;
        Ok(())
    }

    pub async fn archive(&self) -> anyhow::Result<()> {
        anyhow::ensure!(!self.meta().archived, "already archived");
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
        anyhow::ensure!(self.meta().archived, "not archived");
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
                anyhow::ensure!(
                    !(wt.path.exists() && crate::workspace::is_dirty(&wt.path).await?),
                    "the Worktree has uncommitted changes"
                );
                let n = crate::workspace::unmerged_count(&wt.repo_root, &wt.base, &wt.branch).await?;
                anyhow::ensure!(n == 0, "branch {} has {n} commit(s) not on {}", wt.branch, wt.base);
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

    pub fn set_status(&self, status: SessionStatus) {
        let _ = self.log.append(None, EventKind::SessionStatusChanged { status });
        let (session_id, title) = {
            let m = self.meta.lock().unwrap();
            (m.id.clone(), m.title.clone())
        };
        self.shared.app_events.emit(crate::api::AppEvent::SessionStatus { session_id, title, status });
    }
}

fn write_meta(dir: &Path, meta: &SessionMeta) -> anyhow::Result<()> {
    let tmp = dir.join("session.json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(meta)?)?;
    std::fs::rename(tmp, dir.join("session.json"))?;
    Ok(())
}
