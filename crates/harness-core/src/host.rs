//! The Harness entry point: owns Sessions and dispatches Commands.

use parking_lot::RwLock;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::api::{
    AgentInfo, AppEvent, Command, CommandResult, Event, EventKind, EventSink, FrontendManifest, GitActor, HarnessError, PrRefKey, SessionId, SessionSummary,
};
use crate::log::SubscriptionId;
use crate::permissions::Policy;
use crate::session::{Session, Shared, WorkspaceMeta};
use crate::workspace::WorktreeMeta;

/// Default for `Shared::idle_timeout`.
pub const IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15 * 60);
/// Default for `Shared::cancel_grace`.
pub const CANCEL_GRACE: std::time::Duration = std::time::Duration::from_secs(10);
/// Default for `Shared::restore_retries`.
pub const RESTORE_RETRIES: [std::time::Duration; 3] =
    [std::time::Duration::from_secs(2), std::time::Duration::from_secs(5), std::time::Duration::from_secs(15)];

pub struct Options {
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
    /// Holds the data directory lock for as long as the Harness lives.
    _lock: std::fs::File,
}

impl Harness {
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
        Ok(Arc::new(Self { data_dir, shared, sessions: RwLock::new(sessions), terminals, _lock: lock }))
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

    async fn delete_session(&self, session_id: &SessionId, force: bool) -> anyhow::Result<()> {
        let session = self.session(session_id)?;
        self.terminals.kill_all(session_id);
        session.delete_workspace(force).await?;
        self.sessions.write().remove(session_id);
        session.remove_files()?;
        self.shared.policy.forget_session(session_id)
    }

    pub async fn execute(&self, cmd: Command) -> Result<CommandResult, HarnessError> {
        let changes = match &cmd {
            Command::CreateSession { .. } | Command::CreateQuickSession { .. } | Command::DeleteSession { .. } | Command::DiscardEmptySession { .. } => {
                Some(AppEvent::SessionsChanged)
            }
            Command::InstallAgent { .. }
            | Command::AddCustomAgent { .. }
            | Command::RemoveAgent { .. }
            | Command::RollbackAgent { .. }
            | Command::HoldAgentVersion { .. } => Some(AppEvent::AgentsChanged),
            _ => None,
        };
        let result = self.execute_inner(cmd).await.map_err(HarnessError::from);
        if let (Ok(_), Some(event)) = (&result, changes) {
            self.shared.app_events.emit(event);
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
        let folder = PathBuf::from(self.session(session_id)?.meta().folder);
        self.terminals.attach(session_id, terminal_id, &folder, cols, rows, sink)
    }

    pub fn terminal_detach(&self, session_id: &str, terminal_id: u32, id: u64) {
        self.terminals.detach(session_id, terminal_id, id);
    }

    async fn execute_inner(&self, cmd: Command) -> anyhow::Result<CommandResult> {
        Ok(match cmd {
            Command::ListAgents => CommandResult::Agents { agents: self.shared.agents.list() },
            Command::ListRegistry { refresh } => CommandResult::Registry { agents: self.shared.agents.registry(refresh).await? },
            Command::InstallAgent { registry_id, allow_unverified } => {
                CommandResult::AgentInstalled { agent: self.shared.agents.install(&registry_id, allow_unverified).await? }
            }
            Command::RollbackAgent { agent_id } => CommandResult::AgentInstalled { agent: self.shared.agents.rollback(&agent_id).await? },
            Command::HoldAgentVersion { agent_id, hold } => CommandResult::AgentInstalled { agent: self.shared.agents.hold(&agent_id, hold)? },
            Command::AddCustomAgent { name, command, args, env } => {
                CommandResult::AgentInstalled { agent: self.shared.agents.add_custom(name, command, args, env)? }
            }
            Command::RemoveAgent { agent_id } => {
                self.shared.agents.remove(&agent_id)?;
                CommandResult::Ok
            }
            Command::Authenticate { session_id, method_id } => {
                self.session(&session_id)?.authenticate(method_id).await?;
                CommandResult::Ok
            }
            Command::OpenAuthTerminal { session_id, method_id } => {
                self.session(&session_id)?.open_auth_terminal(&method_id).await?;
                CommandResult::Ok
            }
            Command::ListFrontends => CommandResult::Frontends { frontends: self.shared.frontends.read().clone() },
            Command::ListSessions => {
                let mut sessions: Vec<SessionSummary> = self.sessions.read().values().map(|s| s.summary()).collect();
                sessions.sort_by_key(|s| std::cmp::Reverse(s.created_ms));
                CommandResult::Sessions { sessions }
            }
            Command::CreateSession { folder, agent_id, frontend_id, title, branch, worktree, new_branch, pr, mcp_servers } => {
                let agent = self.agent(&agent_id)?;
                anyhow::ensure!(self.shared.frontends.read().iter().any(|f| f.id == frontend_id), "unknown frontend {frontend_id}");
                let id = uuid::Uuid::now_v7().to_string();
                let dir = self.data_dir.join("sessions").join(&id);
                let start = match pr {
                    Some(n) => Start::Pr { pr: crate::github::view_pr(Path::new(&folder), n).await?, worktree },
                    None => Start::Branch { base: branch, new_branch, worktree },
                };
                let title = title.unwrap_or_else(|| match &start {
                    Start::Pr { pr: p, .. } => format!("#{} {}", p.number, p.title),
                    Start::Branch { .. } => folder_name(&folder),
                });
                let (folder, workspace) = self.prepare_workspace(&id, &title, folder, start).await?;
                for m in &mcp_servers {
                    self.shared.library.resolve(m)?;
                }
                let session = Session::create(&dir, id.clone(), title, folder, agent, frontend_id, workspace, mcp_servers, self.shared.clone())?;
                if let Some(folder) = session.meta().repo_folder() {
                    let shared = self.shared.clone();
                    tokio::spawn(async move { shared.pr_refs.repo_of(&folder).await });
                }
                self.sessions.write().insert(id.clone(), Arc::new(session));
                CommandResult::SessionCreated { session_id: id }
            }
            Command::CreateQuickSession { agent_id, frontend_id, title, mcp_servers } => {
                let agent = self.agent(&agent_id)?;
                anyhow::ensure!(self.shared.frontends.read().iter().any(|f| f.id == frontend_id), "unknown frontend {frontend_id}");
                for m in &mcp_servers {
                    self.shared.library.resolve(m)?;
                }
                let id = uuid::Uuid::now_v7().to_string();
                let folder = self.data_dir.join("quick").join(&id);
                std::fs::create_dir_all(&folder)?;
                let folder = std::fs::canonicalize(&folder)?.display().to_string();
                let title_from_prompt = title.is_none();
                let session = Session::create(
                    &self.data_dir.join("sessions").join(&id),
                    id.clone(),
                    title.unwrap_or_else(|| crate::session::QUICK_TITLE.to_owned()),
                    folder,
                    agent,
                    frontend_id,
                    WorkspaceMeta::default(),
                    mcp_servers,
                    self.shared.clone(),
                )?;
                session.update_meta(|m| {
                    m.quick = true;
                    m.awaiting_first_prompt = true;
                    m.title_from_prompt = title_from_prompt;
                })?;
                self.sessions.write().insert(id.clone(), Arc::new(session));
                CommandResult::SessionCreated { session_id: id }
            }
            Command::Prompt { session_id, thread_id, text, attachments } => {
                self.session(&session_id)?.prompt(thread_id, text, attachments).await?;
                CommandResult::Ok
            }
            Command::ReadAttachment { session_id, path } => {
                let (mime, data) = self.session(&session_id)?.read_attachment(&path)?;
                CommandResult::Attachment { mime, data }
            }
            Command::ReadImageFile { path } => {
                let (mime, data) = crate::attachments::read_image(&path)?;
                CommandResult::Attachment { mime, data }
            }
            Command::Cancel { session_id, thread_id } => {
                self.session(&session_id)?.cancel(thread_id).await?;
                CommandResult::Ok
            }
            Command::WarmUp { session_id } => {
                self.session(&session_id)?.warm_up();
                CommandResult::Ok
            }
            Command::ContinueWithSummary { session_id, thread_id, text, attachments } => {
                self.session(&session_id)?.continue_with_summary(thread_id, text, attachments).await?;
                CommandResult::Ok
            }
            Command::StartSideThread { session_id, seed, source, mode } => {
                let session = self.session(&session_id)?;
                let (thread_id, forked) = session.start_side_thread(seed, source, mode)?;
                if forked {
                    // Fork now, so the Side Thread sees the Main Thread as it was when opened.
                    let thread = thread_id.clone();
                    tokio::spawn(async move {
                        if let Err(e) = crate::acp::warm_up(session, thread).await {
                            tracing::debug!("side thread warm-up: {e:#}");
                        }
                    });
                }
                CommandResult::ThreadStarted { thread_id, forked }
            }
            Command::ListMcpServers => CommandResult::McpServers { servers: self.shared.library.list() },
            Command::SaveMcpServer { server, secrets } => CommandResult::McpServerSaved { server: self.shared.library.save(server, secrets)? },
            Command::RemoveMcpServer { server_id } => {
                self.shared.library.remove(&server_id)?;
                CommandResult::Ok
            }
            Command::FrontendRead { session_id, path } => CommandResult::FileContent { content: self.session(&session_id)?.frontend_read(&path)? },
            Command::GetAppSetting { key } => CommandResult::Json { value: crate::app_settings::load(&self.data_dir, key) },
            Command::SetAppSetting { key, value } => {
                crate::app_settings::save(&self.data_dir, key, value.as_ref())?;
                CommandResult::Ok
            }
            Command::FetchJson { url } => CommandResult::Json { value: Some(crate::app_settings::fetch_json(&url).await?) },
            Command::GetEditor => CommandResult::Editor { editor: crate::editor::load(&self.data_dir) },
            Command::SetEditor { editor } => {
                crate::editor::save(&self.data_dir, editor.as_ref())?;
                CommandResult::Ok
            }
            Command::OpenInEditor { session_id, path, line } => {
                let editor = crate::editor::load(&self.data_dir).ok_or_else(|| crate::error::invalid("choose an editor in Settings first"))?;
                let folder = PathBuf::from(self.session(&session_id)?.meta().folder);
                let file = crate::editor::resolve(&folder, path.as_deref())?;
                let target = crate::editor::target(&editor, &file, line);
                tokio::task::spawn_blocking(move || crate::editor::open(&target)).await??;
                CommandResult::Ok
            }
            Command::ReadSessionFile { session_id, path, start, end } => {
                let folder = PathBuf::from(self.session(&session_id)?.meta().folder);
                let (path, start, lines, total) = tokio::task::spawn_blocking(move || crate::editor::read_lines(&folder, &path, start, end)).await??;
                CommandResult::FileLines { path, start, lines, total }
            }
            Command::GetState { session_id } => CommandResult::State { state: self.session(&session_id)?.state()? },
            Command::PatchState { session_id, ops } => {
                self.session(&session_id)?.patch_state(None, ops, crate::api::StateWriter::User)?;
                CommandResult::Ok
            }
            Command::ReportFrontendError { session_id, tool, item, message } => {
                self.session(&session_id)?.report_frontend_error(&tool, &item, &message)?;
                CommandResult::Ok
            }
            Command::AnswerFrontendRequest { session_id, request_id, answer } => {
                self.session(&session_id)?.answer_frontend_request(&request_id, answer);
                CommandResult::Ok
            }
            Command::FrontendReadImage { session_id, path } => {
                let (mime, data) = self.session(&session_id)?.frontend_read_image(&path)?;
                CommandResult::Attachment { mime, data }
            }
            Command::FrontendWrite { session_id, path, content } => {
                self.session(&session_id)?.frontend_write(&path, &content)?;
                CommandResult::Ok
            }
            Command::FrontendList { session_id, dir } => CommandResult::Files { files: self.session(&session_id)?.frontend_list(&dir)? },
            Command::ListBranches { folder } => {
                let mut branches = crate::workspace::list_branches(Path::new(&folder)).await?;
                // Archived Sessions keep their branch but lose the Worktree.
                let archived: Vec<String> = self
                    .sessions
                    .read()
                    .values()
                    .map(|s| s.meta())
                    .filter(|m| m.archived)
                    .filter_map(|m| m.workspace.worktree)
                    .filter(|w| Some(w.repo_root.display().to_string()) == branches.repo_root)
                    .map(|w| w.branch)
                    .collect();
                for b in branches.branches.iter_mut().filter(|b| archived.contains(&b.name)) {
                    b.archived = true;
                }
                CommandResult::Branches { branches }
            }
            Command::ListPullRequests { folder, filter } => CommandResult::PullRequests { prs: crate::github::list_prs(Path::new(&folder), filter).await? },
            Command::UpdateBranch { folder, branch } => {
                crate::workspace::update_branch(Path::new(&folder), &branch).await?;
                CommandResult::Ok
            }
            Command::BranchPr { session_id, refresh } => {
                let session = self.session(&session_id)?;
                let meta = session.meta();
                let refs = &self.shared.pr_refs;
                let repo = match meta.repo_folder() {
                    Some(folder) => refs.repo_of(&folder).await,
                    None => None,
                };
                let pr = match &repo {
                    None => None,
                    Some(repo) => match meta.workspace.pr {
                        Some(number) => {
                            if refresh {
                                refs.forget(repo, number);
                            }
                            refs.lookup(vec![PrRefKey { repo: repo.clone(), number }]).await?.pop().flatten()
                        }
                        None => match crate::workspace::current_branch(Path::new(&meta.folder)).await? {
                            Some(branch) => session.pr_watch().lookup(repo, &branch).await?,
                            None => None,
                        },
                    },
                };
                let base = match meta.workspace.worktree.as_ref().map(|w| w.base.clone()).or_else(|| meta.workspace.base.clone()) {
                    Some(b) => Some(b),
                    None => crate::workspace::default_branch(Path::new(&meta.folder)).await.map(|b| b.strip_prefix("origin/").unwrap_or(&b).to_owned()),
                };
                CommandResult::BranchPr { repo, pr, base }
            }
            Command::ArchiveSession { session_id } => {
                self.terminals.kill_all(&session_id);
                self.session(&session_id)?.archive().await?;
                CommandResult::Ok
            }
            Command::UnarchiveSession { session_id } => {
                self.session(&session_id)?.unarchive().await?;
                CommandResult::Ok
            }
            Command::DeleteSession { session_id, force } => {
                self.delete_session(&session_id, force).await?;
                CommandResult::Ok
            }
            Command::DiscardEmptySession { session_id } => {
                let discardable = self.sessions.read().get(&session_id).is_some_and(|s| s.is_discardable());
                if discardable {
                    self.delete_session(&session_id, false).await?;
                }
                CommandResult::Ok
            }
            Command::GitStatus { session_id } => CommandResult::GitStatus { status: self.session(&session_id)?.git_status().await? },
            Command::PrContext { session_id } => {
                let session = self.session(&session_id)?;
                let folders: Vec<(PathBuf, i64)> = self
                    .sessions
                    .read()
                    .values()
                    .filter_map(|s| {
                        let meta = s.meta();
                        Some((meta.repo_folder()?, s.log().last_ts_ms().unwrap_or(meta.created_ms)))
                    })
                    .collect();
                let refs = &self.shared.pr_refs;
                let (_, me) = tokio::join!(refs.scan(folders.iter().map(|f| f.0.clone()).collect()), refs.me());
                let session_repo = match session.meta().repo_folder() {
                    Some(folder) => refs.repo_of(&folder).await,
                    None => None,
                };
                CommandResult::PrContext { session_repo, known_repos: refs.known_repos(&folders, crate::log::now_ms()), me }
            }
            Command::LookupPrs { session_id, refs } => {
                self.session(&session_id)?;
                CommandResult::PrLookup { prs: self.shared.pr_refs.lookup(refs).await? }
            }
            Command::SearchPrs { session_id, repo, query } => {
                self.session(&session_id)?;
                CommandResult::PrSearch { prs: self.shared.pr_refs.search(&repo, query.as_deref()).await? }
            }
            Command::GitDiff { session_id, from, to } => CommandResult::Diff { diff: self.session(&session_id)?.git_diff(from, to).await? },
            Command::GitLog { session_id } => CommandResult::GitLog { commits: self.session(&session_id)?.git_log().await? },
            Command::ListTerminals { session_id } => {
                self.session(&session_id)?;
                let terminals = self.terminals.clone();
                // Naming the foreground process runs `ps`.
                let terminals = tokio::task::spawn_blocking(move || terminals.list(&session_id)).await?;
                CommandResult::Terminals { terminals }
            }
            Command::TerminalOpen { session_id } => {
                self.session(&session_id)?;
                CommandResult::TerminalOpened { terminal_id: self.terminals.open(&session_id) }
            }
            Command::TerminalClose { session_id, terminal_id } => {
                self.terminals.close(&session_id, terminal_id);
                CommandResult::Ok
            }
            Command::TerminalInput { session_id, terminal_id, data } => {
                self.terminals.input(&session_id, terminal_id, data.as_bytes())?;
                CommandResult::Ok
            }
            Command::TerminalResize { session_id, terminal_id, cols, rows } => {
                self.terminals.resize(&session_id, terminal_id, cols, rows)?;
                CommandResult::Ok
            }
            Command::TerminalAck { session_id, terminal_id, bytes } => {
                self.terminals.ack(&session_id, terminal_id, bytes as usize);
                CommandResult::Ok
            }
            Command::TerminalKill { session_id, terminal_id } => {
                self.terminals.kill(&session_id, terminal_id);
                CommandResult::Ok
            }
            Command::GitShowFile { session_id, rev, path } => {
                CommandResult::FileContent { content: self.session(&session_id)?.git_show_file(&rev, &path).await? }
            }
            Command::GitCommit { session_id, message } => {
                CommandResult::Committed { commit: self.session(&session_id)?.git_commit(message, GitActor::User).await? }
            }
            Command::GitPush { session_id } => {
                self.session(&session_id)?.git_push(GitActor::User).await?;
                CommandResult::Ok
            }
            Command::ResolvePermission { session_id, request_id, option_id, global } => {
                self.session(&session_id)?.resolve_permission(&request_id, option_id, global)?;
                CommandResult::Ok
            }
            Command::ListPermissionRules => CommandResult::PermissionRules { rules: self.shared.policy.list() },
            Command::AddPermissionRule { rule } => CommandResult::PermissionRuleAdded { rule: self.shared.policy.add(rule)? },
            Command::RemovePermissionRule { rule_id } => {
                self.shared.policy.remove(&rule_id)?;
                CommandResult::Ok
            }
            Command::SetConfigOption { session_id, thread_id, config_id, value } => {
                self.session(&session_id)?.set_config_option(thread_id, config_id, value).await?;
                CommandResult::Ok
            }
            Command::SetMode { session_id, thread_id, mode_id } => {
                self.session(&session_id)?.set_mode(thread_id, mode_id).await?;
                CommandResult::Ok
            }
        })
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

    /// Appends an event on behalf of a test or adapter (e.g. diagnostics).
    pub fn append(&self, session_id: &str, kind: EventKind) -> anyhow::Result<()> {
        self.session(session_id)?.log().append(None, kind)?;
        Ok(())
    }

    /// Resolves the Workspace Folder: a new Worktree, a checkout, or the folder as is.
    async fn prepare_workspace(&self, id: &str, title: &str, folder: String, start: Start) -> anyhow::Result<(String, WorkspaceMeta)> {
        let folder = std::fs::canonicalize(&folder).map_err(|e| anyhow::anyhow!("{folder}: {e}"))?;
        let repo_root = crate::workspace::repo_root(&folder).await;
        let Some(root) = repo_root.clone() else {
            anyhow::ensure!(
                matches!(start, Start::Branch { base: None, new_branch: None, worktree: false }),
                "{} is not in a git repository",
                folder.display()
            );
            return Ok((folder.display().to_string(), WorkspaceMeta::default()));
        };
        let repo_name = root.file_name().map(|n| n.to_owned()).unwrap_or_else(|| "repo".into());
        let dest = self.data_dir.join("worktrees").join(id).join(repo_name);
        let short = &id[id.len() - 6..];
        let rel = folder.strip_prefix(&root).unwrap_or(Path::new("")).to_owned();
        let in_worktree = |wt: WorktreeMeta, pr: Option<u32>| {
            (dest.join(&rel).display().to_string(), WorkspaceMeta { repo_root: Some(dest.clone()), worktree: Some(wt), base: None, pr, branch_pr: None })
        };
        match start {
            Start::Pr { pr, worktree: true } => {
                if let Some(parent) = dest.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                crate::workspace::git(&root, &["worktree", "add", "--detach", &dest.display().to_string()]).await?;
                let fallback = format!("harness/pr-{}-{short}", pr.number);
                let branch = match crate::github::checkout_pr(&dest, pr.number, &fallback).await {
                    Ok(b) => b,
                    Err(e) => {
                        let _ = crate::workspace::git(&root, &["worktree", "remove", "--force", &dest.display().to_string()]).await;
                        return Err(e);
                    }
                };
                Ok(in_worktree(WorktreeMeta { repo_root: root, path: dest.clone(), branch, base: pr.base }, Some(pr.number)))
            }
            Start::Pr { pr, worktree: false } => {
                anyhow::ensure!(!crate::workspace::is_dirty(&root).await?, "the folder has uncommitted changes; commit or stash them, or use a Worktree");
                crate::github::checkout_pr(&root, pr.number, &format!("harness/pr-{}-{short}", pr.number)).await?;
                Ok((folder.display().to_string(), WorkspaceMeta { repo_root, worktree: None, base: Some(pr.base), pr: Some(pr.number), branch_pr: None }))
            }
            Start::Branch { base, new_branch, worktree: true } => {
                let wt = crate::workspace::create_worktree(&root, base, new_branch, &dest, &crate::workspace::slug(title), short).await?;
                Ok(in_worktree(wt, None))
            }
            Start::Branch { base, new_branch, worktree: false } => {
                if let Some(nb) = new_branch {
                    crate::workspace::create_branch(&root, &nb, base.as_deref()).await?;
                } else if let Some(b) = base
                    && crate::workspace::current_branch(&root).await?.as_deref() != Some(b.as_str())
                {
                    crate::workspace::checkout(&root, &b).await?;
                }
                Ok((folder.display().to_string(), WorkspaceMeta { repo_root, worktree: None, base: None, pr: None, branch_pr: None }))
            }
        }
    }

    fn session(&self, id: &str) -> anyhow::Result<Arc<Session>> {
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

fn folder_name(folder: &str) -> String {
    std::path::Path::new(folder).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| folder.to_owned())
}

/// Where a new Session's work starts.
enum Start {
    Pr { pr: crate::api::PullRequest, worktree: bool },
    Branch { base: Option<String>, new_branch: Option<String>, worktree: bool },
}
