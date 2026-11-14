//! Git branches, Pull Requests, diffs and commits.

use serde::{Deserialize, Serialize};
use specta::Type;

/// Who ran a git action.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum GitActor {
    Agent,
    #[default]
    User,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Branches {
    /// `None` when the folder is not in a git repository.
    pub repo_root: Option<String>,
    /// `None` when HEAD is detached.
    pub current: Option<String>,
    /// The repo's main line, as named in `branches` (or in `remote` when it has no local branch). `None` when unknown.
    pub default_branch: Option<String>,
    /// Local branches, most recently committed first.
    pub branches: Vec<BranchInfo>,
    /// Remote branches with no local branch of the same name (`origin/x`), most recent first.
    pub remote: Vec<BranchInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct BranchInfo {
    pub name: String,
    /// Unix seconds of the last commit.
    #[specta(type = specta_typescript::Number)]
    pub time: i64,
    /// Commits ahead of / behind its upstream (0 without one).
    pub ahead: u32,
    pub behind: u32,
    /// Checked out in another Worktree (it can't be checked out again).
    pub worktree: bool,
    /// Branch of an archived Session's removed Worktree. Set by the Host's `ListBranches` only.
    pub archived: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum PrFilter {
    #[default]
    Open,
    Mine,
    ReviewRequested,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct PullRequest {
    pub number: u32,
    pub title: String,
    pub author: String,
    /// Head branch name (on the fork when `fork`).
    pub head: String,
    pub base: String,
    pub draft: bool,
    pub fork: bool,
    pub checks: PrChecks,
    /// RFC 3339.
    pub updated_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum PrChecks {
    Passing,
    Failing,
    Pending,
    None,
}

/// A GitHub repository, e.g. `supabase/spark`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
pub struct RepoId {
    pub owner: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
pub struct PrRefKey {
    pub repo: RepoId,
    pub number: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum PrState {
    Open,
    Draft,
    Merged,
    Closed,
}

/// A PR of any GitHub repository, as shown by a PR reference.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct PrInfo {
    pub repo: RepoId,
    pub number: u32,
    pub title: String,
    pub author: String,
    pub state: PrState,
    pub checks: PrChecks,
    /// Checks that passed (success, neutral, skipped) of all checks.
    pub checks_passed: u32,
    pub checks_total: u32,
    pub additions: u32,
    pub deletions: u32,
    pub changed_files: u32,
    /// RFC 3339.
    pub updated_at: String,
    pub url: String,
}

/// A GitHub repository some Sessions work in. `score` adds up each Session's recency (1 now, halving every ~3 weeks).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct KnownRepo {
    pub repo: RepoId,
    pub sessions: u32,
    #[specta(type = specta_typescript::Number)]
    pub score: f64,
    /// Last activity of its Sessions.
    #[specta(type = specta_typescript::Number)]
    pub last_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct GitStatus {
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<FileChange>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct FileChange {
    pub path: String,
    /// git status letter: M, A, D, R, T, U, or ? (untracked).
    pub status: String,
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Commit {
    pub sha: String,
    pub short: String,
    pub subject: String,
    pub author: String,
    pub author_email: String,
    pub committer: String,
    /// Message after the subject line (trailers such as `Co-authored-by:` included).
    pub body: String,
    /// Unix seconds, committer time.
    #[specta(type = specta_typescript::Number)]
    pub time: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Diff {
    pub from: String,
    pub to: String,
    pub files: Vec<FileChange>,
    /// Unified diff.
    pub patch: String,
}
