//! Reading the repository: branches, status, snapshots, diffs, log, and commit/push.

use std::path::{Path, PathBuf};

use super::cmd::{current_branch, git, git_env, repo_root, rev};
use super::parse::{parse_branch, parse_diff_files, parse_log, parse_status};
use crate::api::{BranchInfo, Branches, Commit, Diff, GitStatus};

pub async fn list_branches(folder: &Path) -> anyhow::Result<Branches> {
    let Some(root) = repo_root(folder).await else {
        return Ok(Branches { repo_root: None, current: None, default_branch: None, branches: vec![], remote: vec![] });
    };
    let current = current_branch(&root).await?;
    let fmt = "--format=%(refname:short)%00%(committerdate:unix)%00%(upstream:track,nobracket)%00%(worktreepath)";
    let local: Vec<BranchInfo> =
        git(&root, &["for-each-ref", "--sort=-committerdate", fmt, "refs/heads"]).await?.lines().filter_map(|l| parse_branch(l, &root)).collect();
    let remote = git(&root, &["for-each-ref", "--sort=-committerdate", fmt, "refs/remotes"])
        .await?
        .lines()
        .filter_map(|l| parse_branch(l, &root))
        // `origin/HEAD` shows as just `origin`; skip it and remote branches that have a local one.
        .filter(|b| b.name.split_once('/').is_some_and(|(_, n)| n != "HEAD" && !local.iter().any(|l| l.name == n)))
        .collect();
    // `origin/main` reads as `main` when there is a local `main`.
    let default = default_branch(&root).await.map(|d| match d.strip_prefix("origin/") {
        Some(n) if local.iter().any(|l| l.name == n) => n.to_owned(),
        _ => d,
    });
    Ok(Branches { repo_root: Some(root.display().to_string()), current, default_branch: default, branches: local, remote })
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
    Ok(parse_status(&out))
}

/// Diff between two trees or commits, as file list plus unified patch.
pub async fn diff(dir: &Path, from: &str, to: &str) -> anyhow::Result<Diff> {
    // "HEAD" (the Uncommitted changes scope) does not resolve before the first commit.
    let (from, to) = (rev(from)?, rev(to)?);
    let empty = if from == "HEAD" && !has_commits(dir).await { Some(empty_tree(dir).await?) } else { None };
    let from = empty.as_deref().unwrap_or(from);
    let names = git(dir, &["diff", "--no-renames", "--name-status", "--end-of-options", from, to]).await?;
    let nums = git(dir, &["diff", "--no-renames", "--numstat", "--end-of-options", from, to]).await?;
    let patch = git(dir, &["diff", "--no-renames", "--end-of-options", from, to]).await?;
    let files = parse_diff_files(&names, &nums);
    Ok(Diff { from: from.to_owned(), to: to.to_owned(), files, patch })
}

/// `path` at `rev`, or empty when it does not exist there (added or deleted file).
pub async fn show_file(dir: &Path, rev: &str, path: &str) -> anyhow::Result<String> {
    let rev = self::rev(rev)?;
    Ok(git(dir, &["show", "--end-of-options", &format!("{rev}:{path}")]).await.unwrap_or_default())
}

/// Commits in `base..HEAD`, newest first.
pub async fn log(dir: &Path, base: &str) -> anyhow::Result<Vec<Commit>> {
    let base = rev(base)?;
    if !has_commits(dir).await {
        return Ok(vec![]);
    }
    // Records end with \x1e: the body spans lines.
    let out = git(dir, &["log", "--format=%H%x1f%h%x1f%s%x1f%an%x1f%ae%x1f%cn%x1f%ct%x1f%b%x1e", "--end-of-options", &format!("{base}..HEAD")]).await?;
    Ok(parse_log(&out))
}

/// Where a Session's changes start: the closest merge base with its base branch (a Worktree's, or a PR's), local or on
/// any remote; a base found nowhere (a PR into a branch never fetched) is fetched once. Without a base, or when it is
/// gone: on a branch, where it forked from the default branch (`origin/HEAD`, else `main`/`master`); on the default
/// branch, its upstream, so only unpushed commits count; else HEAD (no commits, only uncommitted work). A repository
/// with no commits yet starts from the empty tree, so every file counts as added.
pub async fn diff_base(dir: &Path, base: Option<&str>) -> anyhow::Result<String> {
    if let Some(base) = base {
        let base = rev(base)?;
        let mut refs = base_refs(dir, base).await;
        if refs.is_empty() {
            for remote in git(dir, &["remote"]).await.unwrap_or_default().lines() {
                let _ = git(dir, &["fetch", "--quiet", "--no-tags", remote, &format!("refs/heads/{base}:refs/remotes/{remote}/{base}")]).await;
            }
            refs = base_refs(dir, base).await;
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
    if !has_commits(dir).await {
        return empty_tree(dir).await;
    }
    Ok(git(dir, &["rev-parse", "HEAD"]).await?.trim().to_owned())
}

/// False right after `git init`: HEAD names a branch with no commits.
async fn has_commits(dir: &Path) -> bool {
    git(dir, &["rev-parse", "--verify", "--quiet", "HEAD"]).await.is_ok()
}

async fn empty_tree(dir: &Path) -> anyhow::Result<String> {
    Ok(git(dir, &["hash-object", "-t", "tree", "/dev/null"]).await?.trim().to_owned())
}

/// `base` as a local branch (or any ref) and as `<remote>/<base>` on every remote, those that exist.
pub(super) async fn base_refs(dir: &Path, base: &str) -> Vec<String> {
    let mut refs = vec![];
    if git(dir, &["rev-parse", "--verify", "--quiet", "--end-of-options", &format!("{base}^{{commit}}")]).await.is_ok() {
        refs.push(base.to_owned());
    }
    let pattern = format!("refs/remotes/*/{base}");
    let remote = git(dir, &["for-each-ref", "--format=%(refname)", &pattern]).await.unwrap_or_default();
    refs.extend(remote.lines().filter(|r| !r.is_empty() && *r != base).map(str::to_owned));
    refs
}

/// The repo's main line: `origin/HEAD`, else a local `main` or `master`.
pub(crate) async fn default_branch(dir: &Path) -> Option<String> {
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
