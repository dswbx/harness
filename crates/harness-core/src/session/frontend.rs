//! A Session's Frontend: Frontend Tool outputs, items and errors, requests to the windows, the
//! `frontend/` files and the Session State.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::Session;
use crate::api::{EventKind, ThreadId};

/// Most errors kept per Frontend Tool item, and the longest message (bytes).
pub const MAX_FRONTEND_ERRORS: usize = 5;
pub const MAX_FRONTEND_ERROR_LEN: usize = 300;

/// A live Frontend Tool item (`frontend_items`): its latest input, and when that call was logged.
#[derive(Debug, Clone)]
pub struct FrontendItem {
    pub tool: String,
    pub id: String,
    pub input: serde_json::Value,
    pub ts_ms: i64,
    /// The Thread of its latest call.
    pub thread: Option<ThreadId>,
    /// Its latest call's copied images: src -> path relative to `frontend/`.
    pub files: std::collections::BTreeMap<String, String>,
}

/// The Frontend Tool that shows panels, and so Shared Artifacts.
pub const RENDER_UI: &str = "render_ui";

/// A `FrontendError` not cleared yet.
/// Frontend Tool items by `(tool, item id)`, with the Thread of their latest call.
type FrontendItems = HashMap<(String, String), ThreadId>;

#[derive(Debug, Clone)]
pub struct FrontendErrorEntry {
    pub seq: u64,
    pub thread: ThreadId,
    pub tool: String,
    pub item: String,
    pub message: String,
}

/// How long a Frontend Tool that `replies` waits for a window.
const FRONTEND_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

/// Frontend requests waiting for their answer: request id -> who waits.
#[derive(Default)]
pub(super) struct FrontendRequests(parking_lot::Mutex<HashMap<String, tokio::sync::oneshot::Sender<crate::api::FrontendAnswer>>>);

/// Removes a request from `FrontendRequests` when the wait ends in any way, also when the future is dropped.
struct PendingFrontendRequest<'a>(&'a FrontendRequests, String);

impl Drop for PendingFrontendRequest<'_> {
    fn drop(&mut self) {
        self.0.0.lock().remove(&self.1);
    }
}

impl FrontendRequests {
    /// Adds a request, calls `emit` with its id, and waits for the answer.
    async fn wait(&self, timeout: Duration, emit: impl FnOnce(String)) -> anyhow::Result<crate::api::FrontendAnswer> {
        let request_id = uuid::Uuid::now_v7().to_string();
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.0.lock().insert(request_id.clone(), tx);
        let _pending = PendingFrontendRequest(self, request_id.clone());
        emit(request_id);
        match tokio::time::timeout(timeout, rx).await {
            Ok(answer) => Ok(answer?),
            Err(_) => Err(crate::error::timeout("No app window answered in time. The window may be closed or the Mac asleep.")),
        }
    }

    /// The first answer wins; later ones and unknown ids do nothing.
    fn answer(&self, request_id: &str, answer: crate::api::FrontendAnswer) {
        if let Some(tx) = self.0.lock().remove(request_id) {
            let _ = tx.send(answer);
        }
    }
}

impl Session {
    /// The Session's Frontend.
    pub fn frontend(&self) -> Option<crate::api::FrontendManifest> {
        let id = self.meta.lock().frontend_id.clone();
        self.shared.frontends.read().iter().find(|f| f.id == id).cloned()
    }

    /// Frontend Tools of the Session's Frontend.
    pub fn frontend_tools(&self) -> Vec<crate::api::FrontendToolDecl> {
        let id = self.meta.lock().frontend_id.clone();
        self.shared.frontends.read().iter().find(|f| f.id == id).map(|f| f.frontend_tools.clone()).unwrap_or_default()
    }

    /// Asks the Session's windows to answer a Frontend Tool call (`FrontendToolDecl::replies`).
    pub async fn request_frontend(&self, tool: &str, input: serde_json::Value) -> anyhow::Result<crate::api::FrontendAnswer> {
        let last_seq = self.log.last_seq()?;
        self.frontend_requests
            .wait(FRONTEND_REQUEST_TIMEOUT, |request_id| {
                self.shared.app_events.emit(crate::api::AppEvent::FrontendRequest {
                    session_id: self.id(),
                    request_id,
                    tool: tool.to_owned(),
                    input,
                    last_seq,
                });
            })
            .await
    }

    pub fn answer_frontend_request(&self, request_id: &str, answer: crate::api::FrontendAnswer) {
        self.frontend_requests.answer(request_id, answer);
    }

    /// Stores a validated Frontend Tool call under `frontend/tools/<tool>/<call id>.json` and
    /// logs it. Returns the path relative to `frontend/`.
    pub fn write_frontend_tool_output(
        &self,
        thread: &ThreadId,
        tool: &str,
        input: serde_json::Value,
        files: std::collections::BTreeMap<String, String>,
    ) -> anyhow::Result<String> {
        let call_id = uuid::Uuid::now_v7().to_string();
        let rel = format!("tools/{tool}/{call_id}.json");
        let path = self.dir.join("frontend").join(&rel);
        std::fs::create_dir_all(crate::env::parent_of(&path)?)?;
        std::fs::write(&path, serde_json::to_vec_pretty(&input)?)?;
        self.log.append(Some(thread.clone()), EventKind::FrontendToolOutput { tool: tool.to_owned(), call_id, path: rel.clone(), input, files })?;
        Ok(rel)
    }

    /// A path inside `frontend/`; refuses absolute paths and `..`.
    pub(crate) fn frontend_path(&self, rel: &str) -> anyhow::Result<PathBuf> {
        let p = Path::new(rel);
        if !p.components().all(|c| matches!(c, std::path::Component::Normal(_) | std::path::Component::CurDir)) {
            return Err(crate::error::policy_denied(format!("{rel} is outside the Frontend's directory")));
        }
        Ok(self.dir.join("frontend").join(p))
    }

    pub fn frontend_read(&self, rel: &str) -> anyhow::Result<String> {
        Ok(std::fs::read_to_string(self.frontend_path(rel)?)?)
    }

    /// The Session State (ADR 0015); `{}` before the first change.
    pub fn state(&self) -> anyhow::Result<serde_json::Value> {
        match std::fs::read(self.dir.join("state.json")) {
            Ok(b) => Ok(serde_json::from_slice(&b)?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::json!({})),
            Err(e) => Err(e.into()),
        }
    }

    /// Applies `ops` to the Session State (all or nothing), stores it and logs `StateChanged`.
    pub fn patch_state(&self, thread: Option<ThreadId>, ops: Vec<crate::api::StatePatchOp>, by: crate::api::StateWriter) -> anyhow::Result<serde_json::Value> {
        if ops.is_empty() {
            return Err(crate::error::invalid("no operations"));
        }
        let _guard = self.state_lock.lock();
        let next = crate::state::apply(&self.state()?, &ops)?;
        crate::fsutil::write_atomic(&self.dir.join("state.json"), &serde_json::to_vec_pretty(&next)?)?;
        self.log.append(thread, EventKind::StateChanged { ops, by })?;
        Ok(next)
    }

    /// Frontend Tool calls that named an `id` and were not removed since (`remove: true`), in the
    /// order first seen: the live items a Frontend shows (e.g. `render_ui` slots), latest input each.
    pub fn frontend_items(&self) -> anyhow::Result<Vec<FrontendItem>> {
        let mut items: Vec<FrontendItem> = Vec::new();
        for e in self.log.events()? {
            let EventKind::FrontendToolOutput { tool, input, files, .. } = e.kind else { continue };
            let Some(id) = input.get("id").and_then(|v| v.as_str()).map(str::to_owned) else { continue };
            let at = items.iter().position(|x| x.tool == tool && x.id == id);
            match (input.get("remove") == Some(&serde_json::Value::Bool(true)), at) {
                (true, Some(i)) => {
                    items.remove(i);
                }
                (true, None) => {}
                (false, Some(i)) => {
                    items[i] = FrontendItem { tool, id, input, ts_ms: e.ts_ms, thread: e.thread_id, files };
                }
                (false, None) => items.push(FrontendItem { tool, id, input, ts_ms: e.ts_ms, thread: e.thread_id, files }),
            }
        }
        Ok(items)
    }

    /// Errors the UI reported for Frontend Tool items (`FrontendError`) and not cleared since: a
    /// new call with the item's id, or its removal, clears them. Also the items errors can be
    /// reported for, with the Thread of their latest call.
    fn frontend_error_scan(&self) -> anyhow::Result<(FrontendItems, Vec<FrontendErrorEntry>)> {
        let mut items: FrontendItems = HashMap::new();
        let mut errors: Vec<FrontendErrorEntry> = Vec::new();
        for e in self.log.events()? {
            match e.kind {
                EventKind::FrontendToolOutput { tool, call_id, input, .. } => {
                    let Some(thread) = e.thread_id else { continue };
                    match input.get("id").and_then(|v| v.as_str()) {
                        Some(id) => {
                            errors.retain(|x| !(x.tool == tool && x.item == id));
                            let key = (tool, id.to_owned());
                            if input.get("remove") == Some(&serde_json::Value::Bool(true)) {
                                items.remove(&key);
                            } else {
                                items.insert(key, thread);
                            }
                        }
                        None => {
                            items.insert((tool, call_id), thread);
                        }
                    }
                }
                EventKind::FrontendError { tool, item, message } => {
                    errors.push(FrontendErrorEntry { seq: e.seq, thread: e.thread_id.unwrap_or_default(), tool, item, message })
                }
                _ => {}
            }
        }
        errors.retain(|x| items.contains_key(&(x.tool.clone(), x.item.clone())));
        Ok((items, errors))
    }

    /// Current errors of Frontend Tool items, oldest first (see `frontend_error_scan`).
    pub fn frontend_errors(&self) -> anyhow::Result<Vec<FrontendErrorEntry>> {
        Ok(self.frontend_error_scan()?.1)
    }

    /// Logs `FrontendError` for a live item (its `id`, or the call id of a call without one), on
    /// the Thread that made it. Ignores items that are gone, repeats of a current error, and more
    /// than `MAX_FRONTEND_ERRORS` per item; cuts long messages.
    pub fn report_frontend_error(&self, tool: &str, item: &str, message: &str) -> anyhow::Result<()> {
        let mut message = message.trim().to_owned();
        if message.is_empty() {
            return Err(crate::error::invalid("message is required"));
        }
        if message.len() > MAX_FRONTEND_ERROR_LEN {
            message.truncate(message.floor_char_boundary(MAX_FRONTEND_ERROR_LEN));
            message.push('…');
        }
        let (items, errors) = self.frontend_error_scan()?;
        let Some(thread) = items.get(&(tool.to_owned(), item.to_owned())) else { return Ok(()) };
        let current: Vec<_> = errors.iter().filter(|x| x.tool == tool && x.item == item).collect();
        if current.len() >= MAX_FRONTEND_ERRORS || current.iter().any(|x| x.message == message) {
            return Ok(());
        }
        self.log.append(Some(thread.clone()), EventKind::FrontendError { tool: tool.to_owned(), item: item.to_owned(), message })?;
        Ok(())
    }

    pub fn frontend_dir(&self) -> PathBuf {
        self.dir.join("frontend")
    }

    pub fn frontend_read_image(&self, rel: &str) -> anyhow::Result<(String, String)> {
        use base64::Engine;
        let p = self.frontend_path(rel)?;
        let mime = crate::attachments::guess_mime(&p);
        if !crate::attachments::is_image(mime) {
            return Err(crate::error::invalid(format!("{rel} is not an image")));
        }
        Ok((mime.to_owned(), base64::engine::general_purpose::STANDARD.encode(std::fs::read(&p)?)))
    }

    pub fn frontend_write(&self, rel: &str, content: &str) -> anyhow::Result<()> {
        let path = self.frontend_path(rel)?;
        if rel.trim().is_empty() {
            return Err(crate::error::invalid("path is required"));
        }
        std::fs::create_dir_all(crate::env::parent_of(&path)?)?;
        crate::fsutil::write_atomic(&path, content.as_bytes())?;
        Ok(())
    }

    pub fn frontend_list(&self, rel: &str) -> anyhow::Result<Vec<String>> {
        let root = self.dir.join("frontend");
        let start = self.frontend_path(rel)?;
        let mut out = Vec::new();
        let mut stack = vec![start];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else { continue };
            for e in entries.flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                } else if let Ok(r) = p.strip_prefix(&root) {
                    out.push(r.display().to_string());
                }
            }
        }
        out.sort();
        Ok(out)
    }
}

#[cfg(test)]
mod frontend_request_tests {
    use super::*;

    #[tokio::test]
    async fn a_timeout_or_a_dropped_wait_removes_the_request() {
        let requests = FrontendRequests::default();
        let err = requests.wait(Duration::from_millis(1), |_| {}).await.unwrap_err();
        assert_eq!(err.to_string(), "No app window answered in time. The window may be closed or the Mac asleep.");
        assert!(requests.0.lock().is_empty());

        let wait = requests.wait(Duration::from_secs(60), |_| {});
        assert!(tokio::time::timeout(Duration::from_millis(1), wait).await.is_err());
        assert!(requests.0.lock().is_empty());
    }
}
