//! Git Primitives via the git CLI (ADR 0009): branches, Worktrees, status, diffs, commit, push,
//! and snapshots of the working tree (a temp index + `write-tree`, so the user's index is untouched).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::api::{BranchInfo, Branches, Commit, Diff, FileChange, GitStatus};

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
        return Ok(Branches { repo_root: None, current: None, branches: vec![], remote: vec![] });
    };
    let current = current_branch(&root).await?;
    let fmt = "--format=%(refname:short)%00%(committerdate:unix)%00%(upstream:track,nobracket)%00%(worktreepath)";
    let local: Vec<BranchInfo> = git(&root, &["for-each-ref", "--sort=-committerdate", fmt, "refs/heads"])
        .await?
        .lines()
        .filter_map(|l| parse_branch(l, &root))
        .collect();
    let remote = git(&root, &["for-each-ref", "--sort=-committerdate", fmt, "refs/remotes"])
        .await?
        .lines()
        .filter_map(|l| parse_branch(l, &root))
        // `origin/HEAD` shows as just `origin`; skip it and remote branches that have a local one.
        .filter(|b| b.name.split_once('/').is_some_and(|(_, n)| n != "HEAD" && !local.iter().any(|l| l.name == n)))
        .collect();
    Ok(Branches { repo_root: Some(root.display().to_string()), current, branches: local, remote })
}

/// One `for-each-ref` line: name, commit time, upstream track ("ahead 3, behind 1"), worktree path.
fn parse_branch(line: &str, root: &Path) -> Option<BranchInfo> {
    let mut f = line.split('\0');
    let name = f.next().filter(|n| !n.is_empty())?.to_owned();
    let time = f.next().and_then(|t| t.parse().ok()).unwrap_or(0);
    let (mut ahead, mut behind) = (0, 0);
    for part in f.next().unwrap_or("").split(", ") {
        match part.split_once(' ') {
            Some(("ahead", n)) => ahead = n.parse().unwrap_or(0),
            Some(("behind", n)) => behind = n.parse().unwrap_or(0),
            _ => {}
        }
    }
    let wt = f.next().unwrap_or("");
    let worktree = !wt.is_empty() && Path::new(wt) != root;
    Some(BranchInfo { name, time, ahead, behind, worktree })
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

/// Creates `branch` (default `harness/<slug>-<short id>`) from `base` (default: the current
/// branch) at `path`.
pub async fn create_worktree(
    repo_root: &Path,
    base: Option<String>,
    branch: Option<String>,
    path: &Path,
    slug: &str,
    short_id: &str,
) -> anyhow::Result<WorktreeMeta> {
    let base = match base {
        Some(b) => b,
        None => current_branch(repo_root).await?.ok_or_else(|| anyhow::anyhow!("HEAD is detached; pick a base branch"))?,
    };
    let branch = branch.unwrap_or_else(|| format!("harness/{slug}-{short_id}"));
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let p = path.display().to_string();
    git(repo_root, &["worktree", "add", "-b", &branch, &p, &base]).await?;
    Ok(WorktreeMeta { repo_root: repo_root.to_owned(), path: path.to_owned(), branch, base })
}

/// Creates `branch` from `base` (default: HEAD) and switches the folder to it; uncommitted
/// changes come along.
pub async fn create_branch(dir: &Path, branch: &str, base: Option<&str>) -> anyhow::Result<()> {
    git(dir, &["check-ref-format", "--branch", branch]).await.map_err(|_| anyhow::anyhow!("{branch:?} is not a valid branch name"))?;
    let mut args = vec!["switch", "-c", branch];
    args.extend(base);
    git(dir, &args).await?;
    Ok(())
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

/// Commits in `base..HEAD`, newest first.
pub async fn log(dir: &Path, base: &str) -> anyhow::Result<Vec<Commit>> {
    anyhow::ensure!(!base.starts_with('-'), "invalid base");
    // Records end with \x1e: the body spans lines.
    let out = git(dir, &["log", "--format=%H%x1f%h%x1f%s%x1f%an%x1f%ae%x1f%cn%x1f%ct%x1f%b%x1e", &format!("{base}..HEAD")]).await?;
    Ok(out
        .split('\x1e')
        .filter_map(|r| {
            let mut p = r.trim_start_matches('\n').split('\x1f');
            Some(Commit {
                sha: p.next().filter(|s| !s.is_empty())?.to_owned(),
                short: p.next()?.to_owned(),
                subject: p.next()?.to_owned(),
                author: p.next()?.to_owned(),
                author_email: p.next()?.to_owned(),
                committer: p.next()?.to_owned(),
                time: p.next()?.parse().ok()?,
                body: p.next()?.trim_end().to_owned(),
            })
        })
        .collect())
}

/// Where a Session's changes start: the closest merge base with its Worktree's base branch, local or `origin/<base>`
/// (a PR's base is often missing or stale locally). Without a Worktree, or when the base is gone: on a branch, where it
/// forked from the default branch (`origin/HEAD`, else `main`/`master`); on the default branch, its upstream, so only
/// unpushed commits count; else HEAD (no commits, only uncommitted work).
pub async fn diff_base(dir: &Path, base: Option<&str>) -> anyhow::Result<String> {
    if let Some(base) = base {
        let mut refs = vec![];
        for r in [base.to_owned(), format!("refs/remotes/origin/{base}")] {
            if git(dir, &["rev-parse", "--verify", "--quiet", &format!("{r}^{{commit}}")]).await.is_ok() {
                refs.push(r);
            }
        }
        // With several refs, git picks the best common ancestor of HEAD and any of them: the closest fork point.
        if !refs.is_empty()
            && let Ok(mb) = git(dir, &[&["merge-base", "HEAD"][..], &refs.iter().map(String::as_str).collect::<Vec<_>>()].concat()).await
        {
            return Ok(mb.trim().to_owned());
        }
    }
    let default = default_branch(dir).await;
    let current = current_branch(dir).await.ok().flatten();
    let on_default = default.as_deref().is_some_and(|d| current.as_deref() == Some(d.split_once('/').map_or(d, |(_, b)| b)));
    let fork = if on_default { "@{upstream}" } else { default.as_deref().unwrap_or("@{upstream}") };
    if let Ok(mb) = git(dir, &["merge-base", "HEAD", fork]).await {
        return Ok(mb.trim().to_owned());
    }
    Ok(git(dir, &["rev-parse", "HEAD"]).await?.trim().to_owned())
}

/// The repo's main line: `origin/HEAD`, else a local `main` or `master`.
async fn default_branch(dir: &Path) -> Option<String> {
    if let Ok(r) = git(dir, &["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).await
        && !r.trim().is_empty()
    {
        return Some(r.trim().to_owned());
    }
    for b in ["main", "master"] {
        if git(dir, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{b}")]).await.is_ok() {
            return Some(b.to_owned());
        }
    }
    None
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
