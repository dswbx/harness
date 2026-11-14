//! The `git` runner and the guard for revisions that come from outside.

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::proc;

use super::parse::{parse_gitdir, parse_head};

pub async fn git(dir: &Path, args: &[&str]) -> anyhow::Result<String> {
    git_with(dir, args, &[], timeout_for(args)).await
}

/// `git` with extra env (a scratch index for the diff snapshot): `add -A` scales with the repository.
pub(super) async fn git_env(dir: &Path, args: &[&str], env: &[(&str, &std::ffi::OsStr)]) -> anyhow::Result<String> {
    git_with(dir, args, env, proc::GIT_LONG).await
}

/// `git` bounded by `timeout`; a hang fails with a timeout error and kills git and what it spawned.
pub(super) async fn git_with(dir: &Path, args: &[&str], env: &[(&str, &std::ffi::OsStr)], timeout: Duration) -> anyhow::Result<String> {
    let mut opts = proc::Opts::new(timeout).args(args).cwd(dir).env("PATH", crate::env::login_path()).env("GIT_TERMINAL_PROMPT", "0");
    for (k, v) in env {
        opts = opts.env(k, v);
    }
    // A huge diff or file never failed before: keep what fits instead of erroring.
    if matches!(args.first(), Some(&("diff" | "show"))) {
        opts = opts.max_output(512 * 1024 * 1024).truncate();
    }
    let out = proc::run("git", opts).await.map_err(|e| anyhow::anyhow!("git {}: {e}", args.join(" ")))?;
    if !out.success() {
        let err = out.stderr_lossy();
        let msg = if err.trim().is_empty() { out.stdout_lossy() } else { err };
        anyhow::bail!("git {}: {}", args.join(" "), msg.trim());
    }
    Ok(out.stdout_lossy())
}

/// Subcommands that only read local state: they keep the short limit. Everything else (hooks, the
/// network, working-tree writes, anything not listed) gets the long one.
const READ_ONLY: &[&str] = &[
    "status",
    "rev-parse",
    "diff",
    "log",
    "branch",
    "config",
    "ls-files",
    "for-each-ref",
    "show",
    "remote",
    "symbolic-ref",
    "merge-base",
    "rev-list",
    "hash-object",
    "check-ref-format",
    "cat-file",
    "ls-tree",
    "show-ref",
    "describe",
    "name-rev",
    "diff-tree",
    "blame",
    "var",
    "version",
];

fn timeout_for(args: &[&str]) -> Duration {
    match args.first() {
        Some(sub) if READ_ONLY.contains(sub) => proc::LOCAL,
        _ => proc::GIT_LONG,
    }
}

/// A revision, branch or ref from outside, checked before it reaches git: not empty and not option-like.
/// Pair it with `--end-of-options` where the subcommand takes it.
pub(super) fn rev(s: &str) -> anyhow::Result<&str> {
    if s.is_empty() || s.starts_with('-') {
        return Err(crate::error::invalid(format!("invalid revision {s:?}")));
    }
    Ok(s)
}

/// The repository root containing `folder`, or `None` when it is not in a git repository.
pub async fn repo_root(folder: &Path) -> Option<PathBuf> {
    git(folder, &["rev-parse", "--show-toplevel"]).await.ok().map(|s| PathBuf::from(s.trim()))
}

/// `folder`'s path inside its repository with a trailing `/` (`crates/`); empty at the root or outside git.
pub async fn folder_prefix(folder: &Path) -> String {
    git(folder, &["rev-parse", "--show-prefix"]).await.map(|s| s.trim().to_owned()).unwrap_or_default()
}

pub async fn current_branch(dir: &Path) -> anyhow::Result<Option<String>> {
    let b = git(dir, &["branch", "--show-current"]).await?;
    Ok(Some(b.trim().to_owned()).filter(|b| !b.is_empty()))
}

/// The nearest folder at or above `folder` with a `.git`, without spawning git.
pub fn find_repo_root(folder: &Path) -> Option<PathBuf> {
    folder.ancestors().find(|d| d.join(".git").exists()).map(Path::to_owned)
}

/// Branch checked out at `folder` (or its nearest repo above), read from the HEAD file without
/// spawning git. None when not in a git repo or HEAD is detached.
pub fn head_branch(folder: &Path) -> Option<String> {
    let dot_git = find_repo_root(folder)?.join(".git");
    let git_dir = if dot_git.is_dir() {
        dot_git
    } else {
        // Worktree or submodule: `.git` is a file `gitdir: <path>`, relative to its folder.
        let content = std::fs::read_to_string(&dot_git).ok()?;
        dot_git.parent()?.join(parse_gitdir(&content)?)
    };
    parse_head(&std::fs::read_to_string(git_dir.join("HEAD")).ok()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeouts_by_subcommand() {
        for sub in ["status", "rev-parse", "diff", "log", "branch", "config", "ls-files", "for-each-ref", "show"] {
            assert_eq!(timeout_for(&[sub, "x"]), proc::LOCAL, "{sub}");
        }
        for sub in ["commit", "merge", "rebase", "checkout", "switch", "worktree", "stash", "add", "gc", "push", "pull", "clone", "fetch", "unknown-cmd"] {
            assert_eq!(timeout_for(&[sub]), proc::GIT_LONG, "{sub}");
        }
        assert_eq!(timeout_for(&[]), proc::GIT_LONG);
    }

    #[test]
    fn rev_rejects_empty_and_option_like() {
        assert_eq!(rev("main").unwrap(), "main");
        assert_eq!(rev("HEAD~1").unwrap(), "HEAD~1");
        assert_eq!(rev("origin/feature/x").unwrap(), "origin/feature/x");
        for bad in ["", "-x", "--output=/tmp/x", "--"] {
            assert!(rev(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn head_branch_reads_dir_and_worktree_file() {
        let tmp = std::env::temp_dir().join(format!("harness-head-{}", uuid::Uuid::now_v7()));
        let repo = tmp.join("repo");
        std::fs::create_dir_all(repo.join(".git/worktrees/wt")).unwrap();
        std::fs::create_dir_all(repo.join("sub")).unwrap();
        std::fs::write(repo.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        assert_eq!(head_branch(&repo.join("sub")).as_deref(), Some("main"));

        let wt = tmp.join("wt");
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(repo.join(".git/worktrees/wt/HEAD"), "ref: refs/heads/feature/x\n").unwrap();
        std::fs::write(wt.join(".git"), "gitdir: ../repo/.git/worktrees/wt\n").unwrap();
        assert_eq!(head_branch(&wt).as_deref(), Some("feature/x"));

        std::fs::write(repo.join(".git/worktrees/wt/HEAD"), "0123456789abcdef0123456789abcdef01234567\n").unwrap();
        assert_eq!(head_branch(&wt), None);
        std::fs::remove_dir_all(&tmp).unwrap();
    }
}
