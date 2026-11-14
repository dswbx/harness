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
    },
    /// A Turn ended (`stop_reason` as in `TurnEnded`).
    TurnFinished {
        session_id: SessionId,
        thread_id: ThreadId,
        title: String,
        stop_reason: String,
    },
    /// Agents were installed, updated or removed.
    AgentsChanged,
    /// A Session's Terminal tabs opened, closed, or a shell started or ended: re-list them.
    /// Titles and `busy` change silently: poll while a Terminal is shown.
    TerminalsChanged {
        session_id: SessionId,
    },
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
    PanelSourceChanged {
        session_id: SessionId,
        name: String,
    },
    /// A Shared Artifact's content, state or meta changed (ADR 0024): Views showing it re-read it.
    /// Live only, not logged.
    SharedArtifactChanged {
        id: String,
    },
    /// Shared Artifacts were added, removed, renamed, attached or detached: reload the list.
    SharedArtifactsChanged,
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
