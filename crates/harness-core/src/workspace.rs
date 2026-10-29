//! Git Primitives via the git CLI (ADR 0009): branches, Worktrees, status, diffs, commit, push,
//! and snapshots of the working tree (a temp index + `write-tree`, so the user's index is untouched).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::api::{Branches, Diff, FileChange, GitStatus};

pub async fn git(dir: &Path, args: &[&str]) -> anyhow::Result<String> {
    git_env(dir, args, &[]).await
}

async fn git_env(dir: &Path, args: &[&str], env: &[(&str, &std::ffi::OsStr)]) -> anyhow::Result<String> {
    let out = tokio::process::Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("PATH", crate::env::login_path())
        .env("GIT_TERMINAL_PROMPT", "0")
        .envs(env.iter().map(|(k, v)| (*k, *v)))
        .stdin(std::process::Stdio::null())
        .output()
        .await?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let msg = if err.trim().is_empty() { String::from_utf8_lossy(&out.stdout).into_owned() } else { err.into_owned() };
        anyhow::bail!("git {}: {}", args.join(" "), msg.trim());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// The repository root containing `folder`, or `None` when it is not in a git repository.
pub async fn repo_root(folder: &Path) -> Option<PathBuf> {
    git(folder, &["rev-parse", "--show-toplevel"]).await.ok().map(|s| PathBuf::from(s.trim()))
}

pub async fn current_branch(dir: &Path) -> anyhow::Result<Option<String>> {
    let b = git(dir, &["branch", "--show-current"]).await?;
    Ok(Some(b.trim().to_owned()).filter(|b| !b.is_empty()))
}

pub async fn list_branches(folder: &Path) -> anyhow::Result<Branches> {
    let Some(root) = repo_root(folder).await else {
        return Ok(Branches { repo_root: None, current: None, branches: vec![] });
    };
    let refs = git(&root, &["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads"]).await?;
    Ok(Branches {
        repo_root: Some(root.display().to_string()),
        current: current_branch(&root).await?,
        branches: refs.lines().map(str::to_owned).collect(),
    })
}

/// A Worktree the Harness created for one Session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorktreeMeta {
    pub repo_root: PathBuf,
    pub path: PathBuf,
    pub branch: String,
    /// Branch the Worktree was cut from; diffs and merge checks compare against it.
    pub base: String,
}

/// Creates `harness/<slug>-<short id>` from `base` (default: the current branch) at `path`.
pub async fn create_worktree(
    repo_root: &Path,
    base: Option<String>,
    path: &Path,
    slug: &str,
    short_id: &str,
) -> anyhow::Result<WorktreeMeta> {
    let base = match base {
        Some(b) => b,
        None => current_branch(repo_root).await?.ok_or_else(|| anyhow::anyhow!("HEAD is detached; pick a base branch"))?,
    };
    let branch = format!("harness/{slug}-{short_id}");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let p = path.display().to_string();
    git(repo_root, &["worktree", "add", "-b", &branch, &p, &base]).await?;
    Ok(WorktreeMeta { repo_root: repo_root.to_owned(), path: path.to_owned(), branch, base })
}

/// Switches a plain folder to `branch`; refuses when the working tree has changes.
pub async fn checkout(dir: &Path, branch: &str) -> anyhow::Result<()> {
    anyhow::ensure!(
        git(dir, &["status", "--porcelain"]).await?.trim().is_empty(),
        "the folder has uncommitted changes; commit or stash them, or use a Worktree"
    );
    git(dir, &["checkout", branch]).await?;
    Ok(())
}

pub async fn remove_worktree(wt: &WorktreeMeta) -> anyhow::Result<()> {
    if wt.path.exists() {
        git(&wt.repo_root, &["worktree", "remove", "--force", &wt.path.display().to_string()]).await?;
    }
    git(&wt.repo_root, &["worktree", "prune"]).await?;
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

/// Commits on `branch` that are not on `base`.
pub async fn unmerged_count(repo_root: &Path, base: &str, branch: &str) -> anyhow::Result<u64> {
    let range = format!("{base}..{branch}");
    Ok(git(repo_root, &["rev-list", "--count", &range]).await?.trim().parse()?)
}

pub async fn delete_branch(repo_root: &Path, branch: &str) -> anyhow::Result<()> {
    git(repo_root, &["branch", "-D", branch]).await?;
    Ok(())
}

/// Tree of the working tree as it is now, untracked files included. Ignored files are left out.
pub async fn snapshot(dir: &Path) -> anyhow::Result<String> {
    let index = PathBuf::from(git(dir, &["rev-parse", "--path-format=absolute", "--git-path", "index"]).await?.trim());
    let tmp = std::env::temp_dir().join(format!("harness-index-{}", uuid::Uuid::now_v7()));
    // Starting from the real index keeps `add -A` incremental (stat cache).
    if index.exists() {
        std::fs::copy(&index, &tmp)?;
    }
    let env = [("GIT_INDEX_FILE", tmp.as_os_str())];
    let result = async {
        git_env(dir, &["add", "-A"], &env).await?;
        git_env(dir, &["write-tree"], &env).await
    }
    .await;
    let _ = std::fs::remove_file(&tmp);
    Ok(result?.trim().to_owned())
}

pub async fn status(dir: &Path) -> anyhow::Result<GitStatus> {
    let out = git(dir, &["status", "--porcelain=v2", "--branch", "--untracked-files=all"]).await?;
    let mut st = GitStatus { branch: None, upstream: None, ahead: 0, behind: 0, files: vec![] };
    for line in out.lines() {
        if let Some(h) = line.strip_prefix("# branch.head ") {
            st.branch = Some(h.to_owned()).filter(|h| h != "(detached)");
        } else if let Some(u) = line.strip_prefix("# branch.upstream ") {
            st.upstream = Some(u.to_owned());
        } else if let Some(ab) = line.strip_prefix("# branch.ab ") {
            let mut it = ab.split(' ');
            st.ahead = it.next().and_then(|a| a.trim_start_matches('+').parse().ok()).unwrap_or(0);
            st.behind = it.next().and_then(|b| b.trim_start_matches('-').parse().ok()).unwrap_or(0);
        } else if let Some(p) = line.strip_prefix("? ") {
            st.files.push(FileChange { path: p.to_owned(), status: "?".into(), additions: None, deletions: None });
        } else if line.starts_with("1 ") || line.starts_with("2 ") {
            // "1 XY sub mH mI mW hH hI path" / "2 XY ... Xscore path\torig"
            let fields: Vec<&str> = line.splitn(if line.starts_with('1') { 9 } else { 10 }, ' ').collect();
            let xy = fields[1];
            let path = fields.last().unwrap().split('\t').next().unwrap_or_default();
            let code = xy.strip_prefix('.').unwrap_or(&xy[..1]);
            st.files.push(FileChange { path: path.to_owned(), status: code.into(), additions: None, deletions: None });
        }
    }
    Ok(st)
}

/// Diff between two trees or commits, as file list plus unified patch.
pub async fn diff(dir: &Path, from: &str, to: &str) -> anyhow::Result<Diff> {
    let names = git(dir, &["diff", "--no-renames", "--name-status", from, to]).await?;
    let nums = git(dir, &["diff", "--no-renames", "--numstat", from, to]).await?;
    let patch = git(dir, &["diff", "--no-renames", from, to]).await?;
    let mut files: Vec<FileChange> = names
        .lines()
        .filter_map(|l| l.split_once('\t'))
        .map(|(s, p)| FileChange { path: p.to_owned(), status: s.to_owned(), additions: None, deletions: None })
        .collect();
    for l in nums.lines() {
        let mut it = l.splitn(3, '\t');
        let (Some(a), Some(d), Some(p)) = (it.next(), it.next(), it.next()) else { continue };
        if let Some(f) = files.iter_mut().find(|f| f.path == p) {
            f.additions = a.parse().ok();
            f.deletions = d.parse().ok();
        }
    }
    Ok(Diff { from: from.to_owned(), to: to.to_owned(), files, patch })
}

/// `path` at `rev`, or empty when it does not exist there (added or deleted file).
pub async fn show_file(dir: &Path, rev: &str, path: &str) -> anyhow::Result<String> {
    anyhow::ensure!(!rev.starts_with('-') && !path.starts_with('-'), "invalid rev or path");
    Ok(git(dir, &["show", &format!("{rev}:{path}")]).await.unwrap_or_default())
}

/// Where a Session's changes start: the merge base with its Worktree's base branch, else HEAD.
pub async fn diff_base(dir: &Path, base: Option<&str>) -> anyhow::Result<String> {
    if let Some(base) = base
        && let Ok(mb) = git(dir, &["merge-base", "HEAD", base]).await
    {
        return Ok(mb.trim().to_owned());
    }
    Ok(git(dir, &["rev-parse", "HEAD"]).await?.trim().to_owned())
}

pub async fn commit(dir: &Path, message: &str) -> anyhow::Result<String> {
    git(dir, &["add", "-A"]).await?;
    git(dir, &["commit", "-m", message]).await?;
    Ok(git(dir, &["rev-parse", "HEAD"]).await?.trim().to_owned())
}

pub async fn push(dir: &Path) -> anyhow::Result<String> {
    let branch = current_branch(dir).await?.ok_or_else(|| anyhow::anyhow!("HEAD is detached"))?;
    git(dir, &["push", "-u", "origin", &branch]).await?;
    Ok(branch)
}

/// Lowercase, dash-separated, at most 24 chars; safe inside a branch name.
pub fn slug(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out: String = out.trim_end_matches('-').chars().take(24).collect();
    let out = out.trim_end_matches('-').to_owned();
    if out.is_empty() { "session".into() } else { out }
}
