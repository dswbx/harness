//! Harness-wide notifications, Event sinks and `Lagged`.

use serde::{Deserialize, Serialize};
use specta::Type;

use super::*;

/// Harness-wide notifications (session list, attention), separate from Session Logs.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type")]
pub enum AppEvent {
    /// Sessions were created, deleted, archived or unarchived: reload the list.
    SessionsChanged,
    SessionStatus {
        session_id: SessionId,
        title: String,
        status: SessionStatus,
        /// As `SessionSummary::unused`.
        unused: bool,
        /// As `SessionSummary::unseen`.
        unseen: bool,
    },
    /// A Turn ended (`stop_reason` as in `TurnEnded`). `main`: true for the Main Thread, false for a Side Thread.
    TurnFinished { session_id: SessionId, thread_id: ThreadId, title: String, stop_reason: String, main: bool },
    /// Agents were installed, updated or removed.
    AgentsChanged,
    /// A Session's Terminal tabs opened, closed, or a shell started or ended: re-list them.
    /// Titles and `busy` change silently: poll while a Terminal is shown.
    TerminalsChanged { session_id: SessionId },
    /// The Agent called a Frontend Tool that `replies`: a window answers with `AnswerFrontendRequest`.
    /// `last_seq` is the newest Session Log event at request time, so a UI can replay the log up to
    /// it. Live only and not logged: Views still render only from the Session Log.
    FrontendRequest {
        session_id: SessionId,
        request_id: String,
        tool: String,
        #[specta(type = specta_typescript::Unknown)]
        input: Json,
        #[specta(type = specta_typescript::Number)]
        last_seq: u64,
    },
    /// A file in the Session's `panels/` folder changed (ADR 0023): windows showing a panel with
    /// this `source` re-read it. Sent once per burst of writes; live only and not logged.
    PanelSourceChanged { session_id: SessionId, name: String },
    /// A Shared Artifact's content, state or meta changed (ADR 0024): Views showing it re-read it.
    /// Live only, not logged.
    SharedArtifactChanged { id: String },
    /// Shared Artifacts were added, removed, renamed, attached or detached: reload the list.
    SharedArtifactsChanged,
    /// Tasks were created, changed, moved, deleted or linked: re-read the open ones among `ids`.
    /// `tasks` holds the current summaries of the `ids` that still exist; an id without one was
    /// deleted. A list applies them in place. Live only, not logged.
    TasksChanged { ids: Vec<String>, tasks: Vec<TaskSummary> },
    /// A Session's Session Note was written or got images: re-read it. Live only, not logged.
    NoteChanged { session_id: SessionId },
    /// A Session's Log could not be written (`error`: why) or can be again (`error` null). While
    /// it cannot, new Events reach Views live but are lost on reload; `dropped` (on recovery) counts them.
    /// Live only, not logged. Also `SessionSummary::log_error`.
    SessionLogHealth { session_id: SessionId, error: Option<String>, dropped: u32 },
    /// A settings file did not load and was reset (see `Command::TakeNotices`).
    NoticesChanged,
}

/// Why a settings file was reset.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum NoticeKind {
    /// Not valid JSON.
    Corrupt,
    /// Valid JSON of another shape, e.g. written by a newer version.
    Unreadable,
}

/// A settings file in the data folder that did not load: reset to defaults, the file kept.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct StartupNotice {
    /// File name, e.g. `permissions.json`.
    pub file: String,
    pub kind: NoticeKind,
    /// The file's full path.
    pub path: String,
    /// Where the file was moved; `None` when that failed and it stays at `path` (never overwritten).
    pub copy: Option<String>,
    /// What was reset and why, in plain words.
    pub message: String,
}

/// The View fell too far behind and its subscription was dropped. Events up to `last_seq` were
/// delivered (`null`: none yet); resubscribe from `last_seq + 1` (from the first `from_seq`
/// when `null`).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Lagged {
    #[specta(type = Option<specta_typescript::Number>)]
    pub last_seq: Option<u64>,
}

/// Receives Events for one subscription. Returns `false` once the receiver is gone.
pub trait EventSink: Send + Sync + 'static {
    fn send(&self, event: &Event) -> bool;
    /// The subscription was dropped because the receiver was too slow (see `Lagged`).
    fn lagged(&self, _last_seq: Option<u64>) {}
}

impl<F: Fn(&Event) -> bool + Send + Sync + 'static> EventSink for F {
    fn send(&self, event: &Event) -> bool {
        self(event)
    }
}
