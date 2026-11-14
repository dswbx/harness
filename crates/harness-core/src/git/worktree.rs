//! Worktrees the Harness creates per Session, the Worktree folder setting, and branch moves.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::cmd::{current_branch, git, rev};
use super::diff::base_refs;

/// A Worktree the Harness created for one Session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorktreeMeta {
    pub repo_root: PathBuf,
    pub path: PathBuf,
    pub branch: String,
    /// Branch the Worktree was cut from; diffs and merge checks compare against it.
    pub base: String,
}

/// Creates `branch` (default `harness/<slug>-<short id>`) from `base` (default: the current
/// branch) at `path`. It starts from the freshly fetched origin copy of `base` when there is one
/// (the local branch may be stale), else from the local `base`. `WorktreeMeta.base` stays `base`.
pub async fn create_worktree(
    repo_root: &Path,
    base: Option<String>,
    branch: Option<String>,
    path: &Path,
    slug: &str,
    short_id: &str,
) -> anyhow::Result<WorktreeMeta> {
    let base = match base {
        Some(b) => rev(&b)?.to_owned(),
        None => current_branch(repo_root).await?.ok_or_else(|| anyhow::anyhow!("HEAD is detached; pick a base branch"))?,
    };
    let branch = branch.unwrap_or_else(|| format!("harness/{slug}-{short_id}"));
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let p = path.display().to_string();
    let start = worktree_start(repo_root, &base).await;
    // `--no-track`: the new branch must not get `origin/<base>` as its upstream.
    git(repo_root, &["worktree", "add", "--no-track", "-b", &branch, "--end-of-options", &p, &start]).await?;
    Ok(WorktreeMeta { repo_root: repo_root.to_owned(), path: path.to_owned(), branch, base })
}

/// Start point for a Worktree on `base`: its freshly fetched remote copy when there is one, else `base`.
/// A failed or slow fetch is logged and the last known remote ref is used.
async fn worktree_start(repo_root: &Path, base: &str) -> String {
    let remotes = git(repo_root, &["remote"]).await.unwrap_or_default();
    let tracking = match base.split_once('/') {
        Some((r, b))
            if remotes.lines().any(|l| l == r) && git(repo_root, &["rev-parse", "--verify", "--quiet", &format!("refs/remotes/{base}")]).await.is_ok() =>
        {
            Some((r, b))
        }
        _ => None,
    };
    let (remote, branch) = tracking.unwrap_or(("origin", base));
    let spec = format!("+refs/heads/{branch}:refs/remotes/{remote}/{branch}");
    let args = ["fetch", "--quiet", "--no-tags", remote, &spec];
    match tokio::time::timeout(std::time::Duration::from_secs(15), git(repo_root, &args)).await {
        Ok(Ok(_)) => {}
        Ok(Err(e)) => tracing::warn!("fetching {remote}/{branch} failed, using the last known copy: {e:#}"),
        Err(_) => tracing::warn!("fetching {remote}/{branch} timed out, using the last known copy"),
    }
    if tracking.is_some() {
        return base.to_owned();
    }
    let remote_ref = format!("refs/remotes/origin/{base}");
    if git(repo_root, &["rev-parse", "--verify", "--quiet", &remote_ref]).await.is_ok() { remote_ref } else { base.to_owned() }
}

/// Creates `branch` from `base` (default: HEAD) and switches the folder to it; uncommitted
/// changes come along.
pub async fn create_branch(dir: &Path, branch: &str, base: Option<&str>) -> anyhow::Result<()> {
    git(dir, &["check-ref-format", "--branch", branch]).await.map_err(|_| anyhow::anyhow!("{branch:?} is not a valid branch name"))?;
    let mut args = vec!["switch", "-c", branch];
    if let Some(base) = base {
        args.extend(["--end-of-options", rev(base)?]);
    }
    git(dir, &args).await?;
    Ok(())
}

/// Switches a plain folder to `branch`; refuses when the working tree has changes.
pub async fn checkout(dir: &Path, branch: &str) -> anyhow::Result<()> {
    anyhow::ensure!(
        git(dir, &["status", "--porcelain"]).await?.trim().is_empty(),
        "the folder has uncommitted changes; commit or stash them, or use a Worktree"
    );
    git(dir, &["checkout", "--end-of-options", rev(branch)?]).await?;
    Ok(())
}

pub async fn remove_worktree(wt: &WorktreeMeta) -> anyhow::Result<()> {
    if wt.path.exists() {
        git(&wt.repo_root, &["worktree", "remove", "--force", &wt.path.display().to_string()]).await?;
    }
    git(&wt.repo_root, &["worktree", "prune"]).await?;
    // The Session's `<base>/<id>` folder, when now empty.
    if let Some(parent) = wt.path.parent() {
        let _ = std::fs::remove_dir(parent);
    }
    Ok(())
}

/// Where new Worktrees go when not set: a folder in the repository.
pub const DEFAULT_WORKTREE_DIR: &str = ".harness";

/// The Worktree folder setting (`<data dir>/worktree_dir.json`), else `DEFAULT_WORKTREE_DIR`.
pub fn worktree_dir(data_dir: &Path) -> String {
    std::fs::read(data_dir.join("worktree_dir.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<String>(&b).ok())
        .filter(|d| !d.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_WORKTREE_DIR.to_owned())
}

pub fn set_worktree_dir(data_dir: &Path, dir: Option<&str>) -> anyhow::Result<()> {
    let path = data_dir.join("worktree_dir.json");
    match dir.map(str::trim).filter(|d| !d.is_empty() && *d != DEFAULT_WORKTREE_DIR) {
        Some(d) => crate::fsutil::write_atomic(&path, &serde_json::to_vec(d)?)?,
        None => {
            let _ = std::fs::remove_file(path);
        }
    }
    Ok(())
}

/// The folder for new Worktrees of the repository at `root`: `dir` relative to `root`, or
/// absolute (`~` is the home folder). Each Worktree goes in `<base>/<session id>/<repo name>`.
pub fn worktree_base(root: &Path, dir: &str) -> PathBuf {
    let dir = dir.trim();
    if (dir == "~" || dir.starts_with("~/"))
        && let Some(home) = std::env::var_os("HOME")
    {
        return PathBuf::from(home).join(dir[1..].trim_start_matches('/'));
    }
    root.join(dir)
}

/// Keeps Worktrees inside the repository out of its status: adds `/<base>/` to `info/exclude`.
pub async fn exclude_in_repo(root: &Path, base: &Path) -> anyhow::Result<()> {
    let Ok(rel) = base.strip_prefix(root) else { return Ok(()) };
    if rel.as_os_str().is_empty() {
        return Ok(());
    }
    let common = git(root, &["rev-parse", "--path-format=absolute", "--git-common-dir"]).await?;
    let file = PathBuf::from(common.trim()).join("info").join("exclude");
    let line = format!("/{}/", rel.display());
    let cur = std::fs::read_to_string(&file).unwrap_or_default();
    if cur.lines().any(|l| l.trim() == line) {
        return Ok(());
    }
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let sep = if cur.is_empty() || cur.ends_with('\n') { "" } else { "\n" };
    std::fs::write(&file, format!("{cur}{sep}{line}\n"))?;
    Ok(())
}

/// Recreates a removed Worktree on its existing branch.
pub async fn restore_worktree(wt: &WorktreeMeta) -> anyhow::Result<()> {
    if wt.path.exists() {
        return Ok(());
    }
    git(&wt.repo_root, &["worktree", "prune"]).await?;
    git(&wt.repo_root, &["worktree", "add", &wt.path.display().to_string(), &wt.branch]).await?;
    Ok(())
}

pub async fn is_dirty(dir: &Path) -> anyhow::Result<bool> {
    Ok(!git(dir, &["status", "--porcelain"]).await?.trim().is_empty())
}

/// Commits everything, skipping hooks; used before a Worktree is removed on archive.
pub async fn wip_commit(dir: &Path) -> anyhow::Result<()> {
    git(dir, &["add", "-A"]).await?;
    git(dir, &["commit", "--no-verify", "-m", "WIP (archived by Harness)"]).await?;
    Ok(())
}

/// Commits on `branch` that are not on `base`, local or on any remote.
pub async fn unmerged_count(repo_root: &Path, base: &str, branch: &str) -> anyhow::Result<u64> {
    let (base, branch) = (rev(base)?, rev(branch)?);
    let refs = base_refs(repo_root, base).await;
    let out = if refs.is_empty() {
        git(repo_root, &["rev-list", "--count", "--end-of-options", &format!("{base}..{branch}")]).await?
    } else {
        let mut args = vec!["rev-list", "--count", branch, "--not"];
        args.extend(refs.iter().map(String::as_str));
        git(repo_root, &args).await?
    };
    Ok(out.trim().parse()?)
}

pub async fn delete_branch(repo_root: &Path, branch: &str) -> anyhow::Result<()> {
    git(repo_root, &["branch", "-D", branch]).await?;
    Ok(())
}

/// Fast-forwards `branch` to `origin/<branch>`. Where git says it is checked out (this folder or another
/// worktree), `pull --ff-only` runs there, as git refuses to fetch into a checked-out branch; that also
/// refuses non-fast-forwards and local changes it would overwrite. A branch checked out nowhere is fetched into.
pub async fn update_branch(dir: &Path, branch: &str) -> anyhow::Result<()> {
    let branch = rev(branch)?;
    let out = git(dir, &["for-each-ref", "--format=%(worktreepath)", &format!("refs/heads/{branch}")]).await?;
    let checkout = out.trim();
    if checkout.is_empty() {
        git(dir, &["fetch", "origin", &format!("{branch}:{branch}")]).await?;
    } else {
        git(Path::new(checkout), &["pull", "--ff-only", "origin", branch]).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worktree_base_resolves_relative_absolute_and_home() {
        let root = Path::new("/r/proj");
        assert_eq!(worktree_base(root, ".harness"), PathBuf::from("/r/proj/.harness"));
        assert_eq!(worktree_base(root, "/tmp/wt"), PathBuf::from("/tmp/wt"));
        let home = PathBuf::from(std::env::var_os("HOME").unwrap());
        assert_eq!(worktree_base(root, "~/wt"), home.join("wt"));
    }

    fn sh(dir: &Path, args: &[&str]) -> String {
        let o = std::process::Command::new("git").args(args).current_dir(dir).output().unwrap();
        assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
        String::from_utf8_lossy(&o.stdout).trim().to_owned()
    }

    fn commit(dir: &Path, msg: &str) {
        sh(dir, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", msg]);
    }

    /// (tmp, origin, clone): the clone's local `main` and `origin/main` are one commit behind origin.
    fn stale_clone() -> (PathBuf, PathBuf, PathBuf) {
        let tmp = std::env::temp_dir().join(format!("harness-wt-{}", uuid::Uuid::now_v7()));
        let (origin, clone, other) = (tmp.join("origin.git"), tmp.join("clone"), tmp.join("other"));
        std::fs::create_dir_all(&tmp).unwrap();
        sh(&tmp, &["init", "-q", "--bare", "-b", "main", "origin.git"]);
        sh(&tmp, &["clone", "-q", origin.to_str().unwrap(), "clone"]);
        commit(&clone, "one");
        sh(&clone, &["push", "-q", "origin", "main"]);
        sh(&tmp, &["clone", "-q", origin.to_str().unwrap(), "other"]);
        commit(&other, "two");
        sh(&other, &["push", "-q", "origin", "main"]);
        (tmp, origin, clone)
    }

    async fn wt(clone: &Path, base: &str, name: &str) -> WorktreeMeta {
        let path = clone.parent().unwrap().join(name);
        create_worktree(clone, Some(base.into()), None, &path, name, "1").await.unwrap()
    }

    #[tokio::test]
    async fn worktree_starts_from_fresh_origin() {
        let (tmp, origin, clone) = stale_clone();
        let tip = sh(&origin, &["rev-parse", "main"]);
        assert_ne!(sh(&clone, &["rev-parse", "refs/remotes/origin/main"]), tip);
        let meta = wt(&clone, "main", "a").await;
        assert_eq!(sh(&meta.path, &["rev-parse", "HEAD"]), tip);
        assert_eq!(meta.base, "main");
        let up = std::process::Command::new("git")
            .args(["rev-parse", "--abbrev-ref", &format!("{}@{{upstream}}", meta.branch)])
            .current_dir(&clone)
            .output()
            .unwrap();
        assert!(!up.status.success());
        assert_eq!(unmerged_count(&clone, "main", &meta.branch).await.unwrap(), 0);
        commit(&meta.path, "work");
        assert_eq!(unmerged_count(&clone, "main", &meta.branch).await.unwrap(), 1);
        // A remote-tracking base works too.
        let meta2 = wt(&clone, "origin/main", "b").await;
        assert_eq!(sh(&meta2.path, &["rev-parse", "HEAD"]), tip);
        std::fs::remove_dir_all(&tmp).unwrap();
    }

    #[tokio::test]
    async fn update_branch_pulls_where_checked_out() {
        let (tmp, origin, clone) = stale_clone();
        let tip = sh(&origin, &["rev-parse", "main"]);
        let meta = wt(&clone, "main", "a").await;
        let head = sh(&meta.path, &["rev-parse", "HEAD"]);
        update_branch(&meta.path, "main").await.unwrap();
        assert_eq!(sh(&clone, &["rev-parse", "main"]), tip);
        assert_eq!(sh(&meta.path, &["rev-parse", "HEAD"]), head);
        std::fs::remove_dir_all(&tmp).unwrap();
    }

    #[tokio::test]
    async fn update_branch_from_its_own_checkout() {
        let (tmp, origin, clone) = stale_clone();
        update_branch(&clone, "main").await.unwrap();
        assert_eq!(sh(&clone, &["rev-parse", "main"]), sh(&origin, &["rev-parse", "main"]));
        std::fs::remove_dir_all(&tmp).unwrap();
    }

    #[tokio::test]
    async fn update_branch_fetches_when_not_checked_out() {
        let (tmp, origin, clone) = stale_clone();
        let other = tmp.join("other");
        sh(&clone, &["switch", "-q", "-c", "topic"]);
        sh(&clone, &["push", "-q", "origin", "topic"]);
        sh(&clone, &["switch", "-q", "main"]);
        sh(&other, &["fetch", "-q", "origin", "topic"]);
        sh(&other, &["switch", "-q", "topic"]);
        commit(&other, "three");
        sh(&other, &["push", "-q", "origin", "topic"]);
        let tip = sh(&origin, &["rev-parse", "topic"]);
        assert_ne!(sh(&clone, &["rev-parse", "topic"]), tip);
        update_branch(&clone, "topic").await.unwrap();
        assert_eq!(sh(&clone, &["rev-parse", "topic"]), tip);
        std::fs::remove_dir_all(&tmp).unwrap();
    }

    #[tokio::test]
    async fn worktree_local_only_branch_starts_at_local_tip() {
        let (tmp, _origin, clone) = stale_clone();
        sh(&clone, &["switch", "-q", "-c", "local-only"]);
        commit(&clone, "local");
        let tip = sh(&clone, &["rev-parse", "local-only"]);
        let meta = wt(&clone, "local-only", "a").await;
        assert_eq!(sh(&meta.path, &["rev-parse", "HEAD"]), tip);
        std::fs::remove_dir_all(&tmp).unwrap();
    }

    #[tokio::test]
    async fn worktree_without_remote_starts_at_local_branch() {
        let tmp = std::env::temp_dir().join(format!("harness-wt-{}", uuid::Uuid::now_v7()));
        let repo = tmp.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        sh(&repo, &["init", "-q", "-b", "main"]);
        commit(&repo, "one");
        let tip = sh(&repo, &["rev-parse", "main"]);
        let meta = wt(&repo, "main", "a").await;
        assert_eq!(sh(&meta.path, &["rev-parse", "HEAD"]), tip);
        std::fs::remove_dir_all(&tmp).unwrap();
    }

    #[tokio::test]
    async fn worktree_with_unreachable_origin_uses_last_known_ref() {
        let (tmp, _origin, clone) = stale_clone();
        let known = sh(&clone, &["rev-parse", "refs/remotes/origin/main"]);
        sh(&clone, &["remote", "set-url", "origin", tmp.join("missing").to_str().unwrap()]);
        let meta = wt(&clone, "main", "a").await;
        assert_eq!(sh(&meta.path, &["rev-parse", "HEAD"]), known);
        std::fs::remove_dir_all(&tmp).unwrap();
    }
}
