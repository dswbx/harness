//! Shared Artifact types.

use serde::{Deserialize, Serialize};
use specta::Type;

use super::*;

/// What a Shared Artifact holds: `content.md`, `content.html`, or a `render_ui` tree in `ui.json`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum SharedKind {
    Md,
    Html,
    Ui,
}

/// The Session that made an artifact shared.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct SharedCreator {
    pub session_id: SessionId,
    pub session_title: String,
    /// What it was copied from in that Session, as the Frontend names it (an Artifacts panel key,
    /// e.g. `<row id>:table:0`). Lets that Session list the source and the copy once.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
}

/// `shared/<id>/meta.json` (ADR 0024). `attached` is a cache; the Session Logs are the truth.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct SharedArtifactMeta {
    pub v: u32,
    /// `<slug>-<6 hex>`; never changes.
    pub id: String,
    pub title: String,
    pub kind: SharedKind,
    #[specta(type = specta_typescript::Number)]
    pub created_ms: i64,
    /// Last change of content, state or meta.
    #[specta(type = specta_typescript::Number)]
    pub updated_ms: i64,
    pub created_by: SharedCreator,
    #[serde(default)]
    pub attached: Vec<SessionId>,
}

/// One row of `ListSharedArtifacts`. `snippet`: text around the match, for a search.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SharedArtifactEntry {
    pub meta: SharedArtifactMeta,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
}
