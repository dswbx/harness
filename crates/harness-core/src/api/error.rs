//! Command errors.

use serde::{Deserialize, Serialize};
use specta::Type;

/// Why a Command failed, so Frontends branch on a code and never on the message text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// The Agent needs the user to sign in first.
    AuthRequired,
    /// A Session, Thread, Agent or other id the Command names does not exist.
    NotFound,
    /// The Command conflicts with the current state (already exists, archived, unmerged work).
    Conflict,
    /// The Permission Policy or a sandbox rule forbids it (a path outside the Session's folder).
    PolicyDenied,
    /// The Agent is not running, not installed or its Agent Session could not be restored.
    AgentUnavailable,
    /// The Command's input is wrong (empty, malformed), or the request cannot apply to this Workspace
    /// (not a git repository, no GitHub remote, a detached HEAD).
    Invalid,
    /// A process or request the Command waits on did not finish in time (`git`, `gh`, a download).
    Timeout,
    /// The Harness cannot serve the Command now (it is shutting down) or a service it needs cannot be reached (the network is down, `gh` is missing).
    Unavailable,
    /// The file can hold secrets (`editor::sensitive`: a hidden folder in the home folder, `~/Library`, an `.env`,
    /// key or credentials file, outside the home folder): the user must allow it for the Session first (`ApproveSessionFile`). The message is the reason only;
    /// `HarnessError::path` is the real file an approval unlocks.
    NeedsApproval,
    /// Anything else.
    Internal,
}

/// The error of a Command: a code to branch on and a message for the user.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct HarnessError {
    pub code: ErrorCode,
    pub message: String,
    /// With `NeedsApproval`: the real file (symlinks followed) an approval unlocks, `~/…` in the home folder, else
    /// absolute. It can differ from the path asked for (a symlink in the folder); approve this one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

impl std::fmt::Display for HarnessError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for HarnessError {}
