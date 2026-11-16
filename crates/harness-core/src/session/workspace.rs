//! A Session's Workspace: git, archive and delete, the PR watch, and the panels directory.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::Session;
use super::meta::{BranchPrMeta, PrStatusMeta, SessionMeta};
use super::shared::Shared;
use crate::api::{EventKind, GitActor};

/// The PR a Session shows: the one it started from, else the stored one of the branch checked out.
pub(super) fn shown_pr(pr: Option<u32>, branch_pr: Option<&BranchPrMeta>, head: Option<&str>) -> Option<u32> {
    pr.or_else(|| branch_pr.filter(|b| head == Some(b.branch.as_str())).map(|b| b.number))
}

/// What opening a PR for the Session's branch comes to (`Session::pr_plan`).
#[derive(Debug, Clone)]
pub enum PrPlan {
    /// An open PR of the branch exists.
    Existing {
        pr: crate::api::PrInfo,
        branch: String,
    },
    New {
        repo: crate::api::RepoId,
        branch: String,
        head: String,
        base: String,
    },
}

/// Owned handle on what finding a Session's branch PR needs, so a spawned task can use it.
#[derive(Clone)]
pub struct PrWatch {
    meta: Arc<parking_lot::Mutex<SessionMeta>>,
    disk: Arc<super::meta::MetaDisk>,
    shared: Arc<Shared>,
}

impl PrWatch {
    /// Stores the PR of a branch; tells the windows when it changed.
    fn set(&self, branch_pr: Option<BranchPrMeta>) {
        let stored = {
            let mut m = self.meta.lock();
            if m.workspace.branch_pr == branch_pr {
                return;
            }
            m.workspace.branch_pr = branch_pr;
            self.disk.snapshot(&m)
        };
        if let Ok((bytes, version)) = stored {
            let _ = self.disk.write(&bytes, version);
        }
        self.shared.app_events.emit(crate::api::AppEvent::SessionsChanged);
    }

    /// Stores the state and checks of one of the Session's PRs; tells the windows when they changed.
    pub fn note(&self, pr: &crate::api::PrInfo) {
        let status = Some(PrStatusMeta { number: pr.number, state: pr.state, checks: pr.checks });
        let stored = {
            let mut m = self.meta.lock();
            if m.workspace.pr_status == status {
                return;
            }
            m.workspace.pr_status = status;
            self.disk.snapshot(&m)
        };
        if let Ok((bytes, version)) = stored {
            let _ = self.disk.write(&bytes, version);
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
        let head = crate::git::head_branch(Path::new(&m.folder));
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
        let Some(branch) = crate::git::head_branch(Path::new(&m.folder)) else { return };
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
        if let Some(root) = crate::git::find_repo_root(&folder) {
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

    /// The branch a PR of this Session targets: the Worktree's base, else a PR's, else the repository's default branch.
    pub async fn pr_base(&self) -> Option<String> {
        if let Some(b) = self.base() {
            return Some(b);
        }
        let folder = self.meta().folder;
        crate::git::default_branch(Path::new(&folder)).await.map(|b| b.strip_prefix("origin/").unwrap_or(&b).to_owned())
    }

    fn folder(&self) -> anyhow::Result<PathBuf> {
        self.adopt_repo();
        let m = self.meta.lock();
        if m.workspace.repo_root.is_none() {
            return Err(crate::error::invalid("the Workspace is not a git repository"));
        }
        Ok(PathBuf::from(&m.folder))
    }

    pub async fn git_status(&self) -> anyhow::Result<crate::api::GitStatus> {
        crate::git::status(&self.folder()?).await
    }

    pub async fn git_diff(&self, from: Option<String>, to: Option<String>) -> anyhow::Result<crate::api::Diff> {
        let folder = self.folder()?;
        let base = self.base();
        let from = match from {
            Some(f) => f,
            None => crate::git::diff_base(&folder, base.as_deref()).await?,
        };
        let to = match to {
            Some(t) => t,
            None => crate::git::snapshot(&folder).await?,
        };
        crate::git::diff(&folder, &from, &to).await
    }

    pub async fn git_log(&self) -> anyhow::Result<Vec<crate::api::Commit>> {
        let folder = self.folder()?;
        let base = self.base();
        let base = crate::git::diff_base(&folder, base.as_deref()).await?;
        crate::git::log(&folder, &base).await
    }

    pub async fn git_show_file(&self, rev: &str, path: &str) -> anyhow::Result<String> {
        crate::git::show_file(&self.folder()?, rev, path).await
    }

    pub async fn git_commit(&self, message: String, by: GitActor) -> anyhow::Result<String> {
        let commit = crate::git::commit(&self.folder()?, &message).await?;
        self.log.append(None, EventKind::GitCommitted { commit: commit.clone(), message, by })?;
        Ok(commit)
    }

    pub async fn git_push(&self, by: GitActor) -> anyhow::Result<String> {
        let branch = crate::git::push(&self.folder()?).await?;
        self.log.append(None, EventKind::GitPushed { branch: branch.clone(), by })?;
        Ok(branch)
    }

    /// Checks that a PR can be opened for the branch checked out, before the user is asked: an open PR of the
    /// branch is returned as is; else the branch must be pushed (nothing ahead of its upstream) and not the base.
    pub async fn pr_plan(&self, base: Option<String>) -> anyhow::Result<PrPlan> {
        let folder = self.folder()?;
        let branch = crate::git::current_branch(&folder).await?.ok_or_else(|| crate::error::invalid("HEAD is detached: no branch to open a PR from"))?;
        let base = match base.filter(|b| !b.trim().is_empty()) {
            Some(b) => b,
            None => self.pr_base().await.ok_or_else(|| crate::error::invalid("no base branch found: pass `base`"))?,
        };
        if branch == base {
            return Err(crate::error::invalid(format!("head equals base: `{branch}` is the base branch, work on another branch first")));
        }
        let repo_folder = self.meta().repo_folder().unwrap_or_else(|| folder.clone());
        let repo =
            self.shared.pr_refs.repo_of(&repo_folder).await.ok_or_else(|| crate::error::invalid(format!("{} has no GitHub remote", folder.display())))?;
        if let Some(pr) =
            self.shared.pr_refs.for_branch(&repo, &branch).await?.filter(|p| matches!(p.state, crate::api::PrState::Open | crate::api::PrState::Draft))
        {
            return Ok(PrPlan::Existing { pr, branch });
        }
        let status = crate::git::status(&folder).await?;
        if status.upstream.is_none() {
            return Err(crate::error::invalid(format!("branch `{branch}` is not pushed: push first with git_push")));
        }
        if status.ahead > 0 {
            return Err(crate::error::invalid(format!("branch `{branch}` has {} commit(s) not pushed: push first with git_push", status.ahead)));
        }
        // A branch pushed to a fork (origin) while PRs go to the upstream repo: the head is `owner:branch`.
        let head = match crate::github::remote_repo(&folder, "origin").await {
            Some(o) if !o.owner.eq_ignore_ascii_case(&repo.owner) || !o.name.eq_ignore_ascii_case(&repo.name) => format!("{}:{branch}", o.owner),
            _ => branch.clone(),
        };
        Ok(PrPlan::New { repo, branch, head, base })
    }

    /// Opens the PR a `pr_plan` found possible, and refreshes the stored PR of the branch so the header shows it.
    pub async fn pr_create(&self, plan: &PrPlan, title: &str, body: &str, draft: bool) -> anyhow::Result<crate::github::CreatedPr> {
        let PrPlan::New { repo, branch, head, base } = plan else { anyhow::bail!("a PR is already open") };
        let created = crate::github::create_pr(&self.folder()?, repo, head, base, title, body, draft).await?;
        let _ = self.pr_watch().lookup(repo, branch).await;
        Ok(created)
    }

    pub async fn archive(self: &Arc<Self>) -> anyhow::Result<()> {
        if self.meta().archived {
            return Err(crate::error::conflict("already archived"));
        }
        self.stop_processes("archived");
        if let Some(wt) = self.meta().workspace.worktree {
            if wt.path.exists() && crate::git::is_dirty(&wt.path).await? {
                crate::git::wip_commit(&wt.path).await?;
            }
            crate::git::remove_worktree(&wt).await?;
        }
        self.update_meta(|m| m.archived = true)?;
        self.shared.app_events.emit(crate::api::AppEvent::SessionsChanged);
        // The Session is archived by now: a log that cannot be written is reported, not an error here.
        self.log.append_or_report(None, EventKind::SessionArchived { archived: true });
        self.sync_log().await;
        Ok(())
    }

    pub async fn unarchive(self: &Arc<Self>) -> anyhow::Result<()> {
        if !self.meta().archived {
            return Err(crate::error::conflict("not archived"));
        }
        if let Some(wt) = self.meta().workspace.worktree {
            crate::git::restore_worktree(&wt).await?;
        }
        self.update_meta(|m| m.archived = false)?;
        self.shared.app_events.emit(crate::api::AppEvent::SessionsChanged);
        self.log.append_or_report(None, EventKind::SessionArchived { archived: false });
        self.sync_log().await;
        Ok(())
    }

    /// Removes the Worktree and its branch; the caller removes the Session Directory.
    pub async fn delete_workspace(&self, force: bool) -> anyhow::Result<()> {
        if let Some(wt) = self.meta().workspace.worktree {
            if !force {
                if wt.path.exists() && crate::git::is_dirty(&wt.path).await? {
                    return Err(crate::error::conflict("the Worktree has uncommitted changes"));
                }
                let n = crate::git::unmerged_count(&wt.repo_root, &wt.base, &wt.branch).await?;
                if n != 0 {
                    return Err(crate::error::conflict(format!("branch {} has {n} commit(s) not on {}", wt.branch, wt.base)));
                }
            }
            self.stop_processes("deleted");
            crate::git::remove_worktree(&wt).await?;
            crate::git::delete_branch(&wt.repo_root, &wt.branch).await?;
            if let Some(parent) = wt.path.parent() {
                let _ = std::fs::remove_dir(parent);
            }
        } else {
            self.stop_processes("deleted");
        }
        Ok(())
    }

    pub fn pr_watch(&self) -> PrWatch {
        PrWatch { meta: self.meta.clone(), disk: self.meta_disk.clone(), shared: self.shared.clone() }
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
