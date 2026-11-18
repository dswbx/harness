//! Task types (ADR 0028): the user's own work items, kept across Sessions in `<data dir>/tasks/`.
//! Not the Agent's Task List.

use serde::{Deserialize, Serialize};
use specta::Type;

use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Backlog,
    #[default]
    Todo,
    InProgress,
    InReview,
    Done,
    Blocked,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum TaskPriority {
    #[default]
    None,
    Low,
    Medium,
    High,
    Urgent,
}

/// The task's item in another tracker (Linear, GitHub, ...).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct TaskUpstream {
    pub url: String,
    #[serde(default)]
    pub label: Option<String>,
}

/// A file in the task's `files/` folder; `name` is its file name there.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct TaskAsset {
    pub name: String,
    pub mime: String,
    #[specta(type = specta_typescript::Number)]
    pub size: u64,
}

/// A Session started from the task. `title` is cached for when the Session is gone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct TaskSessionLink {
    pub session_id: SessionId,
    pub title: String,
    #[specta(type = specta_typescript::Number)]
    pub started_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TaskActivityKind {
    Created,
    /// The parent changed (`None`: no parent).
    Moved {
        from: Option<String>,
        to: Option<String>,
    },
    StatusChanged {
        from: TaskStatus,
        to: TaskStatus,
    },
    SessionStarted {
        session_id: SessionId,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct TaskActivity {
    #[specta(type = specta_typescript::Number)]
    pub at_ms: i64,
    pub by: StateWriter,
    /// The Session it happened in, if any.
    pub session_id: Option<SessionId>,
    pub kind: TaskActivityKind,
}

/// `tasks/<id>/task.json` (`v: 1`). Fields added later take `serde(default)`; there are no migrations.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct Task {
    pub v: u32,
    /// `t<n>`; never changes.
    pub id: String,
    /// One line of Markdown.
    pub title: String,
    /// Markdown.
    pub body: String,
    pub status: TaskStatus,
    pub priority: TaskPriority,
    /// `YYYY-MM-DD`, a local date.
    pub due: Option<String>,
    pub upstream: Option<TaskUpstream>,
    pub parent_id: Option<String>,
    /// Position among its siblings (ascending).
    #[specta(type = specta_typescript::Number)]
    pub order: f64,
    /// The Session it was created in; kept after that Session is deleted.
    pub origin_session_id: Option<SessionId>,
    /// The origin Session's title when the task was created.
    pub origin_title: Option<String>,
    pub sessions: Vec<TaskSessionLink>,
    pub assets: Vec<TaskAsset>,
    #[specta(type = specta_typescript::Number)]
    pub created_ms: i64,
    /// Last change of any field.
    #[specta(type = specta_typescript::Number)]
    pub updated_ms: i64,
    /// Last change of `body`: `UpdateTask` checks `base_updated_ms` against it.
    #[specta(type = specta_typescript::Number)]
    pub body_updated_ms: i64,
    /// The last 100 entries, oldest first.
    pub activity: Vec<TaskActivity>,
}

/// One row of `ListTasks`: a `Task` without `body` and `activity`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct TaskSummary {
    pub id: String,
    pub title: String,
    pub has_body: bool,
    pub status: TaskStatus,
    pub priority: TaskPriority,
    pub due: Option<String>,
    pub upstream: Option<TaskUpstream>,
    pub parent_id: Option<String>,
    #[specta(type = specta_typescript::Number)]
    pub order: f64,
    pub origin_session_id: Option<SessionId>,
    pub origin_title: Option<String>,
    pub sessions: Vec<TaskSessionLink>,
    pub assets: Vec<TaskAsset>,
    #[specta(type = specta_typescript::Number)]
    pub created_ms: i64,
    #[specta(type = specta_typescript::Number)]
    pub updated_ms: i64,
}

impl From<&Task> for TaskSummary {
    fn from(t: &Task) -> Self {
        Self {
            id: t.id.clone(),
            title: t.title.clone(),
            has_body: !t.body.trim().is_empty(),
            status: t.status,
            priority: t.priority,
            due: t.due.clone(),
            upstream: t.upstream.clone(),
            parent_id: t.parent_id.clone(),
            order: t.order,
            origin_session_id: t.origin_session_id.clone(),
            origin_title: t.origin_title.clone(),
            sessions: t.sessions.clone(),
            assets: t.assets.clone(),
            created_ms: t.created_ms,
            updated_ms: t.updated_ms,
        }
    }
}

/// A field `TaskPatch::clear` sets to none.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum TaskField {
    Due,
    Upstream,
}

/// The fields `UpdateTask` changes; a missing field stays. The parent changes with `MoveTask`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
pub struct TaskPatch {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub status: Option<TaskStatus>,
    #[serde(default)]
    pub priority: Option<TaskPriority>,
    /// `YYYY-MM-DD`.
    #[serde(default)]
    pub due: Option<String>,
    #[serde(default)]
    pub upstream: Option<TaskUpstream>,
    /// Fields set to none (applied before the values above).
    #[serde(default)]
    pub clear: Vec<TaskField>,
}
