//! Review Comments: line comments on a diff or a file, kept in the Session Log (ADR 0027).

use serde::{Deserialize, Serialize};
use specta::Type;

use super::StateWriter;

/// The side of a diff a comment is on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum CommentSide {
    Old,
    New,
}

/// A comment on one line. `side`: `Some` for a diff comment, `None` for a file comment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct LineComment {
    /// `c1`, `c2`, ...: never reused in a Session.
    pub id: String,
    /// Workspace-relative.
    pub path: String,
    /// 1-based.
    pub line: u32,
    pub side: Option<CommentSide>,
    /// The commented line's text.
    pub code: String,
    pub text: String,
    pub by: StateWriter,
}

/// `Pending`: the user's draft, in the prompt box (editable, deletable). `Open`: sent, immutable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum CommentStatus {
    Pending,
    Open,
    Resolved,
}

/// A comment with where it stands, as the Session Log projects it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct CommentState {
    pub comment: LineComment,
    pub status: CommentStatus,
    pub resolved_by: Option<StateWriter>,
    pub note: Option<String>,
}
