//! `session.json`: the Session's persisted metadata.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::Session;
use crate::api::{AgentInfo, SessionId, ThreadId};

/// Persisted as `session.json` in the Session Directory.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionMeta {
    pub id: SessionId,
    pub title: String,
    pub folder: String,
    pub agent: AgentInfo,
    pub frontend_id: String,
    pub created_ms: i64,
    pub main_thread_id: ThreadId,
    #[serde(default)]
    pub side_threads: Vec<ThreadId>,
    /// Last Agent Session id per Thread, used to resume or load.
    #[serde(default)]
    pub agent_sessions: HashMap<ThreadId, String>,
    /// Context Seeds waiting to be sent with a Thread's next prompt.
    #[serde(default)]
    pub seeds: HashMap<ThreadId, String>,
    /// Threads whose next prompt starts with `<harness_context>` (a new Agent Session).
    #[serde(default)]
    pub context_pending: HashSet<ThreadId>,
    /// Forked Threads whose next prompt starts with the short Side Thread note instead (the fork
    /// already has the full `<harness_context>`).
    #[serde(default)]
    pub fork_note_pending: HashSet<ThreadId>,
    /// Side Threads: where they came from (Main Thread Turn) and how their Agent Session starts.
    #[serde(default)]
    pub origins: HashMap<ThreadId, SideOrigin>,
    #[serde(default)]
    pub workspace: WorkspaceMeta,
    #[serde(default)]
    pub archived: bool,
    /// MCP Library servers given to the Agent.
    #[serde(default)]
    pub mcp_servers: Vec<String>,
    /// The title was taken from the log's `SessionInfoUpdated` events once (Sessions from before titles were kept here).
    #[serde(default)]
    pub title_backfilled: bool,
    /// A Quick Session: the Harness made `folder` for it and deletes it with the Session.
    #[serde(default)]
    pub quick: bool,
    /// Quick Session with no prompt yet on any Thread. It can be discarded (`is_discardable`).
    #[serde(default)]
    pub awaiting_first_prompt: bool,
    /// The title is a placeholder: the first Main Thread prompt replaces it.
    #[serde(default)]
    pub title_from_prompt: bool,
    /// A Sub Session: the Session whose Agent started it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<crate::api::SessionParent>,
    /// Config option values (id -> value) the first Agent Session starts with, over the remembered
    /// ones (a Sub Session's model and effort). Never written to the remembered config.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub initial_config: std::collections::BTreeMap<String, String>,
}

/// Title of a Quick Session until its first prompt.
pub const QUICK_TITLE: &str = "New Quick Session";

/// A title from the first line of a prompt: up to 40 characters.
pub(crate) fn title_from_text(text: &str) -> Option<String> {
    const MAX: usize = 40;
    let line = text.lines().map(str::trim).find(|l| !l.is_empty())?;
    let mut title: String = line.chars().take(MAX).collect();
    if line.chars().count() > MAX {
        title = format!("{}…", title.trim_end());
    }
    Some(title)
}

/// How a Side Thread starts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SideOrigin {
    pub point: crate::api::ForkPoint,
    pub source: crate::api::ThreadStart,
    /// The mode option value the user chose to start in; `None`: the mode that asks before writes.
    #[serde(default)]
    pub mode: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WorkspaceMeta {
    /// Repository containing the Workspace Folder, if any.
    pub repo_root: Option<PathBuf>,
    pub worktree: Option<crate::workspace::WorktreeMeta>,
    /// Base branch without a Worktree (a PR checked out in the folder); diffs and commits compare against it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
    /// PR number when the Session was started from a PR.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr: Option<u32>,
    /// The last PR found for the branch the Session works on, when it was not started from a PR.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_pr: Option<BranchPrMeta>,
    /// The last state and checks seen of a PR of the Session, for the Session list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr_status: Option<PrStatusMeta>,
}

/// A PR's state and checks when last looked up.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PrStatusMeta {
    pub number: u32,
    pub state: crate::api::PrState,
    pub checks: crate::api::PrChecks,
}

/// A PR found by head branch; only shown while that branch is checked out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BranchPrMeta {
    pub branch: String,
    pub number: u32,
}

impl SessionMeta {
    /// The repository a Session works in: a Worktree's main repo (it outlives the Worktree), else the folder's.
    pub fn repo_folder(&self) -> Option<PathBuf> {
        self.workspace.worktree.as_ref().map(|w| w.repo_root.clone()).or_else(|| self.workspace.repo_root.clone())
    }
}

impl Session {
    pub fn update_meta<R>(&self, f: impl FnOnce(&mut SessionMeta) -> R) -> anyhow::Result<R> {
        let mut meta = self.meta.lock();
        let r = f(&mut meta);
        write_meta(&self.dir, &meta)?;
        Ok(r)
    }
}

pub(super) fn write_meta(dir: &Path, meta: &SessionMeta) -> anyhow::Result<()> {
    crate::fsutil::write_atomic(&dir.join("session.json"), &serde_json::to_vec_pretty(meta)?)
}

#[cfg(test)]
mod meta_tests {
    use super::*;

    #[test]
    fn old_session_json_without_sub_session_fields_round_trips() {
        let old = r#"{"id":"s","title":"T","folder":"/f","agent":{"id":"a","name":"A","command":"a","args":[],"env":{}},"frontend_id":"chat","created_ms":1,"main_thread_id":"m"}"#;
        let m: SessionMeta = serde_json::from_str(old).unwrap();
        assert_eq!((m.parent.as_ref(), m.initial_config.len()), (None, 0));
        let json = serde_json::to_string(&m).unwrap();
        assert!(!json.contains("parent") && !json.contains("initial_config"), "{json}");
        let again: SessionMeta = serde_json::from_str(&json).unwrap();
        assert_eq!(again.id, "s");
    }
}
