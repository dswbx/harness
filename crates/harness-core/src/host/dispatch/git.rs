//! Commands: git.

use std::path::{Path, PathBuf};

use crate::api::*;
use crate::host::Harness;

impl Harness {
    pub(in crate::host) async fn cmd_list_branches(&self, folder: String) -> anyhow::Result<CommandResult> {
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
        Ok(CommandResult::Branches { branches })
    }

    pub(in crate::host) async fn cmd_list_pull_requests(&self, folder: String, filter: PrFilter) -> anyhow::Result<CommandResult> {
        Ok(CommandResult::PullRequests { prs: crate::github::list_prs(Path::new(&folder), filter).await? })
    }

    pub(in crate::host) async fn cmd_update_branch(&self, folder: String, branch: String) -> anyhow::Result<CommandResult> {
        crate::workspace::update_branch(Path::new(&folder), &branch).await?;
        Ok(CommandResult::Ok)
    }

    pub(in crate::host) async fn cmd_branch_pr(&self, session_id: SessionId, refresh: bool) -> anyhow::Result<CommandResult> {
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
        if let Some(p) = &pr {
            session.pr_watch().note(p);
        }
        let base = match meta.workspace.worktree.as_ref().map(|w| w.base.clone()).or_else(|| meta.workspace.base.clone()) {
            Some(b) => Some(b),
            None => crate::workspace::default_branch(Path::new(&meta.folder)).await.map(|b| b.strip_prefix("origin/").unwrap_or(&b).to_owned()),
        };
        Ok(CommandResult::BranchPr { repo, pr, base })
    }

    pub(in crate::host) async fn cmd_git_status(&self, session_id: SessionId) -> anyhow::Result<CommandResult> {
        Ok(CommandResult::GitStatus { status: self.session(&session_id)?.git_status().await? })
    }

    pub(in crate::host) async fn cmd_pr_context(&self, session_id: SessionId) -> anyhow::Result<CommandResult> {
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
        Ok(CommandResult::PrContext { session_repo, known_repos: refs.known_repos(&folders, crate::log::now_ms()), me })
    }

    pub(in crate::host) async fn cmd_lookup_prs(&self, session_id: SessionId, refs: Vec<PrRefKey>) -> anyhow::Result<CommandResult> {
        self.session(&session_id)?;
        Ok(CommandResult::PrLookup { prs: self.shared.pr_refs.lookup(refs).await? })
    }

    pub(in crate::host) async fn cmd_search_prs(&self, session_id: SessionId, repo: RepoId, query: Option<String>) -> anyhow::Result<CommandResult> {
        self.session(&session_id)?;
        Ok(CommandResult::PrSearch { prs: self.shared.pr_refs.search(&repo, query.as_deref()).await? })
    }

    pub(in crate::host) async fn cmd_git_diff(&self, session_id: SessionId, from: Option<String>, to: Option<String>) -> anyhow::Result<CommandResult> {
        Ok(CommandResult::Diff { diff: self.session(&session_id)?.git_diff(from, to).await? })
    }

    pub(in crate::host) async fn cmd_git_log(&self, session_id: SessionId) -> anyhow::Result<CommandResult> {
        Ok(CommandResult::GitLog { commits: self.session(&session_id)?.git_log().await? })
    }

    pub(in crate::host) async fn cmd_git_show_file(&self, session_id: SessionId, rev: String, path: String) -> anyhow::Result<CommandResult> {
        Ok(CommandResult::FileContent { content: self.session(&session_id)?.git_show_file(&rev, &path).await? })
    }

    pub(in crate::host) async fn cmd_git_commit(&self, session_id: SessionId, message: String) -> anyhow::Result<CommandResult> {
        Ok(CommandResult::Committed { commit: self.session(&session_id)?.git_commit(message, GitActor::User).await? })
    }

    pub(in crate::host) async fn cmd_git_push(&self, session_id: SessionId) -> anyhow::Result<CommandResult> {
        self.session(&session_id)?.git_push(GitActor::User).await?;
        Ok(CommandResult::Ok)
    }
}
