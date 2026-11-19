//! Sessions, Workspaces, Terminals and Sub Session reports.

use serde::{Deserialize, Serialize};
use specta::Type;

use super::*;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct WorkspaceInfo {
    pub repo_root: Option<String>,
    /// The folder the Session was started in: for a Worktree Session the same folder in the
    /// repository the Worktree came from, else the Session's folder.
    pub source_folder: String,
    /// The Session's own branch (`harness/...` by default, `BranchPrefix`) when it has a Worktree.
    pub worktree_branch: Option<String>,
    pub base_branch: Option<String>,
    /// Branch checked out in the Session's folder; None when not a git repo or HEAD is detached.
    pub branch: Option<String>,
    /// The PR the Session started from, else the last PR found for its current branch.
    pub pr: Option<u32>,
    /// `pr`'s state when last looked up; None before the first lookup.
    pub pr_state: Option<PrState>,
    /// `pr`'s checks when last looked up.
    pub pr_checks: Option<PrChecks>,
}

/// One Terminal tab of a Session (ADR 0017).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct TerminalInfo {
    pub id: u32,
    /// Foreground program while one runs, else the shell name and tab index.
    pub title: String,
    /// A shell runs (false after it ended, until the next attach).
    pub running: bool,
    /// A program other than the shell is in the foreground.
    pub busy: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SessionSummary {
    pub id: SessionId,
    pub title: String,
    pub frontend_id: String,
    pub agent_id: String,
    pub folder: String,
    #[specta(type = specta_typescript::Number)]
    pub created_ms: i64,
    /// Time of the Session's last activity (last Session Log Event), else `created_ms`.
    #[specta(type = specta_typescript::Number)]
    pub updated_ms: i64,
    pub status: SessionStatus,
    pub archived: bool,
    /// A Quick Session: `folder` is a folder the Harness made for it.
    pub quick: bool,
    /// A Quick Session nobody has prompted yet (the overlay's draft, a fresh one from the +). False once a prompt was sent on any Thread, whatever the title; false for other Sessions.
    pub unused: bool,
    /// A Main Thread Turn ended (not cancelled) since the user last viewed the Session.
    pub unseen: bool,
    pub workspace: WorkspaceInfo,
    /// A Sub Session: the Session whose Agent started it (`session_start`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<SessionParent>,
    /// Why new Events are not being saved to the Session Log right now (disk full, no permission, ...).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_error: Option<String>,
}

/// Where a Sub Session comes from: the Session, Thread and tool call that started it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct SessionParent {
    pub session_id: SessionId,
    pub thread_id: ThreadId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// Whether the parent's Agent gets a message when a Turn it started here ends, or this Session
    /// waits for the user meanwhile. Default on.
    #[serde(default = "yes")]
    pub notify: bool,
}

fn yes() -> bool {
    true
}

/// Who sent a prompt when it was not the user: the Agent of a parent Session prompting its Sub
/// Session, or the Harness telling a parent about its Sub Sessions (`session_id` and `title` then
/// name the first of them).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct PromptOrigin {
    pub session_id: SessionId,
    pub title: String,
    #[serde(default)]
    pub kind: PromptOriginKind,
    /// `SubSession`: what the Harness reported, one per Sub Session, so a Frontend can show that
    /// instead of the prompt text (which is written for the Agent).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reports: Vec<SubSessionReport>,
}

/// One Sub Session in a prompt the Harness sent its parent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct SubSessionReport {
    pub session_id: SessionId,
    pub title: String,
    pub kind: SubSessionReportKind,
    /// `Ended`: the ACP stop reason (`end_turn`, `cancelled`, ...) or `error`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
    /// `Ended`: how long the Turn took.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<specta_typescript::Number>)]
    pub duration_ms: Option<i64>,
    /// The prompt that started the Turn (from the parent's Agent).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asked: Option<String>,
    /// `Ended`: its last reply, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum SubSessionReportKind {
    /// Its Turn ended.
    Ended,
    /// It waits for the user to answer a permission request.
    NeedsUser,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum PromptOriginKind {
    /// The parent Session's Agent.
    #[default]
    Parent,
    /// The Harness, with news from Sub Sessions.
    SubSession,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Idle,
    Working,
    NeedsAttention,
}
