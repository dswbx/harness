//! The Harness entry point: owns Sessions and dispatches Commands.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use crate::api::{
    AgentInfo, AppEvent, Command, CommandResult, EventKind, EventSink, FrontendManifest, SessionId,
    SessionSummary,
};
use crate::log::SubscriptionId;
use crate::permissions::Policy;
use crate::session::{Session, Shared, WorkspaceMeta};

/// Default for `Shared::idle_timeout`.
pub const IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15 * 60);

pub struct Options {
    pub idle_timeout: std::time::Duration,
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
        let shared = Arc::new(Shared {
            policy: Policy::open(data_dir.join("permissions.json"))?,
            idle_timeout: options.idle_timeout,
            agents: crate::agents::Agents::open(&data_dir, options.registry_url, agents)?,
            frontends: RwLock::new(Vec::new()),
            mcp: Default::default(),
            library: crate::library::Library::open(data_dir.join("mcp.json"), options.secrets)?,
            mcp_shim: options.mcp_shim,
            app_events: Default::default(),
        });
        let mut sessions = HashMap::new();
        for entry in std::fs::read_dir(&sessions_dir)? {
            let dir = entry?.path();
            match Session::open(&dir, shared.clone()) {
                Ok(s) => {
                    sessions.insert(s.id().clone(), Arc::new(s));
                }
                Err(e) => tracing::warn!("skipping session {}: {e:#}", dir.display()),
            }
        }
        Ok(Arc::new(Self {
            data_dir,
            shared,
            sessions: RwLock::new(sessions),
        }))
    }

    /// URL of the Harness MCP (starts it). For diagnostics and tests.
    pub async fn mcp_url(&self) -> anyhow::Result<String> {
        self.shared.mcp.url().await
    }

    pub fn register_frontend(&self, manifest: FrontendManifest) {
        let mut frontends = self.shared.frontends.write().unwrap();
        frontends.retain(|f| f.id != manifest.id);
        frontends.push(manifest);
    }

    pub async fn execute(&self, cmd: Command) -> Result<CommandResult, String> {
        let changes = match &cmd {
            Command::CreateSession { .. } | Command::DeleteSession { .. } => Some(AppEvent::SessionsChanged),
            Command::InstallAgent { .. } | Command::AddCustomAgent { .. } | Command::RemoveAgent { .. } => {
                Some(AppEvent::AgentsChanged)
            }
            _ => None,
        };
        let result = self.execute_inner(cmd).await.map_err(|e| format!("{e:#}"));
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

    async fn execute_inner(&self, cmd: Command) -> anyhow::Result<CommandResult> {
        Ok(match cmd {
            Command::ListAgents => CommandResult::Agents { agents: self.shared.agents.list() },
            Command::ListRegistry { refresh } => {
                CommandResult::Registry { agents: self.shared.agents.registry(refresh).await? }
            }
            Command::InstallAgent { registry_id } => {
                CommandResult::AgentInstalled { agent: self.shared.agents.install(&registry_id).await? }
            }
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
            Command::ListFrontends => {
                CommandResult::Frontends { frontends: self.shared.frontends.read().unwrap().clone() }
            }
            Command::ListSessions => {
                let mut sessions: Vec<SessionSummary> =
                    self.sessions.read().unwrap().values().map(|s| s.summary()).collect();
                sessions.sort_by_key(|s| std::cmp::Reverse(s.created_ms));
                CommandResult::Sessions { sessions }
            }
            Command::CreateSession { folder, agent_id, frontend_id, title, branch, worktree, mcp_servers } => {
                let agent = self.agent(&agent_id)?;
                anyhow::ensure!(
                    self.shared.frontends.read().unwrap().iter().any(|f| f.id == frontend_id),
                    "unknown frontend {frontend_id}"
                );
                let id = uuid::Uuid::now_v7().to_string();
                let dir = self.data_dir.join("sessions").join(&id);
                let title = title.unwrap_or_else(|| folder_name(&folder));
                let (folder, workspace) = self.prepare_workspace(&id, &title, folder, branch, worktree).await?;
                for m in &mcp_servers {
                    self.shared.library.resolve(m)?;
                }
                let session = Session::create(
                    &dir,
                    id.clone(),
                    title,
                    folder,
                    agent,
                    frontend_id,
                    workspace,
                    mcp_servers,
                    self.shared.clone(),
                )?;
                self.sessions.write().unwrap().insert(id.clone(), Arc::new(session));
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
            Command::ContinueWithSummary { session_id, thread_id, text } => {
                self.session(&session_id)?.continue_with_summary(thread_id, text).await?;
                CommandResult::Ok
            }
            Command::StartSideThread { session_id, seed } => {
                CommandResult::ThreadStarted { thread_id: self.session(&session_id)?.start_side_thread(seed)? }
            }
            Command::ListMcpServers => CommandResult::McpServers { servers: self.shared.library.list() },
            Command::SaveMcpServer { server, secrets } => {
                CommandResult::McpServerSaved { server: self.shared.library.save(server, secrets)? }
            }
            Command::RemoveMcpServer { server_id } => {
                self.shared.library.remove(&server_id)?;
                CommandResult::Ok
            }
            Command::FrontendRead { session_id, path } => {
                CommandResult::FileContent { content: self.session(&session_id)?.frontend_read(&path)? }
            }
            Command::FrontendWrite { session_id, path, content } => {
                self.session(&session_id)?.frontend_write(&path, &content)?;
                CommandResult::Ok
            }
            Command::FrontendList { session_id, dir } => {
                CommandResult::Files { files: self.session(&session_id)?.frontend_list(&dir)? }
            }
            Command::ListBranches { folder } => {
                CommandResult::Branches { branches: crate::workspace::list_branches(Path::new(&folder)).await? }
            }
            Command::ArchiveSession { session_id } => {
                self.session(&session_id)?.archive().await?;
                CommandResult::Ok
            }
            Command::UnarchiveSession { session_id } => {
                self.session(&session_id)?.unarchive().await?;
                CommandResult::Ok
            }
            Command::DeleteSession { session_id, force } => {
                let session = self.session(&session_id)?;
                session.delete_workspace(force).await?;
                self.sessions.write().unwrap().remove(&session_id);
                std::fs::remove_dir_all(session.dir())?;
                self.shared.policy.forget_session(&session_id)?;
                CommandResult::Ok
            }
            Command::GitStatus { session_id } => {
                CommandResult::GitStatus { status: self.session(&session_id)?.git_status().await? }
            }
            Command::GitDiff { session_id, from, to } => {
                CommandResult::Diff { diff: self.session(&session_id)?.git_diff(from, to).await? }
            }
            Command::GitLog { session_id } => {
                CommandResult::GitLog { commits: self.session(&session_id)?.git_log().await? }
            }
            Command::GitShowFile { session_id, rev, path } => {
                CommandResult::FileContent { content: self.session(&session_id)?.git_show_file(&rev, &path).await? }
            }
            Command::GitCommit { session_id, message } => {
                CommandResult::Committed { commit: self.session(&session_id)?.git_commit(message).await? }
            }
            Command::GitPush { session_id } => {
                self.session(&session_id)?.git_push().await?;
                CommandResult::Ok
            }
            Command::ResolvePermission { session_id, request_id, option_id } => {
                self.session(&session_id)?.resolve_permission(&request_id, option_id)?;
                CommandResult::Ok
            }
            Command::ListPermissionRules => CommandResult::PermissionRules { rules: self.shared.policy.list() },
            Command::AddPermissionRule { rule } => {
                CommandResult::PermissionRuleAdded { rule: self.shared.policy.add(rule)? }
            }
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

    pub fn subscribe_session(
        &self,
        session_id: &str,
        from_seq: u64,
        sink: Box<dyn EventSink>,
    ) -> Result<SubscriptionId, String> {
        let session = self.session(session_id).map_err(|e| e.to_string())?;
        session.log().subscribe(from_seq, sink).map_err(|e| format!("{e:#}"))
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
    async fn prepare_workspace(
        &self,
        id: &str,
        title: &str,
        folder: String,
        branch: Option<String>,
        worktree: bool,
    ) -> anyhow::Result<(String, WorkspaceMeta)> {
        let folder = std::fs::canonicalize(&folder).map_err(|e| anyhow::anyhow!("{folder}: {e}"))?;
        let repo_root = crate::workspace::repo_root(&folder).await;
        let Some(root) = repo_root.clone() else {
            anyhow::ensure!(!worktree && branch.is_none(), "{} is not in a git repository", folder.display());
            return Ok((folder.display().to_string(), WorkspaceMeta::default()));
        };
        if worktree {
            let repo_name = root.file_name().map(|n| n.to_owned()).unwrap_or_else(|| "repo".into());
            let dest = self.data_dir.join("worktrees").join(id).join(repo_name);
            let short = &id[id.len() - 6..];
            let wt = crate::workspace::create_worktree(&root, branch, &dest, &crate::workspace::slug(title), short).await?;
            let rel = folder.strip_prefix(&root).unwrap_or(Path::new(""));
            let work = dest.join(rel);
            return Ok((work.display().to_string(), WorkspaceMeta { repo_root: Some(dest), worktree: Some(wt) }));
        }
        if let Some(b) = branch
            && crate::workspace::current_branch(&root).await?.as_deref() != Some(b.as_str())
        {
            crate::workspace::checkout(&root, &b).await?;
        }
        Ok((folder.display().to_string(), WorkspaceMeta { repo_root, worktree: None }))
    }

    fn session(&self, id: &str) -> anyhow::Result<Arc<Session>> {
        self.sessions
            .read()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("unknown session {id}"))
    }

    fn agent(&self, id: &str) -> anyhow::Result<AgentInfo> {
        self.shared.agents.get(id).ok_or_else(|| anyhow::anyhow!("unknown agent {id}"))
    }
}

fn folder_name(folder: &str) -> String {
    std::path::Path::new(folder)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| folder.to_owned())
}
