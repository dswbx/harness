//! Git Primitives via the git CLI (ADR 0009): branches, Worktrees, status, diffs, commit, push,
//! and snapshots of the working tree (a temp index + `write-tree`, so the user's index is untouched).

mod cmd;
mod diff;
mod parse;
mod prefix;
mod worktree;

pub use cmd::{current_branch, find_repo_root, folder_prefix, git, head_branch, repo_root};
pub(crate) use diff::default_branch;
pub use diff::{commit, diff, diff_base, diff_range, list_branches, log, log_since_base, push, show_file, snapshot, status};
pub use parse::slug;
pub use prefix::{branch_prefix, prefixed, resolve_branch_prefix, set_branch_prefix};
pub use worktree::{
    BaseFetches, DEFAULT_WORKTREE_DIR, WorktreeMeta, checkout, create_branch, create_worktree, delete_branch, exclude_in_repo, is_dirty, remove_worktree,
    restore_worktree, set_worktree_dir, unmerged_count, update_branch, wip_commit, worktree_base, worktree_dir,
};
