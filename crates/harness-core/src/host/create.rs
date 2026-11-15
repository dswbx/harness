//! Creating Sessions: `create_session` and the Workspace it needs, and Quick Sessions.

use std::path::Path;
use std::sync::Arc;

use crate::api::*;
use crate::host::Harness;
use crate::session::{Session, WorkspaceMeta};
use crate::workspace::WorktreeMeta;

impl Harness {
    /// Creates a Session (Command `CreateSession`, or a Sub Session). The caller tells the windows
    /// (`SessionsChanged`).
    pub(crate) async fn create_session(&self, spec: NewSession) -> anyhow::Result<Arc<Session>> {
        // The Harness MCP (a Sub Session) comes here without passing `execute`.
        if self.shared.closing.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(crate::error::unavailable("the Harness is shutting down"));
        }
        let NewSession { folder, agent_id, frontend_id, title, branch, worktree, new_branch, pr, mcp_servers, parent, initial_config } = spec;
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
        if parent.is_some() || !initial_config.is_empty() {
            session.update_meta(|m| {
                m.parent = parent;
                m.initial_config = initial_config;
            })?;
        }
        if let Some(folder) = session.meta().repo_folder() {
            let shared = self.shared.clone();
            tokio::spawn(async move { shared.pr_refs.repo_of(&folder).await });
        }
        let session = Arc::new(session);
        self.sessions.write().insert(id, session.clone());
        Ok(session)
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
        let base = crate::workspace::worktree_base(&root, &crate::workspace::worktree_dir(&self.data_dir));
        let dest = base.join(id).join(repo_name);
        if matches!(start, Start::Pr { worktree: true, .. } | Start::Branch { worktree: true, .. })
            && let Err(e) = crate::workspace::exclude_in_repo(&root, &base).await
        {
            tracing::warn!("could not exclude {} from git: {e:#}", base.display());
        }
        let short = &id[id.len() - 6..];
        let rel = folder.strip_prefix(&root).unwrap_or(Path::new("")).to_owned();
        let in_worktree = |wt: WorktreeMeta, pr: Option<u32>| {
            (
                dest.join(&rel).display().to_string(),
                WorkspaceMeta { repo_root: Some(dest.clone()), worktree: Some(wt), base: None, pr, branch_pr: None, pr_status: None },
            )
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
                Ok((
                    folder.display().to_string(),
                    WorkspaceMeta { repo_root, worktree: None, base: Some(pr.base), pr: Some(pr.number), branch_pr: None, pr_status: None },
                ))
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
                Ok((folder.display().to_string(), WorkspaceMeta { repo_root, worktree: None, base: None, pr: None, branch_pr: None, pr_status: None }))
            }
        }
    }

    #[allow(clippy::too_many_arguments, reason = "the fields of Command::CreateSession")]
    pub(in crate::host) async fn cmd_create_session(
        &self,
        folder: String,
        agent_id: String,
        frontend_id: String,
        title: Option<String>,
        branch: Option<String>,
        worktree: bool,
        new_branch: Option<String>,
        pr: Option<u32>,
        mcp_servers: Vec<String>,
    ) -> anyhow::Result<CommandResult> {
        let spec = NewSession {
            folder,
            agent_id,
            frontend_id,
            title,
            branch,
            worktree,
            new_branch,
            pr,
            mcp_servers,
            parent: None,
            initial_config: Default::default(),
        };
        Ok(CommandResult::SessionCreated { session_id: self.create_session(spec).await?.id() })
    }

    pub(in crate::host) async fn cmd_create_quick_session(
        &self,
        agent_id: String,
        frontend_id: String,
        title: Option<String>,
        mcp_servers: Vec<String>,
    ) -> anyhow::Result<CommandResult> {
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
        Ok(CommandResult::SessionCreated { session_id: id })
    }
}

fn folder_name(folder: &str) -> String {
    std::path::Path::new(folder).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| folder.to_owned())
}

/// What `create_session` needs: the fields of `Command::CreateSession`, plus a Sub Session's
/// parent and starting config.
pub(crate) struct NewSession {
    pub folder: String,
    pub agent_id: String,
    pub frontend_id: String,
    pub title: Option<String>,
    pub branch: Option<String>,
    pub worktree: bool,
    pub new_branch: Option<String>,
    pub pr: Option<u32>,
    pub mcp_servers: Vec<String>,
    pub parent: Option<crate::api::SessionParent>,
    pub initial_config: std::collections::BTreeMap<String, String>,
}

/// Where a new Session's work starts.
enum Start {
    Pr { pr: crate::api::PullRequest, worktree: bool },
    Branch { base: Option<String>, new_branch: Option<String>, worktree: bool },
}
