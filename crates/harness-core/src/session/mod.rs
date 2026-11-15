//! A Session: its Session Directory, Session Log, and the Agent connection backing its Threads.

mod artifacts;
mod frontend;
mod meta;
mod shared;
mod workspace;

#[cfg(test)]
mod dangling_tests;
#[cfg(test)]
pub(crate) mod projection_tests;
#[cfg(test)]
mod scaling_tests;

pub use crate::app_events::AppEvents;
pub use frontend::{FrontendErrorEntry, FrontendItem, MAX_FRONTEND_ERROR_LEN, MAX_FRONTEND_ERRORS, RENDER_UI};
pub(crate) use meta::title_from_text;
pub use meta::{BranchPrMeta, PrStatusMeta, QUICK_TITLE, SessionMeta, SideOrigin, WorkspaceMeta};
pub use shared::Shared;
pub use workspace::PrWatch;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use crate::api::{AgentInfo, EventKind, SessionId, SessionStatus, SessionSummary, ThreadId};
use crate::log::{SessionLog, now_ms};
use crate::permissions::Policy;
use frontend::FrontendRequests;
use meta::write_meta;
use workspace::shown_pr;

pub struct Session {
    dir: PathBuf,
    meta: Arc<parking_lot::Mutex<SessionMeta>>,
    /// Writes `session.json` for `meta`, outside its lock and in version order.
    meta_disk: Arc<meta::MetaDisk>,
    log: SessionLog,
    agent: crate::acp::AgentSlot,
    shared: Arc<Shared>,
    /// Serializes Session State writes (`state.json` + `StateChanged`).
    state_lock: parking_lot::Mutex<()>,
    frontend_requests: FrontendRequests,
    /// Watches `panels/` once a window read a source file from it (ADR 0023).
    panels_watch: parking_lot::Mutex<Option<crate::panels::Watcher>>,
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
        std::fs::create_dir_all(dir.join(crate::panels::DIR))?;
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
            parent: None,
            initial_config: Default::default(),
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
        if meta.archived {
            // Archived: not written to, so what the last run left open stays as it was.
            log.skip_repair();
        }
        log.note_agent_gone()?;
        let session = Self::from_parts(dir, meta, log, shared);
        if !session.meta.lock().title_backfilled {
            let title = session.log.agent_title(&session.meta.lock().main_thread_id.clone())?;
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
            self.emit_status(session_id, title.to_owned(), self.agent.status());
        }
    }

    fn from_parts(dir: &Path, meta: SessionMeta, log: SessionLog, shared: Arc<Shared>) -> Self {
        let (session_id, events) = (meta.id.clone(), shared.clone());
        log.set_health_hook(move |change| {
            let (error, dropped) = match change {
                crate::log::LogHealth::Degraded(m) => (Some(m.clone()), 0),
                crate::log::LogHealth::Recovered { dropped } => (None, *dropped),
            };
            events.app_events.emit(crate::api::AppEvent::SessionLogHealth { session_id: session_id.clone(), error, dropped });
        });
        Self {
            dir: dir.to_owned(),
            meta: Arc::new(parking_lot::Mutex::new(meta)),
            meta_disk: Arc::new(meta::MetaDisk::new(dir)),
            log,
            agent: Default::default(),
            shared,
            state_lock: Default::default(),
            frontend_requests: Default::default(),
            panels_watch: Default::default(),
        }
    }

    pub fn policy(&self) -> &Policy {
        &self.shared.policy
    }

    pub fn shared(&self) -> &Shared {
        &self.shared
    }

    pub(crate) fn shared_arc(&self) -> &Arc<Shared> {
        &self.shared
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

    /// Makes the log durable (`SessionLog::sync_or_report`) without blocking the caller's runtime
    /// thread: the writer thread fsyncs, the wait and the checkpoint write run on the blocking
    /// pool. A failed sync is reported through the log's health, never an error here.
    pub async fn sync_log(self: &Arc<Self>) {
        let session = self.clone();
        let _ = tokio::task::spawn_blocking(move || session.log.sync_or_report()).await;
    }

    /// `sync_log` for callers that do not wait for it.
    pub fn sync_log_detached(self: &Arc<Self>) {
        let session = self.clone();
        match tokio::runtime::Handle::try_current() {
            Ok(rt) => {
                rt.spawn_blocking(move || session.log.sync_or_report());
            }
            Err(_) => session.log.sync_or_report(),
        }
    }

    pub fn meta(&self) -> SessionMeta {
        self.meta.lock().clone()
    }

    fn emit_status(&self, session_id: SessionId, title: String, status: SessionStatus) {
        let unused = self.meta.lock().unused();
        self.shared.app_events.emit(crate::api::AppEvent::SessionStatus { session_id, title, status, unused });
    }

    pub fn summary(&self) -> SessionSummary {
        self.adopt_repo();
        // The git read happens outside the `meta` lock, which every notification takes.
        let folder = self.meta.lock().folder.clone();
        let branch = crate::workspace::head_branch(Path::new(&folder));
        let m = self.meta.lock();
        let pr = shown_pr(m.workspace.pr, m.workspace.branch_pr.as_ref(), branch.as_deref());
        let status = m.workspace.pr_status.filter(|s| Some(s.number) == pr);
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
            unused: m.unused(),
            workspace: crate::api::WorkspaceInfo {
                repo_root: m.workspace.repo_root.as_ref().map(|p| p.display().to_string()),
                source_folder: m
                    .workspace
                    .worktree
                    .as_ref()
                    .and_then(|w| {
                        let rel = Path::new(&m.folder).strip_prefix(&w.path).ok()?;
                        Some(if rel.as_os_str().is_empty() { w.repo_root.clone() } else { w.repo_root.join(rel) })
                    })
                    .map_or_else(|| m.folder.clone(), |p| p.display().to_string()),
                worktree_branch: m.workspace.worktree.as_ref().map(|w| w.branch.clone()),
                base_branch: m.workspace.worktree.as_ref().map(|w| w.base.clone()),
                pr,
                pr_state: status.map(|s| s.state),
                pr_checks: status.map(|s| s.checks),
                branch,
            },
            parent: m.parent.clone(),
            log_error: self.log.degraded(),
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

    /// Starts a Turn. `origin`: another Session's Agent sent it (a parent prompting its Sub Session).
    pub async fn prompt(
        self: &Arc<Self>,
        thread_id: Option<ThreadId>,
        text: String,
        attachments: Vec<crate::api::AttachmentInput>,
        origin: Option<crate::api::PromptOrigin>,
    ) -> anyhow::Result<()> {
        self.log.writable()?;
        let thread = self.thread(thread_id)?;
        self.note_first_prompt(&thread, &text)?;
        self.adopt_repo();
        crate::acp::prompt(self.clone(), thread, text, attachments, origin).await
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
        // Only when something shown changed: the title, or `unused` (also without a new title).
        if title.is_some() || m.unused() {
            self.emit_status(self.id(), title.unwrap_or(m.title), self.agent.status());
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
        // Stop the log first: an Agent's late exit must not write into the directory being removed.
        self.log.close();
        self.panels_watch.lock().take();
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
            crate::acp::prompt(self.clone(), thread, text, attachments, None).await?;
        }
        Ok(())
    }

    /// Starts the Agent and the Main Thread's Agent Session in the background (see `Command::WarmUp`).
    /// Only for a Thread that never had one: resuming waits for the next prompt.
    pub fn warm_up(self: &Arc<Self>) {
        let m = self.meta();
        if m.archived || m.agent_sessions.contains_key(&m.main_thread_id) || self.log.read_only_reason().is_some() {
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
    pub fn start_side_thread(&self, seed: Option<String>, source: crate::api::ThreadStart, mode: Option<String>) -> anyhow::Result<(ThreadId, bool)> {
        self.log.writable()?;
        let thread = uuid::Uuid::now_v7().to_string();
        let main = self.meta().main_thread_id;
        let point = crate::summary::last_finished_turn(&self.log.events()?, &main);
        let forked = source == crate::api::ThreadStart::Fork && self.meta().agent_sessions.contains_key(&main);
        let agent_id = self.update_meta(|m| {
            m.side_threads.push(thread.clone());
            if let Some(seed) = seed {
                m.seeds.insert(thread.clone(), seed);
            }
            m.origins.insert(thread.clone(), SideOrigin { point: point.clone(), source, mode });
            m.agent.id.clone()
        })?;
        let forked_from = (source != crate::api::ThreadStart::Fresh).then_some(point);
        self.log.append(Some(thread.clone()), EventKind::ThreadStarted { agent_id, main: false, forked_from })?;
        Ok((thread, forked))
    }

    /// Whether the Thread is a Side Thread started without the Main Thread's conversation.
    pub fn is_fresh_side(&self, thread: &ThreadId) -> bool {
        self.meta().origins.get(thread).is_some_and(|o| o.source == crate::api::ThreadStart::Fresh)
    }

    pub async fn cancel(self: &Arc<Self>, thread_id: Option<ThreadId>) -> anyhow::Result<()> {
        let thread = self.thread(thread_id)?;
        self.agent.cancel(self, &thread).await
    }

    pub async fn resolve_permission(self: &Arc<Self>, request_id: &str, option_id: Option<String>, global: bool) -> anyhow::Result<()> {
        self.agent.resolve_permission(self, request_id, option_id, global).await
    }

    pub async fn set_config_option(self: &Arc<Self>, thread_id: Option<ThreadId>, config_id: String, value: String) -> anyhow::Result<()> {
        let thread = self.thread(thread_id)?;
        crate::acp::set_config_option(self.clone(), thread, config_id, value).await
    }

    pub async fn set_mode(self: &Arc<Self>, thread_id: Option<ThreadId>, mode_id: String) -> anyhow::Result<()> {
        let thread = self.thread(thread_id)?;
        crate::acp::set_mode(self.clone(), thread, mode_id).await
    }

    /// Whether a Turn of `thread` is in flight: counted by the Agent slot, or started in the log and
    /// not ended yet (the slot stops counting just before `TurnEnded` is logged).
    pub fn thread_working(&self, thread: &ThreadId) -> anyhow::Result<bool> {
        if self.agent.thread_working(thread) {
            return Ok(true);
        }
        // A log that is not written to (newer Harness, archived) is not repaired: what it left open is not running.
        if self.log.read_only_reason().is_some() || self.meta().archived {
            return Ok(false);
        }
        self.log.thread_turn_open(thread)
    }

    pub(crate) fn agent_slot(&self) -> &crate::acp::AgentSlot {
        &self.agent
    }

    pub fn set_status(&self, status: SessionStatus) {
        self.log.append_or_report(None, EventKind::SessionStatusChanged { status });
        let (session_id, title) = {
            let m = self.meta.lock();
            (m.id.clone(), m.title.clone())
        };
        self.emit_status(session_id, title, status);
        // The Agent may have opened a PR; look in the background (not without a runtime, e.g. sync tests).
        if status == SessionStatus::Idle
            && let Ok(rt) = tokio::runtime::Handle::try_current()
        {
            let watch = self.pr_watch();
            drop(rt.spawn(async move { watch.find().await }));
        }
    }
}
