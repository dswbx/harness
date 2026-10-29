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
    #[serde(default)]
    pub workspace: WorkspaceMeta,
    #[serde(default)]
    pub archived: bool,
    /// MCP Library servers given to the Agent.
    #[serde(default)]
    pub mcp_servers: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WorkspaceMeta {
    /// Repository containing the Workspace Folder, if any.
    pub repo_root: Option<PathBuf>,
    pub worktree: Option<crate::workspace::WorktreeMeta>,
}

pub struct Session {
    dir: PathBuf,
    meta: std::sync::Mutex<SessionMeta>,
    log: SessionLog,
    agent: crate::acp::AgentSlot,
    shared: Arc<Shared>,
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
            workspace,
            archived: false,
            mcp_servers,
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
        })?;
        log.sync()?;
        Ok(Self::from_parts(dir, meta, log, shared))
    }

    pub fn open(dir: &Path, shared: Arc<Shared>) -> anyhow::Result<Self> {
        let meta: SessionMeta = serde_json::from_slice(&std::fs::read(dir.join("session.json"))?)?;
        let log = SessionLog::open(meta.id.clone(), &dir.join("log.jsonl"))?;
        Ok(Self::from_parts(dir, meta, log, shared))
    }

    fn from_parts(dir: &Path, meta: SessionMeta, log: SessionLog, shared: Arc<Shared>) -> Self {
        Self { dir: dir.to_owned(), meta: std::sync::Mutex::new(meta), log, agent: Default::default(), shared }
    }

    pub fn policy(&self) -> &Policy {
        &self.shared.policy
    }

    pub fn shared(&self) -> &Shared {
        &self.shared
    }

    /// Frontend Tools of the Session's Frontend.
    pub fn frontend_tools(&self) -> Vec<crate::api::FrontendToolDecl> {
        let id = self.meta.lock().unwrap().frontend_id.clone();
        self.shared.frontends.read().unwrap().iter().find(|f| f.id == id).map(|f| f.frontend_tools.clone()).unwrap_or_default()
    }

    /// Stores a validated Frontend Tool call under `frontend/tools/<tool>/<call id>.json` and
    /// logs it. Returns the path relative to `frontend/`.
    pub fn write_frontend_tool_output(&self, thread: &ThreadId, tool: &str, input: serde_json::Value) -> anyhow::Result<String> {
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

    pub async fn prompt(self: &Arc<Self>, thread_id: Option<ThreadId>, text: String) -> anyhow::Result<()> {
        let thread = self.thread(thread_id)?;
        crate::acp::prompt(self.clone(), thread, text).await
    }

    pub async fn continue_with_summary(
        self: &Arc<Self>,
        thread_id: Option<ThreadId>,
        text: Option<String>,
    ) -> anyhow::Result<()> {
        let thread = self.thread(thread_id)?;
        crate::acp::continue_with_summary(self.clone(), thread.clone()).await?;
        if let Some(text) = text {
            crate::acp::prompt(self.clone(), thread, text).await?;
        }
        Ok(())
    }

    /// Starts the Agent and the Main Thread's Agent Session in the background (see `Command::WarmUp`).
    pub fn warm_up(self: &Arc<Self>) {
        let m = self.meta();
        if m.archived || m.read_only_threads.contains(&m.main_thread_id) {
            return;
        }
        let session = self.clone();
        tokio::spawn(async move {
            if let Err(e) = crate::acp::warm_up(session, m.main_thread_id).await {
                tracing::debug!("warm-up: {e:#}");
            }
        });
    }

    /// Opens a Side Thread; its Agent Session starts with the first prompt.
    pub fn start_side_thread(&self, seed: Option<String>) -> anyhow::Result<ThreadId> {
        let thread = uuid::Uuid::now_v7().to_string();
        let agent_id = self.update_meta(|m| {
            m.side_threads.push(thread.clone());
            if let Some(seed) = seed {
                m.seeds.insert(thread.clone(), seed);
            }
            m.agent.id.clone()
        })?;
        self.log.append(Some(thread.clone()), EventKind::ThreadStarted { agent_id, main: false })?;
        Ok(thread)
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
        let base = self.meta().workspace.worktree.map(|w| w.base);
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
