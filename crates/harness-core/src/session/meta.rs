//! `session.json`: the Session's persisted metadata.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

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
    /// A Main Thread Turn ended since the user last viewed the Session (`MarkSessionSeen`).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub unseen: bool,
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
    /// The title was set on purpose (`SetSessionTitle`, the `set_title` tool): titles the Agent
    /// sends no longer replace it.
    #[serde(default)]
    pub title_explicit: bool,
    /// The last title the Agent sent (ACP `session_info_update`, the `set_title` tool), kept even
    /// when `title_explicit` drops it: `ResetSessionTitle` goes back to it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_title: Option<String>,
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
    pub worktree: Option<crate::git::WorktreeMeta>,
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
    /// A Quick Session with no prompt yet (`SessionSummary::unused`).
    pub fn unused(&self) -> bool {
        self.quick && self.awaiting_first_prompt
    }

    /// The repository a Session works in: a Worktree's main repo (it outlives the Worktree), else the folder's.
    pub fn repo_folder(&self) -> Option<PathBuf> {
        self.workspace.worktree.as_ref().map(|w| w.repo_root.clone()).or_else(|| self.workspace.repo_root.clone())
    }

    /// Whose Custom Instructions apply: the repository's main checkout (shared by its Worktrees),
    /// else the folder. None for a Quick Session; `Instructions::folder_of` also skips its folder.
    pub fn instructions_folder(&self) -> Option<PathBuf> {
        if self.quick {
            return None;
        }
        // A live Worktree's own `.git` leads to the main checkout, even when it was cut from
        // another Worktree that is gone now (its recorded repo_root).
        if let Some(wt) = &self.workspace.worktree {
            let main = crate::instructions::main_checkout(&wt.path);
            if main != wt.path {
                return Some(main);
            }
        }
        Some(self.repo_folder().map_or_else(|| PathBuf::from(&self.folder), |r| crate::instructions::main_checkout(&r)))
    }
}

/// Writes `session.json`. The bytes are made under the `meta` lock (`snapshot`, which numbers
/// them), the fsynced write happens outside it (`write`): every streamed notification reads `meta`.
/// A version no newer than what is on disk is skipped, so an older snapshot never lands last.
pub(super) struct MetaDisk {
    path: PathBuf,
    version: AtomicU64,
    written: parking_lot::Mutex<u64>,
}

impl MetaDisk {
    pub(super) fn new(dir: &Path) -> Self {
        Self { path: dir.join("session.json"), version: AtomicU64::new(0), written: parking_lot::Mutex::new(0) }
    }

    /// Call with the `meta` lock held.
    pub(super) fn snapshot(&self, meta: &SessionMeta) -> anyhow::Result<(Vec<u8>, u64)> {
        let version = self.version.fetch_add(1, Ordering::SeqCst) + 1;
        Ok((serde_json::to_vec_pretty(meta)?, version))
    }

    /// Call without the `meta` lock.
    pub(super) fn write(&self, bytes: &[u8], version: u64) -> anyhow::Result<()> {
        let mut written = self.written.lock();
        if *written < version {
            crate::fsutil::write_atomic(&self.path, bytes)?;
            *written = version;
        }
        Ok(())
    }
}

impl Session {
    pub fn update_meta<R>(&self, f: impl FnOnce(&mut SessionMeta) -> R) -> anyhow::Result<R> {
        let (r, bytes, version) = {
            let mut meta = self.meta.lock();
            let r = f(&mut meta);
            let (bytes, version) = self.meta_disk.snapshot(&meta)?;
            (r, bytes, version)
        };
        self.meta_disk.write(&bytes, version)?;
        Ok(r)
    }
}

pub(super) fn write_meta(dir: &Path, meta: &SessionMeta) -> anyhow::Result<()> {
    // The same bytes and atomic write as `update_meta` (through `MetaDisk`).
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

    #[test]
    fn write_meta_is_atomic_and_keeps_the_shape() {
        let old = r#"{"id":"s","title":"T","folder":"/f","agent":{"id":"a","name":"A","command":"a","args":[],"env":{}},"frontend_id":"chat","created_ms":1,"main_thread_id":"m"}"#;
        let m: SessionMeta = serde_json::from_str(old).unwrap();
        let d = tempfile::tempdir().unwrap();
        write_meta(d.path(), &m).unwrap();
        write_meta(d.path(), &m).unwrap();
        let back: SessionMeta = serde_json::from_slice(&std::fs::read(d.path().join("session.json")).unwrap()).unwrap();
        assert_eq!((back.id, back.title), ("s".to_owned(), "T".to_owned()));
        assert_eq!(std::fs::read_dir(d.path()).unwrap().count(), 1);
    }

    /// Updates race: each takes its snapshot under the lock and writes outside it. The newest
    /// snapshot is what stays on disk, whatever order the writes happen in.
    #[test]
    fn concurrent_meta_writes_end_with_the_newest_snapshot() {
        use std::sync::Arc;
        let old = r#"{"id":"s","title":"0","folder":"/f","agent":{"id":"a","name":"A","command":"a","args":[],"env":{}},"frontend_id":"chat","created_ms":1,"main_thread_id":"m"}"#;
        let dir = tempfile::tempdir().unwrap();
        let disk = Arc::new(MetaDisk::new(dir.path()));
        let meta = Arc::new(parking_lot::Mutex::new(serde_json::from_str::<SessionMeta>(old).unwrap()));
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let (disk, meta) = (disk.clone(), meta.clone());
                std::thread::spawn(move || {
                    for _ in 0..40 {
                        let (bytes, version) = {
                            let mut m = meta.lock();
                            m.title = (m.title.parse::<u32>().unwrap() + 1).to_string();
                            disk.snapshot(&m).unwrap()
                        };
                        std::thread::yield_now();
                        disk.write(&bytes, version).unwrap();
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        let stored: SessionMeta = serde_json::from_slice(&std::fs::read(dir.path().join("session.json")).unwrap()).unwrap();
        assert_eq!(stored.title, "320");
        assert_eq!(meta.lock().title, "320");
    }
}
