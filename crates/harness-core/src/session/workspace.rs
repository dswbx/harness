//! A Session's Workspace: git, archive and delete, the PR watch, and the panels directory.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::Session;
use super::meta::{BranchPrMeta, PrStatusMeta, SessionMeta, write_meta};
use super::shared::Shared;
use crate::api::{EventKind, GitActor};

/// The PR a Session shows: the one it started from, else the stored one of the branch checked out.
pub(super) fn shown_pr(pr: Option<u32>, branch_pr: Option<&BranchPrMeta>, head: Option<&str>) -> Option<u32> {
    pr.or_else(|| branch_pr.filter(|b| head == Some(b.branch.as_str())).map(|b| b.number))
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

    /// Stores the state and checks of one of the Session's PRs; tells the windows when they changed.
    pub fn note(&self, pr: &crate::api::PrInfo) {
        let status = Some(PrStatusMeta { number: pr.number, state: pr.state, checks: pr.checks });
        {
            let mut m = self.meta.lock();
            if m.workspace.pr_status == status {
                return;
            }
            m.workspace.pr_status = status;
            let _ = write_meta(&self.dir, &m);
        }
        self.shared.app_events.emit(crate::api::AppEvent::SessionsChanged);
    }

    /// Looks up the PR of `branch` and stores it. An error leaves the stored PR alone.
    pub async fn lookup(&self, repo: &crate::api::RepoId, branch: &str) -> anyhow::Result<Option<crate::api::PrInfo>> {
        let pr = self.shared.pr_refs.for_branch(repo, branch).await?;
        self.set(pr.as_ref().map(|p| BranchPrMeta { branch: branch.to_owned(), number: p.number }));
        if let Some(p) = &pr {
            self.note(p);
        }
        Ok(pr)
    }

    /// The repository folder and number of the PR the Session shows, if any.
    pub fn shown(&self) -> Option<(PathBuf, u32)> {
        let m = self.meta.lock();
        let folder = m.repo_folder()?;
        let head = crate::workspace::head_branch(Path::new(&m.folder));
        Some((folder, shown_pr(m.workspace.pr, m.workspace.branch_pr.as_ref(), head.as_deref())?))
    }

    /// For a Session that may have opened a PR: looks up the PR of its branch (or the PR it started from), ignoring
    /// errors.
    pub(super) async fn find(&self) {
        let m = self.meta.lock().clone();
        if let Some(number) = m.workspace.pr {
            let Some(folder) = m.repo_folder() else { return };
            let Some(repo) = self.shared.pr_refs.repo_of(&folder).await else { return };
            if let Ok(prs) = self.shared.pr_refs.lookup(vec![crate::api::PrRefKey { repo, number }]).await
                && let Some(Some(pr)) = prs.first()
            {
                self.note(pr);
            }
            return;
        }
        let Some(folder) = m.repo_folder() else { return };
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

impl Session {
    /// A folder can become a repository after the Session started (`git init`, by the Agent or
    /// in the terminal), so a Session with no repository looks again each time it is asked.
    pub(super) fn adopt_repo(&self) {
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

    /// Where the Agent writes the `.md`/`.html`/`.json` files of file-backed panels (ADR 0023); made on first use for
    /// Sessions from before it existed.
    pub fn panels_dir(&self) -> PathBuf {
        let dir = self.dir.join(crate::panels::DIR);
        if !dir.exists() {
            let _ = std::fs::create_dir_all(&dir);
        }
        dir
    }

    /// A panel source file's text and hash. Starts watching `panels/` so windows hear of changes
    /// (`PanelSourceChanged`); when the watch fails they still re-read on focus.
    pub fn panel_source_read(&self, name: &str) -> anyhow::Result<(String, String)> {
        let dir = self.panels_dir();
        let read = crate::panels::read(&dir, name);
        let mut watch = self.panels_watch.lock();
        if watch.is_none() {
            let shared = self.shared.clone();
            let session_id = self.id();
            let emit = move |name: String| shared.app_events.emit(crate::api::AppEvent::PanelSourceChanged { session_id: session_id.clone(), name });
            match crate::panels::watch(&dir, crate::panels::DEBOUNCE, emit) {
                Ok(w) => *watch = Some(w),
                Err(e) => tracing::warn!("watching {}: {e:#}", dir.display()),
            }
        }
        read
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

    pub fn pr_watch(&self) -> PrWatch {
        PrWatch { dir: self.dir.clone(), meta: self.meta.clone(), shared: self.shared.clone() }
    }
}

#[cfg(test)]
mod branch_pr_tests {
    use super::*;
    use crate::session::WorkspaceMeta;

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
