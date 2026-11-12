//! Git Primitives via the git CLI (ADR 0009): branches, Worktrees, status, diffs, commit, push,
//! and snapshots of the working tree (a temp index + `write-tree`, so the user's index is untouched).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::api::{BranchInfo, Branches, Commit, Diff, FileChange, GitStatus, RepoId};

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

/// `folder`'s path inside its repository with a trailing `/` (`crates/`); empty at the root or outside git.
pub async fn folder_prefix(folder: &Path) -> String {
    git(folder, &["rev-parse", "--show-prefix"]).await.map(|s| s.trim().to_owned()).unwrap_or_default()
}

/// GitHub repository of the `upstream` remote, else `origin`. None without one on github.com.
pub async fn origin_repo(dir: &Path) -> Option<RepoId> {
    for remote in ["upstream", "origin"] {
        if let Ok(url) = git(dir, &["remote", "get-url", remote]).await
            && let Some(repo) = parse_github_remote(url.trim())
        {
            return Some(repo);
        }
    }
    None
}

/// `git@github.com:o/r.git`, `ssh://git@github.com/o/r`, `https://github.com/o/r.git`, ...
fn parse_github_remote(url: &str) -> Option<RepoId> {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let rest = rest.split_once('@').filter(|(user, _)| !user.contains('/')).map_or(rest, |(_, r)| r);
    let path = rest.strip_prefix("github.com")?;
    let path = path.strip_prefix(':').or_else(|| path.strip_prefix('/'))?.trim_end_matches('/');
    let (owner, name) = path.strip_suffix(".git").unwrap_or(path).split_once('/')?;
    Some(RepoId { owner: owner.to_owned(), name: name.to_owned() }).filter(crate::github_refs::valid_repo)
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

fn parse_gitdir(content: &str) -> Option<&str> {
    content.trim().strip_prefix("gitdir:").map(str::trim).filter(|s| !s.is_empty())
}

fn parse_head(content: &str) -> Option<String> {
    content.trim().strip_prefix("ref:")?.trim().strip_prefix("refs/heads/").filter(|s| !s.is_empty()).map(str::to_owned)
}

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
    Some(BranchInfo { name, time, ahead, behind, worktree, archived: false })
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
        Some(b) => b,
        None => current_branch(repo_root).await?.ok_or_else(|| anyhow::anyhow!("HEAD is detached; pick a base branch"))?,
    };
    let branch = branch.unwrap_or_else(|| format!("harness/{slug}-{short_id}"));
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let p = path.display().to_string();
    let start = worktree_start(repo_root, &base).await;
    // `--no-track`: the new branch must not get `origin/<base>` as its upstream.
    git(repo_root, &["worktree", "add", "--no-track", "-b", &branch, &p, &start]).await?;
    Ok(WorktreeMeta { repo_root: repo_root.to_owned(), path: path.to_owned(), branch, base })
}

/// Start point for a Worktree on `base`: its freshly fetched remote copy when there is one, else `base`.
/// A failed or slow fetch is logged and the last known remote ref is used.
async fn worktree_start(repo_root: &Path, base: &str) -> String {
    if base.starts_with('-') {
        return base.to_owned();
    }
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
    if !branch.starts_with('-') {
        let spec = format!("+refs/heads/{branch}:refs/remotes/{remote}/{branch}");
        let args = ["fetch", "--quiet", "--no-tags", remote, &spec];
        match tokio::time::timeout(std::time::Duration::from_secs(15), git(repo_root, &args)).await {
            Ok(Ok(_)) => {}
            Ok(Err(e)) => tracing::warn!("fetching {remote}/{branch} failed, using the last known copy: {e:#}"),
            Err(_) => tracing::warn!("fetching {remote}/{branch} timed out, using the last known copy"),
        }
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
    let refs = base_refs(repo_root, base).await;
    let out = if refs.is_empty() {
        git(repo_root, &["rev-list", "--count", &format!("{base}..{branch}")]).await?
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
            let path = fields.last().and_then(|f| f.split('\t').next()).unwrap_or_default();
            let code = xy.strip_prefix('.').unwrap_or(&xy[..1]);
            st.files.push(FileChange { path: path.to_owned(), status: code.into(), additions: None, deletions: None });
        }
    }
    Ok(st)
}

/// Diff between two trees or commits, as file list plus unified patch.
pub async fn diff(dir: &Path, from: &str, to: &str) -> anyhow::Result<Diff> {
    // "HEAD" (the Uncommitted changes scope) does not resolve before the first commit.
    let empty = if from == "HEAD" && !has_commits(dir).await { Some(empty_tree(dir).await?) } else { None };
    let from = empty.as_deref().unwrap_or(from);
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
    if !has_commits(dir).await {
        return Ok(vec![]);
    }
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

/// Where a Session's changes start: the closest merge base with its base branch (a Worktree's, or a PR's), local or on
/// any remote; a base found nowhere (a PR into a branch never fetched) is fetched once. Without a base, or when it is
/// gone: on a branch, where it forked from the default branch (`origin/HEAD`, else `main`/`master`); on the default
/// branch, its upstream, so only unpushed commits count; else HEAD (no commits, only uncommitted work). A repository
/// with no commits yet starts from the empty tree, so every file counts as added.
pub async fn diff_base(dir: &Path, base: Option<&str>) -> anyhow::Result<String> {
    if let Some(base) = base {
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
async fn base_refs(dir: &Path, base: &str) -> Vec<String> {
    let mut refs = vec![];
    if !base.starts_with('-') && git(dir, &["rev-parse", "--verify", "--quiet", &format!("{base}^{{commit}}")]).await.is_ok() {
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

/// Fast-forwards `branch` to `origin/<branch>`. Where git says it is checked out (this folder or another
/// worktree), `pull --ff-only` runs there, as git refuses to fetch into a checked-out branch; that also
/// refuses non-fast-forwards and local changes it would overwrite. A branch checked out nowhere is fetched into.
pub async fn update_branch(dir: &Path, branch: &str) -> anyhow::Result<()> {
    anyhow::ensure!(!branch.is_empty() && !branch.starts_with('-'), "invalid branch name");
    let out = git(dir, &["for-each-ref", "--format=%(worktreepath)", &format!("refs/heads/{branch}")]).await?;
    let checkout = out.trim();
    if checkout.is_empty() {
        git(dir, &["fetch", "origin", &format!("{branch}:{branch}")]).await?;
    } else {
        git(Path::new(checkout), &["pull", "--ff-only", "origin", branch]).await?;
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    #[test]
    fn worktree_base_resolves_relative_absolute_and_home() {
        let root = Path::new("/r/proj");
        assert_eq!(worktree_base(root, ".harness"), PathBuf::from("/r/proj/.harness"));
        assert_eq!(worktree_base(root, "/tmp/wt"), PathBuf::from("/tmp/wt"));
        let home = PathBuf::from(std::env::var_os("HOME").unwrap());
        assert_eq!(worktree_base(root, "~/wt"), home.join("wt"));
    }

    use super::*;

    #[test]
    fn parses_head_and_gitdir() {
        assert_eq!(parse_head("ref: refs/heads/main\n").as_deref(), Some("main"));
        assert_eq!(parse_head("ref: refs/heads/harness/pr-12-abc\n").as_deref(), Some("harness/pr-12-abc"));
        assert_eq!(parse_head("3f2a9c0e1b4d5a6f7e8d9c0b1a2f3e4d5c6b7a8f\n"), None);
        assert_eq!(parse_gitdir("gitdir: /repo/.git/worktrees/x\n"), Some("/repo/.git/worktrees/x"));
        assert_eq!(parse_gitdir("nonsense"), None);
    }

    #[test]
    fn parses_github_remotes() {
        let r = |o: &str, n: &str| Some(RepoId { owner: o.into(), name: n.into() });
        assert_eq!(parse_github_remote("git@github.com:dswbx/harness.git"), r("dswbx", "harness"));
        assert_eq!(parse_github_remote("git@github.com:dswbx/harness"), r("dswbx", "harness"));
        assert_eq!(parse_github_remote("ssh://git@github.com/supabase/spark.git"), r("supabase", "spark"));
        assert_eq!(parse_github_remote("https://github.com/supabase/spark"), r("supabase", "spark"));
        assert_eq!(parse_github_remote("https://github.com/supabase/spark.git/"), r("supabase", "spark"));
        assert_eq!(parse_github_remote("https://user@github.com/supabase/my.repo.git"), r("supabase", "my.repo"));
        assert_eq!(parse_github_remote("git@gitlab.com:dswbx/harness.git"), None);
        assert_eq!(parse_github_remote("https://github.com.evil.dev/a/b"), None);
        assert_eq!(parse_github_remote("https://github.com/only-owner"), None);
        assert_eq!(parse_github_remote("https://github.com/a/b/tree/main"), None);
        assert_eq!(parse_github_remote("/local/path/repo.git"), None);
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
