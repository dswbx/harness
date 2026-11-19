//! A Session: its Session Directory, Session Log, and the Agent connection backing its Threads.

mod artifacts;
mod comments;
mod frontend;
mod meta;
mod note;
mod shared;
mod workspace;

#[cfg(test)]
mod dangling_tests;
#[cfg(test)]
pub(crate) mod projection_tests;
#[cfg(test)]
mod scaling_tests;

pub use frontend::{FrontendErrorEntry, FrontendItem, MAX_FRONTEND_ERROR_LEN, MAX_FRONTEND_ERRORS, RENDER_UI};
pub(crate) use meta::title_from_text;
pub use meta::{BranchPrMeta, PrStatusMeta, QUICK_TITLE, SessionMeta, SideOrigin, WorkspaceMeta};
pub use shared::Shared;
pub use workspace::{PrPlan, PrWatch};

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
    jobs: crate::acp::JobWatchers,
    shared: Arc<Shared>,
    /// Serializes Session State writes (`state.json` + `StateChanged`).
    state_lock: parking_lot::Mutex<()>,
    /// Serializes Session Note writes (check `base_hash`, then write).
    note_lock: parking_lot::Mutex<()>,
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
            unseen: false,
            mcp_servers,
            title_backfilled: true,
            quick: false,
            awaiting_first_prompt: false,
            title_from_prompt: false,
            title_explicit: false,
            agent_title: None,
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

    /// Sets the Session's title on purpose: Agent titles no longer replace it. Logged as
    /// `SessionInfoUpdated` on the Main Thread.
    pub fn set_title(&self, title: &str) -> anyhow::Result<()> {
        const MAX: usize = 80;
        let title: String = title.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(MAX).collect();
        anyhow::ensure!(!title.is_empty(), "title is empty");
        let main = self.update_meta(|m| {
            m.title = title.clone();
            m.title_explicit = true;
            m.title_from_prompt = false;
            m.main_thread_id.clone()
        })?;
        self.log().append(Some(main), EventKind::SessionInfoUpdated { title: Some(title.clone()) })?;
        self.emit_status(self.id(), title, self.agent.status());
        Ok(())
    }

    /// Goes back to the automatic title: the Agent's last, else the first Main Thread prompt's,
    /// else the current one. Agent titles replace it again.
    pub fn reset_title(&self) -> anyhow::Result<()> {
        let m = self.meta();
        let from_prompt = || {
            let events = self.log().events().ok()?;
            events.iter().find_map(|e| match &e.kind {
                EventKind::TurnStarted { text, origin: None, .. } if e.thread_id.as_ref() == Some(&m.main_thread_id) => title_from_text(text),
                _ => None,
            })
        };
        let agent = m.agent_title.clone().filter(|t| !t.is_empty());
        let created = || {
            let events = self.log().events().ok()?;
            events.iter().find_map(|e| match &e.kind {
                EventKind::SessionCreated { title, .. } => Some(title.clone()),
                _ => None,
            })
        };
        let prompt = if agent.is_none() { from_prompt() } else { None };
        let from_prompt_pending = agent.is_none() && prompt.is_none() && (m.awaiting_first_prompt || m.title_from_prompt);
        let title = agent.or(prompt).or_else(created).unwrap_or_else(|| m.title.clone());
        let main = self.update_meta(|m| {
            m.title = title.clone();
            m.title_explicit = false;
            m.title_from_prompt = from_prompt_pending;
            m.main_thread_id.clone()
        })?;
        self.log().append(Some(main), EventKind::SessionInfoUpdated { title: Some(title.clone()) })?;
        self.emit_status(self.id(), title, self.agent.status());
        Ok(())
    }

    /// Titles the Agent sends on `thread` are dropped: the title was set on purpose.
    pub fn ignores_agent_title(&self, thread: Option<&ThreadId>) -> bool {
        self.is_main(thread) && self.meta.lock().title_explicit
    }

    /// Records the Agent's title in `agent_title` (the main Thread's only).
    pub fn note_agent_title_on(&self, thread: Option<&ThreadId>, title: &str) {
        let title = title.trim();
        if !title.is_empty() && self.is_main(thread) {
            let _ = self.update_meta(|m| m.agent_title = Some(title.to_owned()));
        }
    }

    pub fn note_agent_title(&self, title: &str) {
        self.note_agent_title_on(None, title);
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
            jobs: Default::default(),
            shared,
            state_lock: Default::default(),
            note_lock: Default::default(),
            frontend_requests: Default::default(),
            panels_watch: Default::default(),
        }
    }

    pub fn policy(&self) -> &Policy {
        &self.shared.policy
    }

    pub fn shared(&self) -> &Arc<Shared> {
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
        let out = crate::proc::run("open", crate::proc::Opts::new(crate::proc::LOCAL).args(["-a", "Terminal"]).arg(&path)).await?;
        anyhow::ensure!(out.success(), "could not open Terminal");
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
        tokio::task::spawn_blocking(move || session.log.sync_or_report()).await.ok();
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
        let (unused, unseen, title_explicit) = {
            let m = self.meta.lock();
            (m.unused(), m.unseen, m.title_explicit)
        };
        self.shared.app_events.emit(crate::api::AppEvent::SessionStatus { session_id, title, status, unused, unseen, title_explicit });
    }

    /// Marks that a Main Thread Turn ended unseen (`true`) or that the user viewed the Session
    /// (`false`). Emits `SessionStatus` only on a change.
    pub fn set_unseen(&self, unseen: bool) -> anyhow::Result<()> {
        let (changed, title) = self.update_meta(|m| (std::mem::replace(&mut m.unseen, unseen) != unseen, m.title.clone()))?;
        if changed {
            self.emit_status(self.id(), title, self.agent.status());
        }
        Ok(())
    }

    pub fn summary(&self) -> SessionSummary {
        self.adopt_repo();
        // The git read happens outside the `meta` lock, which every notification takes.
        let folder = self.meta.lock().folder.clone();
        let branch = crate::git::head_branch(Path::new(&folder));
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
            unseen: m.unseen,
            title_explicit: m.title_explicit,
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

    pub(crate) fn job_watchers(&self) -> &crate::acp::JobWatchers {
        &self.jobs
    }

    /// Stops what runs for the Session: its job watchers and its Agent process. The one path for
    /// archive and delete (shutdown stops them in `shutdown_stop`, which also waits).
    pub(crate) fn stop_processes(&self, reason: &str) {
        self.jobs.stop_all();
        self.agent.shutdown(reason);
    }

    /// Harness shutdown, part 1: no more watchers or Agent starts; stops the Agent, which ends its Turns in
    /// the log as cancelled, and waits for that, at most `grace`.
    pub(crate) async fn shutdown_stop(self: &Arc<Self>, grace: Duration) {
        self.jobs.close();
        self.agent.close("app_restart", grace).await;
    }

    /// Harness shutdown, part 2: writes what this run appended to disk, then refuses later appends.
    /// Blocking. A read-only log (from a newer build) is left alone; `session.json` is written on
    /// every change, so it is not written again.
    pub(crate) fn shutdown_flush(&self) {
        if self.log.read_only_reason().is_some() {
            return;
        }
        if self.log.is_dirty()
            && let Err(e) = self.log.sync()
        {
            tracing::warn!("flushing the Session Log of {} at shutdown: {e:#}", self.dir.display());
        }
        self.log.close();
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
