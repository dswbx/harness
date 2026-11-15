//! The Harness entry point: owns Sessions and dispatches Commands.

mod boot;
mod create;
mod dispatch;

use parking_lot::RwLock;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use crate::api::{AgentInfo, AppEvent, Command, CommandResult, Event, EventSink, FrontendManifest, HarnessError, PrRefKey, SessionId};
use crate::log::SubscriptionId;
use crate::permissions::Policy;
use crate::session::{Session, Shared};

pub use boot::{builtin_frontends, default_data_dir};
pub(crate) use create::NewSession;

/// Default for `Shared::idle_timeout`.
pub const IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15 * 60);
/// Default for `Shared::cancel_grace`.
pub const CANCEL_GRACE: std::time::Duration = std::time::Duration::from_secs(10);
/// Default for `Shared::restore_retries`.
pub const RESTORE_RETRIES: [std::time::Duration; 3] =
    [std::time::Duration::from_secs(2), std::time::Duration::from_secs(5), std::time::Duration::from_secs(15)];

/// Default for `Options::shutdown_timeout`.
pub const SHUTDOWN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

pub struct Options {
    /// The most `Harness::shutdown` takes before it gives up waiting.
    pub shutdown_timeout: std::time::Duration,
    pub idle_timeout: std::time::Duration,
    pub restore_retries: Vec<std::time::Duration>,
    pub cancel_grace: std::time::Duration,
    pub registry_url: String,
    /// Where MCP Library secrets live; the Keychain by default.
    pub secrets: Box<dyn crate::library::Secrets>,
    /// Command and args that run the stdio MCP shim (see `Shared::mcp_shim`).
    pub mcp_shim: Option<(String, Vec<String>)>,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            shutdown_timeout: SHUTDOWN_TIMEOUT,
            idle_timeout: IDLE_TIMEOUT,
            restore_retries: RESTORE_RETRIES.to_vec(),
            cancel_grace: CANCEL_GRACE,
            registry_url: crate::agents::REGISTRY_URL.to_owned(),
            secrets: Box::new(crate::library::Keychain),
            mcp_shim: None,
        }
    }
}

pub struct Harness {
    data_dir: PathBuf,
    shared: Arc<Shared>,
    sessions: RwLock<HashMap<SessionId, Arc<Session>>>,
    terminals: crate::terminal::Terminals,
    /// When the PR states of the Session list were last refreshed.
    prs_refreshed: parking_lot::Mutex<Option<std::time::Instant>>,
    /// Set once `shutdown` is done, so a second call returns at once.
    shut_down: tokio::sync::OnceCell<()>,
    shutdown_timeout: std::time::Duration,
    /// Holds the data directory lock for as long as the Harness lives.
    _lock: std::fs::File,
}

impl Harness {
    /// Looks up the PRs of the listed Sessions in the background (one `gh` call, at most once a minute), so the Session
    /// list shows their state; Sessions whose PR changed are listed again.
    fn refresh_pr_states(&self) {
        let Ok(rt) = tokio::runtime::Handle::try_current() else { return };
        {
            let mut last = self.prs_refreshed.lock();
            if last.is_some_and(|t| t.elapsed() < std::time::Duration::from_secs(60)) {
                return;
            }
            *last = Some(std::time::Instant::now());
        }
        let watches: Vec<_> = self.sessions.read().values().filter(|s| !s.meta().archived).map(|s| s.pr_watch()).collect();
        let shared = self.shared.clone();
        drop(rt.spawn(async move {
            let mut found = vec![];
            for w in watches {
                let Some((folder, number)) = w.shown() else { continue };
                if let Some(repo) = shared.pr_refs.repo_of(&folder).await {
                    found.push((w, PrRefKey { repo, number }));
                }
            }
            if found.is_empty() {
                return;
            }
            let Ok(prs) = shared.pr_refs.lookup(found.iter().map(|f| f.1.clone()).collect()).await else { return };
            for ((w, _), pr) in found.iter().zip(prs) {
                if let Some(pr) = pr {
                    w.note(&pr);
                }
            }
        }));
    }

    /// `data_dir` is the app data folder; Session Directories live in `data_dir/sessions/<id>/`.
    pub fn new(data_dir: PathBuf) -> anyhow::Result<Arc<Self>> {
        Self::with_options(data_dir, Vec::new(), Options::default())
    }

    /// Like `new`, plus fixed Agents that are listed but not persisted (tests, development).
    pub fn with_agents(data_dir: PathBuf, agents: Vec<AgentInfo>) -> anyhow::Result<Arc<Self>> {
        Self::with_options(data_dir, agents, Options::default())
    }

    pub fn with_options(data_dir: PathBuf, agents: Vec<AgentInfo>, options: Options) -> anyhow::Result<Arc<Self>> {
        crate::env::warm_up();
        let sessions_dir = data_dir.join("sessions");
        std::fs::create_dir_all(&sessions_dir)?;
        let lock = crate::fsutil::lock_dir(&data_dir)?;
        let shared = Arc::new(Shared {
            policy: Policy::open(data_dir.join("permissions.json"))?,
            idle_timeout: options.idle_timeout,
            restore_retries: options.restore_retries,
            cancel_grace: options.cancel_grace,
            agents: crate::agents::Agents::open(&data_dir, options.registry_url, agents)?,
            frontends: RwLock::new(Vec::new()),
            mcp: Default::default(),
            library: crate::library::Library::open(data_dir.join("mcp.json"), options.secrets)?,
            mcp_shim: options.mcp_shim,
            app_events: Default::default(),
            prompts_dir: data_dir.join("prompts"),
            pr_refs: Default::default(),
            artifacts: crate::shared::SharedArtifacts::open(data_dir.join(crate::shared::DIR))?,
            host: Default::default(),
            notices: Default::default(),
            closing: Default::default(),
        });
        // One watch on `shared/` for the life of the Host (ADR 0024 addendum): changes from any
        // Session, the no-Session view or an editor reach every View.
        let weak = Arc::downgrade(&shared);
        shared.artifacts.start_watch(move |id| {
            let Some(shared) = weak.upgrade() else { return };
            let listed = shared.artifacts.refresh(&id);
            shared.app_events.emit(AppEvent::SharedArtifactChanged { id });
            if listed {
                shared.app_events.emit(AppEvent::SharedArtifactsChanged);
            }
        });
        let mut sessions = HashMap::new();
        for entry in std::fs::read_dir(&sessions_dir)? {
            let dir = entry?.path();
            match Session::open(&dir, shared.clone()) {
                // The app closed while this Quick Session was still unused.
                Ok(s) if s.is_discardable() => {
                    if let Err(e) = s.remove_files().and_then(|()| shared.policy.forget_session(&s.id())) {
                        tracing::warn!("removing empty quick session {}: {e:#}", dir.display());
                    }
                }
                Ok(s) => {
                    sessions.insert(s.id().clone(), Arc::new(s));
                }
                Err(e) => tracing::warn!("skipping session {}: {e:#}", dir.display()),
            }
        }
        scan_repos(&shared, sessions.values().filter_map(|s| s.meta().repo_folder()).collect());
        let app_events = shared.clone();
        let terminals = crate::terminal::Terminals::new(move |session_id| {
            app_events.app_events.emit(AppEvent::TerminalsChanged { session_id: session_id.to_owned() });
        });
        let shutdown_timeout = options.shutdown_timeout;
        let host = Arc::new(Self {
            data_dir,
            shared,
            sessions: RwLock::new(sessions),
            terminals,
            prs_refreshed: Default::default(),
            shut_down: Default::default(),
            shutdown_timeout,
            _lock: lock,
        });
        let _ = host.shared.host.set(Arc::downgrade(&host));
        crate::sub_sessions::watch(&host);
        Ok(host)
    }

    /// URL of the Harness MCP (starts it). For diagnostics and tests.
    pub async fn mcp_url(&self) -> anyhow::Result<String> {
        self.shared.mcp.url().await
    }

    pub fn register_frontend(&self, manifest: FrontendManifest) {
        let mut frontends = self.shared.frontends.write();
        frontends.retain(|f| f.id != manifest.id);
        frontends.push(manifest);
    }

    /// The Sub Sessions a Session started (`parent.session_id` names it).
    pub(crate) fn children(&self, session_id: &str) -> Vec<Arc<Session>> {
        let mut children: Vec<Arc<Session>> =
            self.sessions.read().values().filter(|s| s.meta().parent.is_some_and(|p| p.session_id == session_id)).cloned().collect();
        children.sort_by_key(|s| s.meta().created_ms);
        children
    }

    /// A Session's title, if it exists.
    pub(crate) fn session_title(&self, session_id: &str) -> Option<String> {
        self.sessions.read().get(session_id).map(|s| s.meta().title)
    }

    /// Deletes a Session and, first, its Sub Sessions. A child that cannot be deleted (unmerged
    /// work, without `force`) stops it before the parent is touched.
    async fn delete_session(&self, session_id: &SessionId, force: bool) -> anyhow::Result<()> {
        for child in self.children(session_id) {
            Box::pin(self.delete_session(&child.id(), force)).await?;
        }
        let session = self.session(session_id)?;
        self.terminals.kill_all(session_id);
        session.delete_workspace(force).await?;
        self.sessions.write().remove(session_id);
        session.remove_files()?;
        if self.shared.artifacts.forget_session(session_id) {
            self.shared.app_events.emit(AppEvent::SharedArtifactsChanged);
        }
        self.shared.policy.forget_session(session_id)
    }

    /// Stops everything the Harness runs, then returns; at most `Options::shutdown_timeout`. Commands
    /// fail from the first call on. Per Session: its job watchers stop, its Agent process (group)
    /// is stopped and a Turn that was running ends in the log as `cancelled`, the Session Log is
    /// written to disk and closed. Terminals and the Harness MCP stop too. Safe to call again:
    /// later calls wait for the first and return.
    pub async fn shutdown(&self) {
        self.shared.closing.store(true, std::sync::atomic::Ordering::SeqCst);
        self.shut_down.get_or_init(|| self.shutdown_once()).await;
    }

    /// The most `shutdown` takes.
    pub fn shutdown_timeout(&self) -> std::time::Duration {
        self.shutdown_timeout
    }

    async fn shutdown_once(&self) {
        let started = std::time::Instant::now();
        // Sessions with activity this run first: they are the ones with something to write.
        let mut sessions: Vec<Arc<Session>> = self.sessions.read().values().cloned().collect();
        sessions.sort_by_key(|s| !s.log().is_dirty());
        self.terminals.kill_everything();
        self.shared.mcp.stop();
        // The Agent's process group goes with its connection (the ACP crate kills it on drop).
        let grace = self.shutdown_timeout * 3 / 5;
        let stopping = futures_util::future::join_all(sessions.iter().map(|s| s.shutdown_stop(grace)));
        if tokio::time::timeout(grace, stopping).await.is_err() {
            tracing::warn!("shutdown: an Agent did not stop within {grace:?}");
        }
        let left = self.shutdown_timeout.saturating_sub(started.elapsed()).max(std::time::Duration::from_millis(500));
        let flushing = tokio::task::spawn_blocking(move || sessions.iter().for_each(|s| s.shutdown_flush()));
        if tokio::time::timeout(left, flushing).await.is_err() {
            tracing::warn!("shutdown: writing the Session Logs took longer than {left:?}");
        }
    }

    fn ensure_open(&self) -> anyhow::Result<()> {
        if self.shared.closing.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(crate::error::unavailable("the Harness is shutting down"));
        }
        Ok(())
    }

    /// How many job watchers the Session has now; the counter keeps working after the Session is
    /// deleted. For tests.
    #[doc(hidden)]
    pub fn job_watcher_counter(&self, session_id: &str) -> anyhow::Result<impl Fn() -> usize + Send + Sync + use<>> {
        let watchers = self.session(session_id)?.job_watchers().clone();
        Ok(move || watchers.len())
    }

    pub async fn execute(&self, cmd: Command) -> Result<CommandResult, HarnessError> {
        self.ensure_open()?;
        let changes = match &cmd {
            Command::CreateSession { .. } | Command::CreateQuickSession { .. } | Command::DeleteSession { .. } | Command::DiscardEmptySession { .. } => {
                Some(AppEvent::SessionsChanged)
            }
            Command::InstallAgent { .. }
            | Command::AddCustomAgent { .. }
            | Command::RemoveAgent { .. }
            | Command::RollbackAgent { .. }
            | Command::HoldAgentVersion { .. } => Some(AppEvent::AgentsChanged),
            Command::ShareArtifact { .. }
            | Command::ShareMarkdown { .. }
            | Command::AttachSharedArtifact { .. }
            | Command::DetachSharedArtifact { .. }
            | Command::RenameSharedArtifact { .. }
            | Command::DeleteSharedArtifact { .. } => Some(AppEvent::SharedArtifactsChanged),
            _ => None,
        };
        // A View showing the artifact re-reads it at once, before the watcher's debounce.
        let changed = match &cmd {
            Command::RenameSharedArtifact { id, .. } | Command::DeleteSharedArtifact { id } | Command::PatchArtifactState { id, .. } => Some(id.clone()),
            _ => None,
        };
        let result = self.execute_inner(cmd).await.map_err(HarnessError::from);
        if let (Ok(_), Some(event)) = (&result, changes) {
            self.shared.app_events.emit(event);
        }
        if let (Ok(_), Some(id)) = (&result, changed) {
            self.shared.app_events.emit(AppEvent::SharedArtifactChanged { id });
        }
        result
    }

    /// Delivers `AppEvent`s until the sink returns `false` or `unsubscribe_app`.
    pub fn subscribe_app(&self, sink: Box<dyn Fn(&AppEvent) -> bool + Send + Sync>) -> u64 {
        self.shared.app_events.subscribe(sink)
    }

    pub fn unsubscribe_app(&self, id: u64) {
        self.shared.app_events.unsubscribe(id);
    }

    /// Attaches to a Terminal tab of the Session (a shell in its Workspace Folder, started if none runs):
    /// the replay buffer, then live output until the sink returns `false` or `terminal_detach`.
    pub fn terminal_attach(&self, session_id: &str, terminal_id: u32, cols: u16, rows: u16, sink: crate::terminal::TerminalSink) -> anyhow::Result<u64> {
        self.ensure_open()?;
        let folder = PathBuf::from(self.session(session_id)?.meta().folder);
        self.terminals.attach(session_id, terminal_id, &folder, cols, rows, sink)
    }

    pub fn terminal_detach(&self, session_id: &str, terminal_id: u32, id: u64) {
        self.terminals.detach(session_id, terminal_id, id);
    }

    async fn execute_inner(&self, cmd: Command) -> anyhow::Result<CommandResult> {
        match cmd {
            Command::ListAgents => self.cmd_list_agents(),
            Command::ListRegistry { refresh } => self.cmd_list_registry(refresh).await,
            Command::InstallAgent { registry_id, allow_unverified } => self.cmd_install_agent(registry_id, allow_unverified).await,
            Command::RollbackAgent { agent_id } => self.cmd_rollback_agent(agent_id).await,
            Command::HoldAgentVersion { agent_id, hold } => self.cmd_hold_agent_version(agent_id, hold),
            Command::AddCustomAgent { name, command, args, env } => self.cmd_add_custom_agent(name, command, args, env),
            Command::RemoveAgent { agent_id } => self.cmd_remove_agent(agent_id),
            Command::Authenticate { session_id, method_id } => self.cmd_authenticate(session_id, method_id).await,
            Command::OpenAuthTerminal { session_id, method_id } => self.cmd_open_auth_terminal(session_id, method_id).await,
            Command::ListFrontends => self.cmd_list_frontends(),
            Command::ListSessions => self.cmd_list_sessions(),
            Command::CreateSession { folder, agent_id, frontend_id, title, branch, worktree, new_branch, pr, mcp_servers } => {
                self.cmd_create_session(folder, agent_id, frontend_id, title, branch, worktree, new_branch, pr, mcp_servers).await
            }
            Command::CreateQuickSession { agent_id, frontend_id, title, mcp_servers } => {
                self.cmd_create_quick_session(agent_id, frontend_id, title, mcp_servers).await
            }
            Command::Prompt { session_id, thread_id, text, attachments } => self.cmd_prompt(session_id, thread_id, text, attachments).await,
            Command::ReadAttachment { session_id, path } => self.cmd_read_attachment(session_id, path),
            Command::ReadImageFile { path } => self.cmd_read_image_file(path),
            Command::Cancel { session_id, thread_id } => self.cmd_cancel(session_id, thread_id).await,
            Command::WarmUp { session_id } => self.cmd_warm_up(session_id),
            Command::ContinueWithSummary { session_id, thread_id, text, attachments } => {
                self.cmd_continue_with_summary(session_id, thread_id, text, attachments).await
            }
            Command::StartSideThread { session_id, seed, source, mode } => self.cmd_start_side_thread(session_id, seed, source, mode).await,
            Command::ListMcpServers => self.cmd_list_mcp_servers(),
            Command::SaveMcpServer { server, secrets } => self.cmd_save_mcp_server(server, secrets),
            Command::RemoveMcpServer { server_id } => self.cmd_remove_mcp_server(server_id),
            Command::FrontendRead { session_id, path } => self.cmd_frontend_read(session_id, path),
            Command::PanelSourceRead { session_id, name } => self.cmd_panel_source_read(session_id, name).await,
            Command::GetAppSetting { key } => self.cmd_get_app_setting(key),
            Command::SetAppSetting { key, value } => self.cmd_set_app_setting(key, value),
            Command::FetchJson { url } => self.cmd_fetch_json(url).await,
            Command::GetWorktreeDir => self.cmd_get_worktree_dir(),
            Command::SetWorktreeDir { dir } => self.cmd_set_worktree_dir(dir),
            Command::GetEditor => self.cmd_get_editor(),
            Command::SetEditor { editor } => self.cmd_set_editor(editor),
            Command::OpenInEditor { session_id, path, line } => self.cmd_open_in_editor(session_id, path, line).await,
            Command::ExportPlan { session_id, name, markdown, open_in_editor } => self.cmd_export_plan(session_id, name, markdown, open_in_editor).await,
            Command::ListSessionFiles { session_id } => self.cmd_list_session_files(session_id).await,
            Command::ReadSessionFile { session_id, path, start, end } => self.cmd_read_session_file(session_id, path, start, end).await,
            Command::GetState { session_id } => self.cmd_get_state(session_id),
            Command::PatchState { session_id, ops } => self.cmd_patch_state(session_id, ops),
            Command::ReportFrontendError { session_id, tool, item, message } => self.cmd_report_frontend_error(session_id, tool, item, message),
            Command::AnswerFrontendRequest { session_id, request_id, answer } => self.cmd_answer_frontend_request(session_id, request_id, answer),
            Command::FrontendReadImage { session_id, path } => self.cmd_frontend_read_image(session_id, path),
            Command::FrontendWrite { session_id, path, content } => self.cmd_frontend_write(session_id, path, content),
            Command::FrontendList { session_id, dir } => self.cmd_frontend_list(session_id, dir),
            Command::ListBranches { folder } => self.cmd_list_branches(folder).await,
            Command::ListPullRequests { folder, filter } => self.cmd_list_pull_requests(folder, filter).await,
            Command::UpdateBranch { folder, branch } => self.cmd_update_branch(folder, branch).await,
            Command::BranchPr { session_id, refresh } => self.cmd_branch_pr(session_id, refresh).await,
            Command::ArchiveSession { session_id } => self.cmd_archive_session(session_id).await,
            Command::UnarchiveSession { session_id } => self.cmd_unarchive_session(session_id).await,
            Command::DeleteSession { session_id, force } => self.cmd_delete_session(session_id, force).await,
            Command::DiscardEmptySession { session_id } => self.cmd_discard_empty_session(session_id).await,
            Command::GitStatus { session_id } => self.cmd_git_status(session_id).await,
            Command::PrContext { session_id } => self.cmd_pr_context(session_id).await,
            Command::LookupPrs { session_id, refs } => self.cmd_lookup_prs(session_id, refs).await,
            Command::SearchPrs { session_id, repo, query } => self.cmd_search_prs(session_id, repo, query).await,
            Command::GitDiff { session_id, from, to } => self.cmd_git_diff(session_id, from, to).await,
            Command::GitLog { session_id } => self.cmd_git_log(session_id).await,
            Command::ListTerminals { session_id } => self.cmd_list_terminals(session_id).await,
            Command::TerminalOpen { session_id } => self.cmd_terminal_open(session_id),
            Command::TerminalClose { session_id, terminal_id } => self.cmd_terminal_close(session_id, terminal_id),
            Command::TerminalInput { session_id, terminal_id, data } => self.cmd_terminal_input(session_id, terminal_id, data),
            Command::TerminalResize { session_id, terminal_id, cols, rows } => self.cmd_terminal_resize(session_id, terminal_id, cols, rows),
            Command::TerminalAck { session_id, terminal_id, bytes } => self.cmd_terminal_ack(session_id, terminal_id, bytes),
            Command::TerminalKill { session_id, terminal_id } => self.cmd_terminal_kill(session_id, terminal_id),
            Command::GitShowFile { session_id, rev, path } => self.cmd_git_show_file(session_id, rev, path).await,
            Command::GitCommit { session_id, message } => self.cmd_git_commit(session_id, message).await,
            Command::GitPush { session_id } => self.cmd_git_push(session_id).await,
            Command::ResolvePermission { session_id, request_id, option_id, global } => self.cmd_resolve_permission(session_id, request_id, option_id, global),
            Command::ListPermissionRules => self.cmd_list_permission_rules(),
            Command::AddPermissionRule { rule } => self.cmd_add_permission_rule(rule),
            Command::RemovePermissionRule { rule_id } => self.cmd_remove_permission_rule(rule_id),
            Command::SetConfigOption { session_id, thread_id, config_id, value } => self.cmd_set_config_option(session_id, thread_id, config_id, value).await,
            Command::SetMode { session_id, thread_id, mode_id } => self.cmd_set_mode(session_id, thread_id, mode_id).await,
            Command::ListSharedArtifacts { query } => self.cmd_list_shared_artifacts(query).await,
            Command::SharedArtifactRead { id } => self.cmd_shared_artifact_read(id).await,
            Command::ShareArtifact { session_id, item_id } => self.cmd_share_artifact(session_id, item_id).await,
            Command::ShareMarkdown { session_id, markdown, title, origin } => self.cmd_share_markdown(session_id, markdown, title, origin),
            Command::AttachSharedArtifact { session_id, id } => self.cmd_attach_shared_artifact(session_id, id),
            Command::DetachSharedArtifact { session_id, id } => self.cmd_detach_shared_artifact(session_id, id),
            Command::RenameSharedArtifact { id, title } => self.cmd_rename_shared_artifact(id, title),
            Command::DeleteSharedArtifact { id } => self.cmd_delete_shared_artifact(id).await,
            Command::OpenSharedInEditor { id } => self.cmd_open_shared_in_editor(id).await,
            Command::PatchArtifactState { id, ops, session_id } => self.cmd_patch_artifact_state(id, ops, session_id),
        }
    }

    pub fn subscribe_session(&self, session_id: &str, from_seq: u64, sink: Box<dyn EventSink>) -> Result<SubscriptionId, String> {
        let session = self.session(session_id).map_err(|e| e.to_string())?;
        session.log().subscribe(from_seq, sink).map_err(|e| format!("{e:#}"))
    }

    /// A snapshot of a Session's Events (no subscription, so it never counts as an open View).
    pub fn session_events(&self, session_id: &str) -> Result<Vec<Event>, String> {
        self.session(session_id).map_err(|e| e.to_string())?.log().events().map_err(|e| format!("{e:#}"))
    }

    pub fn unsubscribe_session(&self, session_id: &str, sub: SubscriptionId) {
        if let Ok(s) = self.session(session_id) {
            s.log().unsubscribe(sub);
        }
    }

    pub(crate) fn session(&self, id: &str) -> anyhow::Result<Arc<Session>> {
        self.sessions.read().get(id).cloned().ok_or_else(|| crate::error::not_found(format!("unknown session {id}")))
    }

    fn agent(&self, id: &str) -> anyhow::Result<AgentInfo> {
        self.shared.agents.get(id).ok_or_else(|| crate::error::not_found(format!("unknown agent {id}")))
    }
}

/// Finds the Sessions' GitHub repos in the background; on a runtime when there is one (the app has none yet).
fn scan_repos(shared: &Arc<Shared>, folders: Vec<PathBuf>) {
    let shared = shared.clone();
    let scan = async move { shared.pr_refs.scan(folders).await };
    match tokio::runtime::Handle::try_current() {
        Ok(rt) => drop(rt.spawn(scan)),
        Err(_) => drop(std::thread::spawn(move || tokio::runtime::Builder::new_current_thread().enable_all().build().map(|rt| rt.block_on(scan)))),
    }
}
