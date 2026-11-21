//! Session Log: append-only JSONL in the Session Directory, plus live fan-out to subscribed Views.
//!
//! **Never lose history.** The file is only ever appended to, except that open cuts a torn final
//! line (no trailing newline, so it never parsed). The writer thread never cuts anything: after a
//! failed write it adds a newline to a file that does not end in one, so a half-written line
//! becomes a bad line instead of running into the next Event. A complete line that does not parse
//! is kept, after a one-time copy of the file to `log.jsonl.corrupt-<ts_ms>`; it reads as
//! `EventKind::Unknown` (the original text stays in the file only; a type this build does not
//! know is not counted as a bad line) or, when it is not even JSON, is left out of the in-memory
//! view. An Event with a `v` newer than this build knows opens the Session read-only.
//! Old shapes are read through `upcast` (ADR 0021).
//!
//! **Memory.** Events load into memory on first need (`events`, `subscribe`, a projection, the first append), not
//! on open. After that reads never touch the file. `events` hands out shared `Arc<Event>` handles
//! (cold paths: export, replay, transcripts). Hot paths read projections kept up to date on append and
//! rebuilt on load: mode, title, attached Shared Artifacts, Frontend items and errors, open Turn,
//! newest config options. `tests/projections.rs` pins each to a scan of all Events. The first
//! append of a run also loads (so every Event reaches memory and the projections); loading closes
//! what an earlier run left open (see `close_dangling`).
//!
//! **Startup.** `sync` writes a checkpoint (`log.checkpoint.json`: `next_seq`, `last_ts_ms`,
//! `agent_was_running`, `byte_len`). Open trusts it when the file is at least `byte_len` long and
//! parses only the bytes after it; otherwise it scans the whole file.
//!
//! **Writes** go to one writer thread per log (spawned on the first append), so file I/O never
//! runs on an async runtime thread or under the append lock. **Fan-out**: every subscriber has a
//! bounded queue drained by its own thread, which calls the sink. Appends never wait for a sink.
//! A subscriber whose queue overflows is dropped after `EventSink::lagged`, and the View
//! resubscribes. Replay comes from memory: the boundary `seq` is captured under the lock, so
//! replay then live has no gaps and no duplicates.
//!
//! **A failing disk** (full, no permission, file gone) never stops the Session: the Event still
//! gets its `seq`, memory and subscribers, and the log turns `degraded` (a `LogHealth` change goes
//! to the hook, which the Session turns into `AppEvent::SessionLogHealth`). The failed Event is
//! dropped and counted, not queued, so memory stays bounded; the next write reopens the file and
//! tries again, and the first good one clears the flag. The file stays well formed with `seq`
//! ascending but gapped, and a reload misses the dropped Events. The log is loaded before the
//! first append, so every Event reaches memory and the projections whether or not it was written.
//! `next_seq` never goes back (the checkpoint keeps it), so a dropped `seq` is not handed out
//! again after a restart that finds the checkpoint; `last_seq` after a restart is the newest
//! `seq` actually in the file. A restart while the disk still fails, with no checkpoint written
//! since the drop, can reuse the dropped `seq`s: the log cannot record what it could not write.
//! A reopened file that is another file, or shorter than expected, is appended to at its end and
//! its checkpoint removed.
//!
//! Message and thought chunks are coalesced: a chunk is held for up to `COALESCE` (its `seq`
//! already reserved) and later chunks of the same kind and Thread are appended to it. Any other
//! append, a subscribe, a read or a sync flushes it first, so ordering is unchanged. Agents that
//! stream token by token would otherwise write one event per token.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, SyncSender, TrySendError};
use std::sync::{Arc, Weak};
use std::time::Duration;

use crate::api::{EVENT_SCHEMA_VERSION, Event, EventKind, EventSink, LogPage, ProcessState, SessionId, ThreadId};
use crate::session::{FrontendErrorEntry, FrontendItem};

pub type SubscriptionId = u64;

/// How long a chunk may wait for the next one.
const COALESCE: Duration = Duration::from_millis(50);

/// Events a subscriber may fall behind by before it is dropped with `Lagged`.
const QUEUE_CAP: usize = 4096;

/// Most Events in one page a View reads (`SessionLog::read_page`, ADR 0029).
pub const PAGE_EVENTS: usize = 2000;
/// Most bytes of serialized Events in one page. One Event can hold megabytes of tool output, so a
/// page holds at least one Event whatever its size.
pub const PAGE_BYTES: usize = 1 << 20;

/// Rewrites an Event of schema version `v` (as JSON) into the current shape, before it is parsed.
/// Identity while only version 1 exists. A rename or removal of an Event kind or field adds a
/// step here, keyed on `v` (ADR 0021).
pub fn upcast(_v: u16, value: Value) -> Value {
    value
}

/// A config option that is the Agent's mode (ACP category `mode`).
pub(crate) fn is_mode_option(option: &Value) -> bool {
    option["category"] == "mode" || option["id"] == "mode"
}

/// The Agent mode a `ConfigOptionsChanged` reports, when it carries the mode option.
fn config_mode(options: &Value) -> Option<String> {
    options.as_array()?.iter().find(|o| is_mode_option(o)).and_then(|o| o["currentValue"].as_str()).filter(|v| !v.is_empty()).map(str::to_owned)
}

/// Facts derived from the Events, kept current on append.
#[derive(Default)]
struct Projections {
    /// Thread -> its current Agent mode: the newest of its `ModeChanged` events and the mode
    /// option in its `ConfigOptionsChanged` events (Agents without legacy modes only report the latter).
    modes: HashMap<ThreadId, String>,
    /// Thread -> the newest mode it was in that is not the plan mode (`PermissionRequested.mode_before`).
    before_plan: HashMap<ThreadId, String>,
    /// Thread (None: Session level) -> (seq, newest non-blank title from `SessionInfoUpdated`).
    titles: HashMap<Option<ThreadId>, (u64, String)>,
    /// Attached Shared Artifact ids, in order of attaching (`ArtifactAttached` / `ArtifactDetached`).
    attached: Vec<String>,
    /// Review Comments in the order added, with their state (ADR 0027).
    comments: Vec<crate::api::CommentState>,
    /// `CommentAdded` events seen, deleted comments included.
    comments_added: usize,
    /// Thread -> whether its newest `TurnStarted` / `TurnEnded` is a start.
    open_turn: HashMap<ThreadId, bool>,
    /// Thread -> `seq` of its newest `TurnStarted`.
    turn_started: HashMap<ThreadId, u64>,
    /// Thread -> the options array of its newest `ConfigOptionsChanged` that has one.
    config: HashMap<ThreadId, Vec<Value>>,
    frontend: FrontendProj,
}

/// Frontend Tool items and errors: what `Session::frontend_items` and `frontend_errors` return.
#[derive(Default)]
struct FrontendProj {
    /// Calls that named an `id` and were not removed since, keyed by the order first seen.
    items: std::collections::BTreeMap<u64, Arc<FrontendItem>>,
    /// `(tool, id)` -> key in `items`: a call finds its item without a scan.
    pos: HashMap<(String, String), u64>,
    next_order: u64,
    /// `(tool, id)` -> key in `items` of a panel the user deleted: a later call brings it back to its place (as the Frontend's slots do).
    parked: HashMap<(String, String), u64>,
    /// `(tool, id)` -> the user's title and icon (`PanelEdited`). Kept when the item is deleted or the Agent calls again.
    overrides: HashMap<(String, String), (Option<String>, Option<String>)>,
    /// Every live item (its `id`, or the call id of a call without one) -> Thread of its latest call.
    keyed: HashMap<(String, String), ThreadId>,
    /// `FrontendError`s not cleared since, oldest first. May name items that never existed: read through `errors`.
    errors: Vec<FrontendErrorEntry>,
}

/// Whether a call's `source` names a Shared Artifact.
fn is_shared(input: &Value) -> bool {
    input.get("source").and_then(Value::as_str).and_then(crate::shared::reference).is_some()
}

/// Most uncleared `FrontendError`s the projection keeps; the oldest go first.
const MAX_PROJECTED_ERRORS: usize = 500;

impl FrontendProj {
    fn apply(&mut self, e: &Event) {
        match &e.kind {
            EventKind::FrontendToolOutput { tool, call_id, input, files, .. } => {
                let id = input.get("id").and_then(Value::as_str);
                let remove = input.get("remove") == Some(&Value::Bool(true));
                if let Some(id) = id {
                    let key = (tool.clone(), id.to_owned());
                    let at = self.pos.get(&key).copied();
                    // A Shared Artifact's title and icon are its own (its meta): an override is not shown.
                    let (title, icon) = if is_shared(input) { Default::default() } else { self.overrides.get(&key).cloned().unwrap_or_default() };
                    match (remove, at) {
                        (true, Some(i)) => {
                            self.items.remove(&i);
                            self.pos.remove(&key);
                        }
                        (true, None) => {
                            self.parked.remove(&key);
                        }
                        (false, at) => {
                            let item = Arc::new(FrontendItem {
                                tool: tool.clone(),
                                id: id.to_owned(),
                                input: input.clone(),
                                ts_ms: e.ts_ms,
                                thread: e.thread_id.clone(),
                                files: files.clone(),
                                title,
                                icon,
                            });
                            match at {
                                Some(i) => {
                                    self.items.insert(i, item);
                                }
                                None => {
                                    let order = self.parked.remove(&key).unwrap_or_else(|| {
                                        self.next_order += 1;
                                        self.next_order - 1
                                    });
                                    self.items.insert(order, item);
                                    self.pos.insert(key, order);
                                }
                            }
                        }
                    }
                }
                let Some(thread) = &e.thread_id else { return };
                match id {
                    Some(id) => {
                        self.errors.retain(|x| !(x.tool == *tool && x.item == id));
                        let key = (tool.clone(), id.to_owned());
                        if remove {
                            self.keyed.remove(&key);
                        } else {
                            self.keyed.insert(key, thread.clone());
                        }
                    }
                    None => {
                        self.keyed.insert((tool.clone(), call_id.clone()), thread.clone());
                    }
                }
            }
            EventKind::PanelEdited { tool, id, title, icon } => {
                let key = (tool.clone(), id.clone());
                if title.is_none() && icon.is_none() {
                    self.overrides.remove(&key);
                } else {
                    self.overrides.insert(key.clone(), (title.clone(), icon.clone()));
                }
                if let Some(item) = self.pos.get(&key).and_then(|i| self.items.get_mut(i)).filter(|item| !is_shared(&item.input)) {
                    let item = Arc::make_mut(item);
                    item.title = title.clone();
                    item.icon = icon.clone();
                }
            }
            EventKind::PanelDeleted { tool, id } => {
                let key = (tool.clone(), id.clone());
                if let Some(i) = self.pos.remove(&key) {
                    self.items.remove(&i);
                    self.parked.insert(key.clone(), i);
                }
                self.keyed.remove(&key);
                self.errors.retain(|x| !(x.tool == *tool && x.item == *id));
            }
            EventKind::FrontendError { tool, item, message } => {
                self.errors.push(FrontendErrorEntry {
                    seq: e.seq,
                    thread: e.thread_id.clone().unwrap_or_default(),
                    tool: tool.clone(),
                    item: item.clone(),
                    message: message.clone(),
                });
                if self.errors.len() > MAX_PROJECTED_ERRORS {
                    self.errors.drain(..self.errors.len() - MAX_PROJECTED_ERRORS);
                }
            }
            _ => {}
        }
    }

    fn errors(&self) -> Vec<FrontendErrorEntry> {
        self.errors.iter().filter(|x| self.keyed.contains_key(&(x.tool.clone(), x.item.clone()))).cloned().collect()
    }
}

impl Projections {
    fn set_mode(&mut self, e: &Event, mode: String) {
        let Some(t) = &e.thread_id else { return };
        if !crate::agent_quirks::is_plan_mode(&mode) {
            self.before_plan.insert(t.clone(), mode.clone());
        }
        self.modes.insert(t.clone(), mode);
    }

    fn apply(&mut self, e: &Event) {
        match &e.kind {
            EventKind::ModeChanged { mode_id, .. } if !mode_id.is_empty() => self.set_mode(e, mode_id.clone()),
            EventKind::ConfigOptionsChanged { options, .. } => {
                if let Some(mode) = config_mode(options) {
                    self.set_mode(e, mode);
                }
                if let (Some(t), Some(o)) = (&e.thread_id, options.as_array()) {
                    self.config.insert(t.clone(), o.clone());
                }
            }
            EventKind::ArtifactAttached { id, .. } if !self.attached.contains(id) => self.attached.push(id.clone()),
            EventKind::ArtifactDetached { id, .. } => self.attached.retain(|x| x != id),
            EventKind::CommentAdded { comment } => {
                use crate::api::{CommentState, CommentStatus};
                let status = if comment.by == crate::api::StateWriter::User { CommentStatus::Pending } else { CommentStatus::Open };
                self.comments_added += 1;
                self.comments.push(CommentState { comment: comment.clone(), status, resolved_by: None, note: None });
            }
            EventKind::CommentEdited { id, text } => {
                if let Some(c) = self.comments.iter_mut().find(|c| c.comment.id == *id) {
                    c.comment.text = text.clone();
                }
            }
            EventKind::CommentDeleted { id } => self.comments.retain(|c| c.comment.id != *id),
            EventKind::CommentsSent { ids } => {
                for c in self.comments.iter_mut().filter(|c| ids.contains(&c.comment.id) && c.status == crate::api::CommentStatus::Pending) {
                    c.status = crate::api::CommentStatus::Open;
                }
            }
            EventKind::CommentResolved { id, by, note } => {
                if let Some(c) = self.comments.iter_mut().find(|c| c.comment.id == *id) {
                    c.status = crate::api::CommentStatus::Resolved;
                    c.resolved_by = Some(*by);
                    c.note = note.clone();
                }
            }
            EventKind::TurnStarted { .. } | EventKind::TurnEnded { .. } => {
                if let Some(t) = &e.thread_id {
                    let started = matches!(e.kind, EventKind::TurnStarted { .. });
                    self.open_turn.insert(t.clone(), started);
                    if started {
                        self.turn_started.insert(t.clone(), e.seq);
                    }
                }
            }
            EventKind::FrontendToolOutput { .. } | EventKind::FrontendError { .. } | EventKind::PanelEdited { .. } | EventKind::PanelDeleted { .. } => {
                self.frontend.apply(e)
            }
            EventKind::SessionInfoUpdated { title: Some(t) } if !t.trim().is_empty() => {
                self.titles.insert(e.thread_id.clone(), (e.seq, t.clone()));
            }
            _ => {}
        }
    }
}

// ---------- reading the file ----------

/// How one complete line of the file reads.
enum Parsed {
    Event(Event),
    /// An Event envelope whose `kind` has a `type` this build does not know: reads as `Unknown`.
    /// A newer build wrote it, so it is not a bad line.
    UnknownKind(Event),
    /// An Event envelope whose `kind` is a known type with fields that do not parse: stands in as `Unknown`.
    Standin(Event),
    /// Not an Event at all (not JSON, no `seq`): left out of the in-memory view, kept in the file.
    Skipped,
}

fn parse_line(line: &[u8]) -> Parsed {
    // Fast path: the current schema parses as is.
    if let Ok(ev) = serde_json::from_slice::<Event>(line)
        && ev.v == EVENT_SCHEMA_VERSION
    {
        return Parsed::Event(ev);
    }
    let Ok(value) = serde_json::from_slice::<Value>(line) else { return Parsed::Skipped };
    let v = value.get("v").and_then(Value::as_u64).unwrap_or(1).min(u16::MAX as u64) as u16;
    let value = upcast(v, value);
    if let Ok(ev) = serde_json::from_value::<Event>(value.clone()) {
        return Parsed::Event(ev);
    }
    let unknown_type =
        value.get("kind").is_some_and(|k| serde_json::from_value::<EventKind>(k.clone()).is_err_and(|e| e.to_string().contains("unknown variant")));
    let standin = (|| {
        let o = value.as_object()?;
        Some(Event {
            v,
            seq: o.get("seq")?.as_u64()?,
            session_id: o.get("session_id")?.as_str()?.to_owned(),
            thread_id: o.get("thread_id").and_then(Value::as_str).map(str::to_owned),
            ts_ms: o.get("ts_ms").and_then(Value::as_i64).unwrap_or(0),
            kind: EventKind::Unknown,
        })
    })();
    match standin {
        Some(ev) if unknown_type => Parsed::UnknownKind(ev),
        Some(ev) => Parsed::Standin(ev),
        None => Parsed::Skipped,
    }
}

#[derive(Default)]
struct Scan {
    /// Offset after the last complete line: where the file is valid up to.
    valid_len: u64,
    /// The file ends in a line without a newline.
    torn: bool,
    /// Complete lines that did not parse as a current-shape Event.
    bad_lines: usize,
    /// End offset of the first of them.
    first_bad_end: Option<u64>,
    /// Newest `v` that is newer than this build knows.
    future_v: Option<u16>,
}

/// Reads the complete lines of `path` from `offset`, calling `f` for each Event. One reader for
/// open and for the lazy load, so they cannot disagree.
fn scan_lines(path: &Path, offset: u64, mut f: impl FnMut(Event)) -> anyhow::Result<Scan> {
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(offset))?;
    let mut reader = BufReader::new(file);
    let mut scan = Scan { valid_len: offset, ..Scan::default() };
    let mut line = Vec::new();
    loop {
        line.clear();
        let n = reader.read_until(b'\n', &mut line)?;
        if n == 0 {
            break;
        }
        if line.last() != Some(&b'\n') {
            scan.torn = true;
            break;
        }
        scan.valid_len += n as u64;
        if line.trim_ascii().is_empty() {
            continue;
        }
        match parse_line(&line) {
            Parsed::Event(ev) => {
                if ev.v > EVENT_SCHEMA_VERSION {
                    scan.future_v = Some(scan.future_v.map_or(ev.v, |v| v.max(ev.v)));
                }
                f(ev);
            }
            Parsed::UnknownKind(ev) => {
                if ev.v > EVENT_SCHEMA_VERSION {
                    scan.future_v = Some(scan.future_v.map_or(ev.v, |v| v.max(ev.v)));
                }
                f(ev);
            }
            Parsed::Standin(ev) => {
                if ev.v > EVENT_SCHEMA_VERSION {
                    scan.future_v = Some(scan.future_v.map_or(ev.v, |v| v.max(ev.v)));
                }
                scan.bad_lines += 1;
                scan.first_bad_end.get_or_insert(scan.valid_len);
                f(ev);
            }
            Parsed::Skipped => {
                scan.bad_lines += 1;
                scan.first_bad_end.get_or_insert(scan.valid_len);
            }
        }
    }
    Ok(scan)
}

/// Copies the log to `<path>.corrupt-<ts_ms>` unless an earlier copy already holds everything up
/// to `upto`, so a line that stays bad does not make a copy on every open.
fn backup_before_keeping_bad_lines(path: &Path, upto: u64) -> anyhow::Result<()> {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let prefix = format!("{name}.corrupt-");
    if let Some(dir) = path.parent() {
        for entry in std::fs::read_dir(dir)?.flatten() {
            if entry.file_name().to_string_lossy().starts_with(&prefix) && entry.metadata().is_ok_and(|m| m.len() >= upto) {
                return Ok(());
            }
        }
    }
    let backup = path.with_file_name(format!("{prefix}{}", now_ms()));
    std::fs::copy(path, &backup)?;
    tracing::warn!("{} has lines that do not parse; kept them, copy at {}", path.display(), backup.display());
    Ok(())
}

// ---------- checkpoint ----------

/// What open needs to skip parsing the log (`log.checkpoint.json` next to the log, written by `sync`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Checkpoint {
    next_seq: u64,
    last_ts_ms: i64,
    agent_was_running: bool,
    byte_len: u64,
    /// `seq` of the newest Event in the file. `next_seq` never goes back, so a dropped tail's
    /// `seq`s are not handed out again; this is what `last_seq` names after a restart.
    #[serde(default)]
    last_seq: Option<u64>,
}

fn checkpoint_path(log: &Path) -> PathBuf {
    log.with_extension("checkpoint.json")
}

/// The checkpoint, when it can be trusted: the file is at least as long and `byte_len` is at the
/// end of a line.
fn read_checkpoint(log: &Path, file_len: u64) -> Option<Checkpoint> {
    let cp: Checkpoint = serde_json::from_slice(&std::fs::read(checkpoint_path(log)).ok()?).ok()?;
    if cp.byte_len > file_len {
        return None;
    }
    if cp.byte_len > 0 {
        let mut f = File::open(log).ok()?;
        f.seek(SeekFrom::Start(cp.byte_len - 1)).ok()?;
        let mut b = [0u8; 1];
        f.read_exact(&mut b).ok()?;
        if b[0] != b'\n' {
            return None;
        }
    }
    Some(cp)
}

// ---------- writer thread ----------

/// A change in whether the log's file can be written, reported to the hook set with
/// `SessionLog::set_health_hook`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LogHealth {
    /// The first failed write (or refused append) since the last good one.
    Degraded(String),
    /// A write worked again. `dropped` Events failed in between: they reached subscribers and
    /// memory but not the file, so a reload misses them. The file stays well formed, `seq` ascending (with a gap).
    Recovered { dropped: u32 },
}

type HealthHook = Arc<dyn Fn(&LogHealth) + Send + Sync>;

#[derive(Default)]
struct HealthState {
    error: Option<String>,
    /// Events with a `seq` that failed to write since the last good write.
    dropped: u32,
    /// `close` ran: nothing is reported any more.
    closed: bool,
    hook: Option<HealthHook>,
    notify: Option<Sender<LogHealth>>,
    /// Set by `close`: the hook thread drops what it has not delivered yet.
    stop: Arc<AtomicBool>,
    /// Disconnects when the hook thread ends.
    hook_done: Option<Receiver<()>>,
    /// Tests: every write and probe fails.
    #[cfg(test)]
    inject: bool,
}

/// Whether the file can be written. One lock covers the state and the queueing of its change, so
/// the flag and what was reported cannot disagree. Changes reach the hook on a thread of its own,
/// in order, so a hook that blocks never stalls the writer or an append.
#[derive(Default)]
struct Health(Mutex<HealthState>);

impl Health {
    fn error(&self) -> Option<String> {
        self.0.lock().error.clone()
    }

    /// An Event could not be written (`lost`: it had a `seq`), or a try without one (a probe, a
    /// sync, a refused append) did not work.
    fn fail(&self, message: String, lost: bool) {
        let mut h = self.0.lock();
        if h.closed {
            return;
        }
        if lost {
            h.dropped = h.dropped.saturating_add(1);
        }
        let first = h.error.is_none();
        h.error = Some(message.clone());
        if first {
            tracing::warn!("Session Log not written: {message}");
            h.send(LogHealth::Degraded(message));
        }
    }

    /// A write worked.
    fn ok(&self) {
        let mut h = self.0.lock();
        if h.closed || h.error.take().is_none() {
            return;
        }
        let dropped = std::mem::take(&mut h.dropped);
        tracing::info!("Session Log writes work again; {dropped} Events were not written");
        h.send(LogHealth::Recovered { dropped });
    }

    /// Stops reporting: a change not delivered yet is dropped, and one being delivered gets a
    /// short bound to finish (a hook that blocks must not stall the close).
    fn close(&self) {
        let done = {
            let mut h = self.0.lock();
            h.closed = true;
            h.stop.store(true, Ordering::SeqCst);
            h.notify = None;
            h.hook_done.take()
        };
        if let Some(done) = done {
            let _ = done.recv_timeout(Duration::from_millis(200));
        }
    }

    /// Sets the hook, and tells it right away when the log is already degraded.
    fn set_hook(&self, hook: HealthHook) {
        let mut h = self.0.lock();
        h.hook = Some(hook);
        if let Some(e) = h.error.clone() {
            h.send(LogHealth::Degraded(e));
        }
    }

    #[cfg(test)]
    fn inject(&self, on: bool) {
        self.0.lock().inject = on;
    }

    fn injected(&self) -> bool {
        #[cfg(test)]
        return self.0.lock().inject;
        #[cfg(not(test))]
        false
    }
}

impl HealthState {
    fn send(&mut self, change: LogHealth) {
        let Some(hook) = self.hook.clone() else { return };
        if self.notify.is_none() {
            let (t, rx) = mpsc::channel::<LogHealth>();
            let (done_tx, done_rx) = mpsc::channel::<()>();
            let stop = self.stop.clone();
            let spawned = std::thread::Builder::new().name("session-log-health".into()).spawn(move || {
                let _done = done_tx;
                for change in rx {
                    if stop.load(Ordering::SeqCst) {
                        break;
                    }
                    hook(&change);
                }
            });
            if spawned.is_err() {
                return;
            }
            self.notify = Some(t);
            self.hook_done = Some(done_rx);
        }
        if let Some(t) = &self.notify {
            let _ = t.send(change);
        }
    }
}

enum Job {
    Write(Arc<Event>),
    /// Answers with the bytes written so far and the `seq` of the newest Event on disk, after `fsync` when asked.
    Sync {
        fsync: bool,
        reply: Sender<Result<Written, String>>,
    },
}

#[derive(Clone, Copy)]
struct Written {
    len: u64,
    /// `seq` of the newest Event this writer wrote (or the log had when it started).
    last_seq: Option<u64>,
}

/// The only owner of the log's file handle. Lines are written in the order they were queued.
struct Writer {
    tx: Sender<Job>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl Writer {
    fn spawn(path: PathBuf, start_len: u64, start_seq: Option<u64>, health: Arc<Health>) -> anyhow::Result<Self> {
        let (tx, rx) = mpsc::channel::<Job>();
        let handle = std::thread::Builder::new().name("session-log-writer".into()).spawn(move || write_loop(&path, start_len, start_seq, &rx, &health))?;
        Ok(Self { tx, handle: Some(handle) })
    }

    /// Queues the Event. A failed write does not fail this: it marks the log degraded.
    fn write(&self, ev: Arc<Event>) -> anyhow::Result<()> {
        self.tx.send(Job::Write(ev)).map_err(|_| anyhow::anyhow!("the Session Log writer stopped"))
    }

    /// Waits until everything queued so far is written (and synced when `fsync`).
    fn barrier(&self, fsync: bool) -> anyhow::Result<Written> {
        let (reply, rx) = mpsc::channel();
        self.tx.send(Job::Sync { fsync, reply }).map_err(|_| anyhow::anyhow!("the Session Log writer stopped"))?;
        rx.recv().map_err(|_| anyhow::anyhow!("the Session Log writer stopped"))?.map_err(|e| anyhow::anyhow!("writing the Session Log failed: {e}"))
    }
}

/// Which file a handle is on: (device, inode). Where there is no such thing, only its length can tell.
fn identity(m: &std::fs::Metadata) -> Option<(u64, u64)> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Some((m.dev(), m.ino()))
    }
    #[cfg(not(unix))]
    {
        let _ = m;
        None
    }
}

/// The file and how much of it is known good. The writer never cuts the file.
struct FileState {
    file: Option<File>,
    /// Bytes of whole lines written.
    len: u64,
    /// A write failed: the file may end in a partial line, be a different file, or be gone.
    recheck: bool,
    /// The file the first handle was opened on.
    ident: Option<(u64, u64)>,
}

impl FileState {
    fn new(len: u64) -> Self {
        Self { file: None, len, recheck: false, ident: None }
    }

    /// Appends `line` (nothing, to probe), opening the file when needed. After a failure the
    /// reopened file is checked first: if it does not end in a newline (a write died half way) one
    /// is added, so the partial line becomes a bad line `open` keeps and backs up instead of
    /// running into the next Event. A file that is shorter than expected, or another file than
    /// before, is appended to at its end and the checkpoint (which describes the old one) removed.
    fn append(&mut self, path: &Path, line: &[u8]) -> anyhow::Result<()> {
        if self.file.is_none() {
            // Append mode: every write lands at the current end.
            let mut f = OpenOptions::new().create(true).append(true).open(path)?;
            let meta = f.metadata()?;
            if self.recheck {
                let other = self.ident.is_some() && identity(&meta) != self.ident;
                if other || meta.len() < self.len {
                    let _ = std::fs::remove_file(checkpoint_path(path));
                    self.ident = identity(&meta);
                }
                self.len = meta.len();
                if meta.len() > 0 && last_byte(path, meta.len())? != b'\n' {
                    f.write_all(b"\n")?;
                    self.len += 1;
                }
                self.recheck = false;
            } else if self.ident.is_none() {
                self.ident = identity(&meta);
            }
            self.file = Some(f);
        }
        let result = self.file.as_mut().map_or(Ok(()), |f| f.write_all(line));
        match result {
            Ok(()) => {
                self.len += line.len() as u64;
                Ok(())
            }
            Err(e) => {
                self.broke();
                Err(e.into())
            }
        }
    }

    fn broke(&mut self) {
        self.file = None;
        self.recheck = true;
    }
}

fn last_byte(path: &Path, len: u64) -> std::io::Result<u8> {
    let mut f = File::open(path)?;
    f.seek(SeekFrom::Start(len - 1))?;
    let mut b = [0u8; 1];
    f.read_exact(&mut b)?;
    Ok(b[0])
}

fn write_loop(path: &Path, start_len: u64, start_seq: Option<u64>, rx: &Receiver<Job>, health: &Health) {
    let mut st = FileState::new(start_len);
    let mut last_seq = start_seq;
    for job in rx {
        match job {
            Job::Write(ev) => {
                // Every Event is a fresh try: a failed one is dropped (counted), the next one reopens the file.
                let result = if health.injected() {
                    Err(anyhow::anyhow!("injected write failure"))
                } else {
                    serde_json::to_vec(&*ev).map_err(anyhow::Error::from).and_then(|mut line| {
                        line.push(b'\n');
                        st.append(path, &line)
                    })
                };
                match result {
                    Ok(()) => {
                        last_seq = Some(ev.seq);
                        health.ok();
                    }
                    Err(e) => health.fail(format!("{e:#}"), true),
                }
            }
            Job::Sync { fsync, reply } => {
                if health.error().is_some() {
                    let probe = if health.injected() { Err(anyhow::anyhow!("injected write failure")) } else { st.append(path, &[]) };
                    match probe {
                        Ok(()) => health.ok(),
                        Err(e) => health.fail(format!("{e:#}"), false),
                    }
                }
                let answer = match health.error() {
                    Some(e) if fsync => Err(e),
                    _ if fsync => match st.file.as_ref().map(File::sync_data) {
                        Some(Err(e)) => {
                            st.broke();
                            health.fail(e.to_string(), false);
                            Err(e.to_string())
                        }
                        _ => Ok(Written { len: st.len, last_seq }),
                    },
                    _ => Ok(Written { len: st.len, last_seq }),
                };
                let _ = reply.send(answer);
            }
        }
    }
}

// ---------- fan-out ----------

struct SubState {
    /// The sink said it is gone, or the View unsubscribed.
    dead: AtomicBool,
    /// Set before the queue is closed on overflow: `Some(last_seq)`.
    lagged: Mutex<Option<Option<u64>>>,
}

struct Sub {
    id: SubscriptionId,
    tx: SyncSender<Arc<Event>>,
    state: Arc<SubState>,
    /// `seq` of the newest Event handed to the queue (or replay).
    last_seq: Option<u64>,
}

impl Sub {
    /// Queues `ev`; false when the subscriber should be removed.
    fn offer(&mut self, ev: &Arc<Event>) -> bool {
        if self.state.dead.load(Ordering::Relaxed) {
            return false;
        }
        // Subscribed from a `seq` past the head: the Events before it are not this View's.
        if self.last_seq.is_some_and(|last| ev.seq <= last) {
            return true;
        }
        match self.tx.try_send(ev.clone()) {
            Ok(()) => {
                self.last_seq = Some(ev.seq);
                true
            }
            Err(TrySendError::Full(_)) => {
                *self.state.lagged.lock() = Some(self.last_seq);
                false
            }
            Err(TrySendError::Disconnected(_)) => false,
        }
    }
}

fn drain(sink: Box<dyn EventSink>, replay: Vec<Arc<Event>>, rx: Receiver<Arc<Event>>, state: Arc<SubState>) {
    for ev in replay {
        if state.dead.load(Ordering::Relaxed) || !sink.send(&ev) {
            state.dead.store(true, Ordering::Relaxed);
            return;
        }
    }
    for ev in rx.iter() {
        if state.dead.load(Ordering::Relaxed) || !sink.send(&ev) {
            state.dead.store(true, Ordering::Relaxed);
            return;
        }
    }
    // The queue closed: the log was dropped, the View unsubscribed, or it overflowed.
    if let Some(last) = state.lagged.lock().take()
        && !state.dead.load(Ordering::Relaxed)
    {
        sink.lagged(last);
    }
}

// ---------- the log ----------

pub struct SessionLog {
    session_id: SessionId,
    path: PathBuf,
    inner: Arc<Mutex<Inner>>,
    health: Arc<Health>,
    /// `ts_ms` of the last Event (0 when empty); kept in memory, read for `SessionSummary.updated_ms`.
    last_ts_ms: AtomicI64,
    /// When opened, the log's last process state said an Agent was running.
    agent_was_running: bool,
    /// Why appends are refused (the file holds Events from a newer build).
    read_only: Option<String>,
    /// `byte_len` of the checkpoint on disk; held while writing one.
    checkpointed_len: Mutex<Option<(u64, u64)>>,
    /// `close` ran: no more checkpoints (the directory may be on its way out).
    closed: AtomicBool,
    /// Tests: runs right before a checkpoint is written.
    #[cfg(test)]
    before_checkpoint: Mutex<Option<Box<dyn Fn() + Send>>>,
}

struct Inner {
    session_id: SessionId,
    path: PathBuf,
    /// File length when opened, then kept by the writer.
    start_len: u64,
    writer: Option<Writer>,
    health: Arc<Health>,
    next_seq: u64,
    /// `seq` of the newest Event the log has: after open the newest in the file, then the newest appended (None: empty).
    last_present: Option<u64>,
    /// The newest `AgentProcessState` said an Agent runs.
    running: bool,
    /// All Events, once loaded (`None` until the first need).
    events: Option<Vec<Arc<Event>>>,
    proj: Projections,
    next_sub: SubscriptionId,
    subscribers: Vec<Sub>,
    /// A chunk not yet written; its `seq` is `next_seq`.
    pending: Option<Event>,
    /// `close` ran: the file may be gone, so nothing is written any more.
    closed: bool,
    /// Dangling Turns and permission requests from before this open were closed (or are left alone).
    repaired: bool,
    /// `next_seq` at open: Events below it are from an earlier run.
    opened_next_seq: u64,
}

impl Inner {
    fn writer(&mut self) -> anyhow::Result<&Writer> {
        anyhow::ensure!(!self.closed, "the Session Log is closed");
        if self.writer.is_none() {
            self.writer = Some(Writer::spawn(self.path.clone(), self.start_len, self.last_present, self.health.clone())?);
        }
        self.writer.as_ref().ok_or_else(|| anyhow::anyhow!("no writer"))
    }

    /// Hands the Event to memory, the writer and the subscribers. Never waits for a sink or the disk.
    fn write(&mut self, event: Event) -> anyhow::Result<()> {
        let ev = Arc::new(event);
        self.writer()?.write(ev.clone())?;
        self.next_seq = ev.seq + 1;
        self.last_present = Some(ev.seq);
        if let EventKind::AgentProcessState { state, .. } = &ev.kind {
            self.running = matches!(state, ProcessState::Starting | ProcessState::Ready);
        }
        if let Some(events) = self.events.as_mut() {
            events.push(ev.clone());
            self.proj.apply(&ev);
        }
        self.subscribers.retain_mut(|s| s.offer(&ev));
        Ok(())
    }

    fn flush(&mut self) -> anyhow::Result<()> {
        match self.pending.take() {
            Some(e) => self.write(e),
            None => Ok(()),
        }
    }

    /// Loads all Events from the file. The writer is drained first, so the file holds everything
    /// appended so far.
    fn ensure_loaded(&mut self) -> anyhow::Result<()> {
        if self.events.is_some() {
            return Ok(());
        }
        self.flush()?;
        if let Some(w) = &self.writer {
            w.barrier(false)?;
        }
        let mut events = Vec::new();
        let mut proj = Projections::default();
        if self.path.exists() {
            scan_lines(&self.path, 0, |ev| {
                proj.apply(&ev);
                events.push(Arc::new(ev));
            })?;
        }
        self.events = Some(events);
        self.proj = proj;
        self.close_dangling()
    }

    /// A Turn or a permission request left open by an earlier run (killed mid-Turn, or its closing
    /// Events were dropped by a failing disk) would read as running or waiting forever. Once per
    /// open, right after the load and before any new append: a `TurnEnded` ("cancelled", the
    /// vocabulary of a Cancel) for each Thread with an open Turn, and a cancelled
    /// `PermissionResolved` for each unanswered request, in that order of causes. Events of this
    /// run are not touched. Not done for a read-only log. Idempotent: the next open finds nothing.
    fn close_dangling(&mut self) -> anyhow::Result<()> {
        if std::mem::replace(&mut self.repaired, true) {
            return Ok(());
        }
        let Some(events) = self.events.as_ref() else { return Ok(()) };
        let mut turns: Vec<(ThreadId, String)> = Vec::new();
        let mut asks: Vec<(String, Option<ThreadId>)> = Vec::new();
        for e in events.iter().take_while(|e| e.seq < self.opened_next_seq) {
            match (&e.kind, &e.thread_id) {
                (EventKind::TurnStarted { turn_id, .. }, Some(t)) => match turns.iter_mut().find(|(x, _)| x == t) {
                    Some(slot) => slot.1 = turn_id.clone(),
                    None => turns.push((t.clone(), turn_id.clone())),
                },
                (EventKind::TurnEnded { .. }, Some(t)) => turns.retain(|(x, _)| x != t),
                (EventKind::PermissionRequested { request_id, .. }, _) => asks.push((request_id.clone(), e.thread_id.clone())),
                (EventKind::PermissionResolved { request_id, .. }, _) => asks.retain(|(r, _)| r != request_id),
                _ => {}
            }
        }
        // Keeps the Session where it was in the list.
        let ts_ms = events.last().map_or(0, |e| e.ts_ms);
        let mut close = Vec::new();
        for (request_id, thread_id) in asks {
            close.push((thread_id, EventKind::PermissionResolved { request_id, option_id: None, by: crate::api::Resolver::Cancelled, rule_id: None }));
        }
        for (thread, turn_id) in turns {
            close.push((Some(thread), EventKind::TurnEnded { turn_id, stop_reason: "cancelled".to_owned() }));
        }
        for (thread_id, kind) in close {
            let event = Event { v: EVENT_SCHEMA_VERSION, seq: self.next_seq, session_id: self.session_id.clone(), thread_id, ts_ms, kind };
            self.write(event)?;
        }
        Ok(())
    }
}

/// Appends `text` to `pending` when both are chunks of the same kind, Thread and parent tool call.
fn merge_chunk(pending: &mut Event, thread_id: &Option<ThreadId>, kind: &EventKind) -> bool {
    if pending.thread_id != *thread_id {
        return false;
    }
    match (&mut pending.kind, kind) {
        (EventKind::AgentMessageChunk { text: a, parent_tool_call_id: pa }, EventKind::AgentMessageChunk { text: b, parent_tool_call_id: pb })
        | (EventKind::AgentThoughtChunk { text: a, parent_tool_call_id: pa }, EventKind::AgentThoughtChunk { text: b, parent_tool_call_id: pb })
            if pa == pb =>
        {
            a.push_str(b);
            true
        }
        _ => false,
    }
}

impl SessionLog {
    /// Opens (or creates) the log at `path`. Cuts a torn final line; never anything else.
    pub fn open(session_id: SessionId, path: &Path) -> anyhow::Result<Self> {
        if !path.exists() {
            File::create(path)?;
        }
        let file_len = std::fs::metadata(path)?.len();
        let checkpoint = read_checkpoint(path, file_len);
        let mut next_seq = 0;
        let mut last_present = None;
        let mut last_ts_ms = 0;
        let mut running = false;
        let mut offset = 0;
        if let Some(cp) = &checkpoint {
            next_seq = cp.next_seq;
            last_present = cp.last_seq.or(cp.next_seq.checked_sub(1));
            last_ts_ms = cp.last_ts_ms;
            running = cp.agent_was_running;
            offset = cp.byte_len;
        }
        let scan = scan_lines(path, offset, |ev| {
            next_seq = ev.seq + 1;
            last_present = Some(ev.seq);
            last_ts_ms = ev.ts_ms;
            if let EventKind::AgentProcessState { state, .. } = &ev.kind {
                running = matches!(state, ProcessState::Starting | ProcessState::Ready);
            }
        })?;
        if let Some(end) = scan.first_bad_end
            && let Err(e) = backup_before_keeping_bad_lines(path, end)
        {
            tracing::warn!("could not copy {} before keeping its bad lines: {e:#}", path.display());
        }
        let read_only = scan.future_v.map(|v| {
            format!("the Session Log has Events from a newer version of the Harness (schema v{v}, this build reads up to v{EVENT_SCHEMA_VERSION}); update the Harness to continue this Session")
        });
        if scan.torn && read_only.is_none() {
            OpenOptions::new().write(true).open(path)?.set_len(scan.valid_len)?;
        }
        let start_len = if read_only.is_some() { file_len } else { scan.valid_len };
        let health = Arc::new(Health::default());
        Ok(Self {
            session_id: session_id.clone(),
            path: path.to_owned(),
            health: health.clone(),
            inner: Arc::new(Mutex::new(Inner {
                session_id: session_id.clone(),
                path: path.to_owned(),
                start_len,
                writer: None,
                health,
                next_seq,
                last_present,
                running,
                events: None,
                proj: Projections::default(),
                next_sub: 1,
                subscribers: Vec::new(),
                pending: None,
                closed: false,
                repaired: read_only.is_some(),
                opened_next_seq: next_seq,
            })),
            checkpointed_len: Mutex::new(checkpoint.map(|c| (c.byte_len, c.next_seq))),
            closed: AtomicBool::new(false),
            #[cfg(test)]
            before_checkpoint: Mutex::new(None),
            last_ts_ms: AtomicI64::new(last_ts_ms),
            agent_was_running: running,
            read_only,
        })
    }

    /// An error (`Conflict`) with the reason when the log refuses appends.
    pub fn writable(&self) -> anyhow::Result<()> {
        match &self.read_only {
            Some(reason) => Err(crate::error::conflict(reason.clone())),
            None => Ok(()),
        }
    }

    /// Why the log refuses appends, if it does.
    pub fn read_only_reason(&self) -> Option<&str> {
        self.read_only.as_deref()
    }

    /// Logs that the Agent process of an earlier run of the Harness is gone: quitting logs nothing.
    /// It keeps the last Event's time, so it does not move the Session up in the list.
    pub fn note_agent_gone(&self) -> anyhow::Result<()> {
        // A read-only log is not touched: it stays as the newer Harness left it.
        if !self.agent_was_running || self.read_only.is_some() {
            return Ok(());
        }
        let mut inner = self.inner.lock();
        // Loads first: an earlier run's dangling Turns are closed before anything new is appended.
        inner.ensure_loaded()?;
        let event = Event {
            v: EVENT_SCHEMA_VERSION,
            seq: inner.next_seq,
            session_id: self.session_id.clone(),
            thread_id: None,
            ts_ms: self.last_ts_ms.load(Ordering::Relaxed),
            kind: EventKind::AgentProcessState { state: ProcessState::Stopped, message: Some("app_restart".to_owned()) },
        };
        inner.write(event)
    }

    /// Leaves an earlier run's dangling Turns and permission requests as they are (an archived Session is not written to).
    pub fn skip_repair(&self) {
        self.inner.lock().repaired = true;
    }

    /// Why Events are not reaching the file right now (None: they are). Set on the first failed
    /// write; every later append tries again, and a good write clears it.
    pub fn degraded(&self) -> Option<String> {
        self.health.error()
    }

    /// Called, on a thread of its own and in order, when `degraded` turns on or off.
    pub fn set_health_hook(&self, hook: impl Fn(&LogHealth) + Send + Sync + 'static) {
        self.health.set_hook(Arc::new(hook));
    }

    /// `append` for sites with nobody to hand an error to (an Agent update, a status change): a
    /// refused append marks the log degraded like a failed write does, so the user hears of it.
    /// Writes that fail later, on the writer thread, are reported the same way.
    pub fn append_or_report(&self, thread_id: Option<ThreadId>, kind: EventKind) -> Option<Event> {
        match self.append(thread_id, kind) {
            Ok(e) => Some(e),
            Err(e) => {
                // A log that was closed on purpose (Session deleted) is not a failure.
                if !self.closed.load(Ordering::SeqCst) {
                    self.health.fail(format!("{e:#}"), false);
                }
                None
            }
        }
    }

    pub fn append(&self, thread_id: Option<ThreadId>, kind: EventKind) -> anyhow::Result<Event> {
        self.writable()?;
        let mut inner = self.inner.lock();
        // Loads first, so an earlier run's dangling Turns are closed before this Event gets its
        // `seq`, and every Event reaches memory and the projections.
        inner.ensure_loaded()?;
        self.last_ts_ms.store(now_ms(), Ordering::Relaxed);
        if let Some(p) = inner.pending.as_mut()
            && merge_chunk(p, &thread_id, &kind)
        {
            return Ok(p.clone());
        }
        inner.flush()?;
        let event = Event { v: EVENT_SCHEMA_VERSION, seq: inner.next_seq, session_id: self.session_id.clone(), thread_id, ts_ms: now_ms(), kind };
        let chunk = matches!(event.kind, EventKind::AgentMessageChunk { .. } | EventKind::AgentThoughtChunk { .. });
        match tokio::runtime::Handle::try_current() {
            Ok(rt) if chunk => {
                inner.pending = Some(event.clone());
                let weak: Weak<Mutex<Inner>> = Arc::downgrade(&self.inner);
                let seq = event.seq;
                rt.spawn(async move {
                    tokio::time::sleep(COALESCE).await;
                    if let Some(inner) = weak.upgrade() {
                        let mut inner = inner.lock();
                        if inner.pending.as_ref().is_some_and(|p| p.seq == seq) {
                            let _ = inner.flush();
                        }
                    }
                });
            }
            _ => inner.write(event.clone())?,
        }
        Ok(event)
    }

    /// `sync` for sites that must not fail because the disk does (answering a permission, an
    /// archive): a failure is reported like a failed write, and the caller carries on.
    pub fn sync_or_report(&self) {
        if let Err(e) = self.sync()
            && !self.closed.load(Ordering::SeqCst)
        {
            self.health.fail(format!("{e:#}"), false);
        }
    }

    /// Tests: `f` runs inside every `sync`, after the file is synced and before the checkpoint is written.
    #[cfg(test)]
    pub(crate) fn set_sync_hook(&self, f: impl Fn() + Send + 'static) {
        *self.before_checkpoint.lock() = Some(Box::new(f));
    }

    /// Tests: every write and probe fails until switched off.
    #[cfg(test)]
    pub(crate) fn inject_write_failure(&self, on: bool) {
        self.health.inject(on);
    }

    /// Flushes to disk and writes the checkpoint; called at Turn end and on permission events.
    pub fn sync(&self) -> anyhow::Result<()> {
        let (writer_tx_reply, cp) = {
            let mut inner = self.inner.lock();
            inner.flush()?;
            let cp = Checkpoint {
                next_seq: inner.next_seq,
                last_ts_ms: self.last_ts_ms.load(Ordering::Relaxed),
                agent_was_running: inner.running,
                byte_len: 0,
                last_seq: None,
            };
            // Queued under the lock: the answer covers exactly the Events counted in `cp`.
            let (reply, rx) = mpsc::channel();
            let w = inner.writer()?;
            w.tx.send(Job::Sync { fsync: true, reply }).map_err(|_| anyhow::anyhow!("the Session Log writer stopped"))?;
            (rx, cp)
        };
        let Written { len: byte_len, last_seq } = writer_tx_reply
            .recv()
            .map_err(|_| anyhow::anyhow!("the Session Log writer stopped"))?
            .map_err(|e| anyhow::anyhow!("writing the Session Log failed: {e}"))?;
        // One writer at a time, and never an older checkpoint over a newer one. Written outside the
        // log lock, so `close` waits on this lock for a write in flight, and none starts after it.
        let mut written = self.checkpointed_len.lock();
        if self.closed.load(Ordering::SeqCst) {
            return Ok(());
        }
        #[cfg(test)]
        if let Some(hook) = self.before_checkpoint.lock().as_ref() {
            hook();
        }
        // Newer than what is stored: more bytes, or a higher `next_seq` (a dropped tail adds no bytes).
        if written.is_none_or(|(len, next)| len < byte_len || next < cp.next_seq) {
            crate::fsutil::write_atomic(&checkpoint_path(&self.path), &serde_json::to_vec(&Checkpoint { byte_len, last_seq, ..cp })?)?;
            *written = Some((byte_len, cp.next_seq));
        }
        Ok(())
    }

    /// Replays events with `seq >= from_seq`, then delivers live events until unsubscribed.
    /// Returns at once: the sink is called from a thread of its own, so a slow sink never delays
    /// appends. If it falls `QUEUE_CAP` Events behind it is dropped after `EventSink::lagged`.
    pub fn subscribe(&self, from_seq: u64, sink: Box<dyn EventSink>) -> anyhow::Result<SubscriptionId> {
        let (tx, rx) = mpsc::sync_channel(QUEUE_CAP);
        let state = Arc::new(SubState { dead: AtomicBool::new(false), lagged: Mutex::new(None) });
        let (id, replay) = {
            let mut inner = self.inner.lock();
            inner.flush()?;
            inner.ensure_loaded()?;
            let events = inner.events.as_deref().unwrap_or_default();
            // Events are in `seq` order: everything from `from_seq` up to the head, which is the
            // boundary. Anything appended after this lock is released goes to the queue.
            let start = events.partition_point(|e| e.seq < from_seq);
            let replay: Vec<Arc<Event>> = events[start..].to_vec();
            let id = inner.next_sub;
            inner.next_sub += 1;
            let last_seq = replay.last().map(|e| e.seq).or(from_seq.checked_sub(1));
            inner.subscribers.push(Sub { id, tx, state: state.clone(), last_seq });
            (id, replay)
        };
        let spawned = std::thread::Builder::new().name("session-log-subscriber".into()).spawn(move || drain(sink, replay, rx, state));
        if let Err(e) = spawned {
            self.unsubscribe(id);
            return Err(e.into());
        }
        Ok(id)
    }

    /// One page of the log for a View that opens it (ADR 0029): the Events with
    /// `from_seq <= seq < end`, oldest first, at most `max_events` and `max_bytes` serialized, but
    /// at least one. `end` is `to_seq`, else the `seq` the next Event gets: a View reads up to the
    /// `end` of its first page and subscribes from it, so pages and live never overlap or leave a
    /// gap. A held chunk is flushed first: it gets its `seq` below `end`, or it is not there yet.
    /// The Events are shared handles under the lock and serialized after it, once each.
    pub fn read_page(&self, from_seq: u64, to_seq: Option<u64>, max_events: usize, max_bytes: usize) -> anyhow::Result<LogPage> {
        let (picked, end, left) = {
            let mut inner = self.inner.lock();
            inner.flush()?;
            inner.ensure_loaded()?;
            let end = to_seq.unwrap_or(inner.next_seq);
            let events = inner.events.as_deref().unwrap_or_default();
            let start = events.partition_point(|e| e.seq < from_seq);
            let stop = events.partition_point(|e| e.seq < end).max(start);
            let take = (stop - start).min(max_events.max(1));
            (events[start..start + take].to_vec(), end, stop - start)
        };
        let mut events = Vec::with_capacity(picked.len());
        let mut bytes = 0;
        for ev in &picked {
            let raw = serde_json::value::to_raw_value(&**ev)?;
            bytes += raw.get().len();
            if !events.is_empty() && bytes > max_bytes {
                break;
            }
            events.push(raw);
        }
        Ok(LogPage { more: events.len() < left, events, end })
    }

    pub fn unsubscribe(&self, id: SubscriptionId) {
        let mut inner = self.inner.lock();
        for s in inner.subscribers.iter().filter(|s| s.id == id) {
            s.state.dead.store(true, Ordering::Relaxed);
        }
        inner.subscribers.retain(|s| s.id != id);
    }

    /// `seq` of the newest Event the log has, 0 for an empty log: after a restart the newest in the
    /// file, never a `seq` that was dropped on the way. Flushes a held chunk, so subscribers have
    /// been handed this `seq` when the call returns.
    pub fn last_seq(&self) -> anyhow::Result<u64> {
        let mut inner = self.inner.lock();
        inner.flush()?;
        Ok(inner.last_present.unwrap_or(0))
    }

    /// Time of the last appended Event, None for an empty log.
    pub fn last_ts_ms(&self) -> Option<i64> {
        Some(self.last_ts_ms.load(Ordering::Relaxed)).filter(|&t| t > 0)
    }

    /// Live subscribers, i.e. open Views.
    pub fn subscriber_count(&self) -> usize {
        self.inner.lock().subscribers.iter().filter(|s| !s.state.dead.load(Ordering::Relaxed)).count()
    }

    /// All Events, from memory (loaded from the file the first time): shared handles, not copies.
    /// For cold paths (export, replay, a transcript). Hot paths read a projection.
    pub fn events(&self) -> anyhow::Result<Vec<Arc<Event>>> {
        self.project(|inner| inner.events.clone().unwrap_or_default())
    }

    /// Runs `read` on the loaded log under its lock (a held chunk is flushed first).
    fn project<T>(&self, read: impl FnOnce(&Inner) -> T) -> anyhow::Result<T> {
        let mut inner = self.inner.lock();
        inner.flush()?;
        inner.ensure_loaded()?;
        Ok(read(&inner))
    }

    /// Attached Shared Artifact ids, in order of attaching. Projection, no scan.
    pub fn attached_shared(&self) -> anyhow::Result<Vec<String>> {
        self.project(|i| i.proj.attached.clone())
    }

    /// Review Comments in the order added, with their state. Projection, no scan.
    pub fn comments(&self) -> anyhow::Result<Vec<crate::api::CommentState>> {
        self.project(|i| i.proj.comments.clone())
    }

    /// How many `CommentAdded` the log holds (deleted ones too): ids are never reused.
    pub fn comments_added(&self) -> anyhow::Result<usize> {
        self.project(|i| i.proj.comments_added)
    }

    /// Live Frontend Tool items (calls that named an `id`, not removed since), first seen first. Projection, no scan.
    pub fn frontend_items(&self) -> anyhow::Result<Vec<Arc<FrontendItem>>> {
        self.project(|i| i.proj.frontend.items.values().cloned().collect())
    }

    /// One live Frontend Tool item by tool and id. Projection, one lookup.
    pub fn frontend_item(&self, tool: &str, id: &str) -> anyhow::Result<Option<Arc<FrontendItem>>> {
        self.project(|i| {
            let f = &i.proj.frontend;
            f.pos.get(&(tool.to_owned(), id.to_owned())).and_then(|k| f.items.get(k)).map(Arc::clone)
        })
    }

    #[cfg(test)]
    pub(crate) fn frontend_errors_len(&self) -> usize {
        self.project(|i| i.proj.frontend.errors.len()).unwrap()
    }

    /// The Thread of a live item's latest call (an `id`, or the call id of a call without one) and
    /// the messages of its uncleared errors; `None` when the item is gone. Projection, no scan of the log.
    pub fn frontend_item_errors(&self, tool: &str, item: &str) -> anyhow::Result<Option<(ThreadId, Vec<String>)>> {
        self.project(|i| {
            let f = &i.proj.frontend;
            let thread = f.keyed.get(&(tool.to_owned(), item.to_owned()))?;
            Some((thread.clone(), f.errors.iter().filter(|x| x.tool == tool && x.item == item).map(|x| x.message.clone()).collect()))
        })
    }

    /// Live Frontend Tool items by `(tool, item id)` with the Thread of their latest call, and the
    /// errors not cleared since, oldest first. Projection, no scan.
    #[allow(clippy::type_complexity)]
    pub fn frontend_state(&self) -> anyhow::Result<(HashMap<(String, String), ThreadId>, Vec<FrontendErrorEntry>)> {
        self.project(|i| (i.proj.frontend.keyed.clone(), i.proj.frontend.errors()))
    }

    /// Whether the Thread's newest `TurnStarted` / `TurnEnded` is a start. Projection, no scan.
    pub fn thread_turn_open(&self, thread: &ThreadId) -> anyhow::Result<bool> {
        self.project(|i| i.proj.open_turn.get(thread).copied().unwrap_or(false))
    }

    /// `seq` of the Thread's newest `TurnStarted`. Projection, no scan.
    pub fn thread_turn_started(&self, thread: &ThreadId) -> anyhow::Result<Option<u64>> {
        self.project(|i| i.proj.turn_started.get(thread).copied())
    }

    /// The Thread's newest config options (`ConfigOptionsChanged` with an options array). Projection, no scan.
    pub fn thread_config_options(&self, thread: &ThreadId) -> anyhow::Result<Option<Vec<Value>>> {
        self.project(|i| i.proj.config.get(thread).cloned())
    }

    /// The Thread's current Agent mode: the newest `ModeChanged`, or the mode option of the
    /// newest `ConfigOptionsChanged` that has one. Projection, no scan.
    pub fn thread_mode(&self, thread: &ThreadId) -> anyhow::Result<Option<String>> {
        let mut inner = self.inner.lock();
        inner.flush()?;
        inner.ensure_loaded()?;
        Ok(inner.proj.modes.get(thread).cloned())
    }

    /// The newest mode of the Thread that is not the plan mode. Projection, no scan.
    pub fn thread_mode_before_plan(&self, thread: &ThreadId) -> anyhow::Result<Option<String>> {
        let mut inner = self.inner.lock();
        inner.flush()?;
        inner.ensure_loaded()?;
        Ok(inner.proj.before_plan.get(thread).cloned())
    }

    /// The Agent's newest non-blank title (`SessionInfoUpdated`) for the Session's main Thread
    /// (`main`, or Events with no Thread). Projection, no scan.
    pub fn agent_title(&self, main: &ThreadId) -> anyhow::Result<Option<String>> {
        let mut inner = self.inner.lock();
        inner.flush()?;
        inner.ensure_loaded()?;
        let a = inner.proj.titles.get(&Some(main.clone()));
        let b = inner.proj.titles.get(&None);
        Ok(match (a, b) {
            (Some(a), Some(b)) => Some(if a.0 >= b.0 { a } else { b }),
            (a, b) => a.or(b),
        }
        .map(|(_, t)| t.clone()))
    }
}

impl SessionLog {
    /// Writes what is queued, stops the writer and refuses later appends (they error), so files can
    /// be removed without a late Event (an Agent's exit) writing into the directory again.
    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.health.close();
        // A `sync` past the log lock may be writing the checkpoint: wait for it to finish.
        drop(self.checkpointed_len.lock());
        let mut inner = self.inner.lock();
        let _ = inner.flush();
        inner.closed = true;
        // Closing the channel lets the writer finish what is queued; wait for it.
        let writer = inner.writer.take();
        inner.subscribers.clear();
        drop(inner);
        if let Some(mut w) = writer {
            let handle = w.handle.take();
            drop(w);
            if let Some(h) = handle {
                let _ = h.join();
            }
        }
    }
}

impl SessionLog {
    /// Whether anything was appended this run (a writer exists) or a chunk is still held.
    pub fn is_dirty(&self) -> bool {
        let inner = self.inner.lock();
        inner.writer.is_some() || inner.pending.is_some()
    }
}

impl Drop for SessionLog {
    fn drop(&mut self) {
        self.close();
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use parking_lot::Mutex as StdMutex;
    use std::time::Instant;

    fn collector() -> (Box<dyn EventSink>, Arc<StdMutex<Vec<u64>>>) {
        let seen = Arc::new(StdMutex::new(Vec::new()));
        let s = seen.clone();
        (
            Box::new(move |e: &Event| {
                s.lock().push(e.seq);
                true
            }),
            seen,
        )
    }

    /// Waits for a condition that holds once a subscriber thread has caught up.
    fn eventually(what: &str, mut cond: impl FnMut() -> bool) {
        let start = Instant::now();
        while !cond() {
            assert!(start.elapsed() < Duration::from_secs(10), "timed out: {what}");
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    fn msg(t: &str) -> EventKind {
        EventKind::AgentMessageChunk { text: t.into(), parent_tool_call_id: None }
    }

    fn err(m: &str) -> EventKind {
        EventKind::Error { message: m.into() }
    }

    fn open_in(dir: &Path) -> SessionLog {
        SessionLog::open("s".into(), &dir.join("log.jsonl")).unwrap()
    }

    fn line(seq: u64, kind: &str) -> String {
        format!("{{\"v\":1,\"seq\":{seq},\"session_id\":\"s\",\"thread_id\":null,\"ts_ms\":{},\"kind\":{kind}}}\n", 1000 + seq)
    }

    const ERR_KIND: &str = "{\"type\":\"Error\",\"message\":\"x\"}";

    fn write_file(dir: &Path, parts: &[&str]) -> PathBuf {
        let path = dir.join("log.jsonl");
        std::fs::write(&path, parts.concat()).unwrap();
        path
    }

    fn backups(dir: &Path) -> Vec<PathBuf> {
        let mut v: Vec<_> =
            std::fs::read_dir(dir).unwrap().flatten().map(|e| e.path()).filter(|p| p.to_string_lossy().contains("log.jsonl.corrupt-")).collect();
        v.sort();
        v
    }

    #[test]
    fn replay_then_live_without_gaps() {
        let dir = tempfile::tempdir().unwrap();
        let log = open_in(dir.path());
        for i in 0..5 {
            log.append(None, msg(&i.to_string())).unwrap();
        }
        let (sink, seen) = collector();
        log.subscribe(2, sink).unwrap();
        log.append(None, msg("x")).unwrap();
        eventually("replay and live", || seen.lock().len() == 4);
        assert_eq!(*seen.lock(), vec![2, 3, 4, 5]);
    }

    #[test]
    fn subscribing_past_the_head_skips_the_events_before_from() {
        let dir = tempfile::tempdir().unwrap();
        let log = open_in(dir.path());
        for i in 0..3 {
            log.append(None, msg(&i.to_string())).unwrap();
        }
        let (sink, seen) = collector();
        log.subscribe(6, sink).unwrap();
        for i in 3..9 {
            log.append(None, msg(&i.to_string())).unwrap();
        }
        eventually("live from 6", || seen.lock().last() == Some(&8));
        assert_eq!(*seen.lock(), vec![6, 7, 8]);
    }

    #[test]
    fn reopen_continues_seq_and_drops_torn_line() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("log.jsonl");
        {
            let log = open_in(dir.path());
            log.append(None, msg("a")).unwrap();
            log.append(None, msg("b")).unwrap();
        }
        std::fs::OpenOptions::new().append(true).open(&path).unwrap().write_all(b"{\"v\":1,\"se").unwrap();
        let log = open_in(dir.path());
        let ev = log.append(None, msg("c")).unwrap();
        assert_eq!(ev.seq, 2);
        assert_eq!(log.events().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn chunks_coalesce_until_something_else_happens() {
        let dir = tempfile::tempdir().unwrap();
        let log = open_in(dir.path());
        let (sink, seen) = collector();
        log.subscribe(0, sink).unwrap();
        for t in ["Hel", "lo", " world"] {
            log.append(Some("t".into()), msg(t)).unwrap();
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert!(seen.lock().is_empty(), "held back");
        log.append(Some("u".into()), msg("other thread")).unwrap();
        log.append(None, err("x")).unwrap();
        let events = log.events().unwrap();
        let texts: Vec<String> = events.iter().map(|e| serde_json::to_value(&e.kind).unwrap()["text"].as_str().unwrap_or("-").to_owned()).collect();
        assert_eq!(texts, vec!["Hello world", "other thread", "-"]);
        assert_eq!(events.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![0, 1, 2]);

        // A lone chunk is flushed by the timer.
        log.append(None, msg("tail")).unwrap();
        tokio::time::sleep(COALESCE * 3).await;
        eventually("timer flush", || seen.lock().len() == 4);
        assert_eq!(*seen.lock(), vec![0, 1, 2, 3]);
    }

    /// An Agent's exit logs and syncs while a delete closes the log and removes the directory: the
    /// checkpoint is written outside the log lock, so `close` must wait for one in flight, or the
    /// file lands in the directory being removed ("Directory not empty").
    #[test]
    fn close_waits_for_a_checkpoint_in_flight() {
        let dir = tempfile::tempdir().unwrap();
        let sdir = dir.path().join("s");
        std::fs::create_dir_all(&sdir).unwrap();
        let log = Arc::new(SessionLog::open("s".into(), &sdir.join("log.jsonl")).unwrap());
        log.append(None, msg("a")).unwrap();
        let (at_write, writing) = std::sync::mpsc::channel::<()>();
        let (go, wait_go) = std::sync::mpsc::channel::<()>();
        let wait_go = Mutex::new(wait_go);
        *log.before_checkpoint.lock() = Some(Box::new(move || {
            let _ = at_write.send(());
            let _ = wait_go.lock().recv();
        }));
        let l = log.clone();
        let syncing = std::thread::spawn(move || l.sync());
        writing.recv().unwrap();
        let l = log.clone();
        let closing = std::thread::spawn(move || l.close());
        std::thread::sleep(Duration::from_millis(100));
        assert!(!closing.is_finished(), "close waits for the checkpoint being written");
        go.send(()).unwrap();
        closing.join().unwrap();
        syncing.join().unwrap().unwrap();
        std::fs::remove_dir_all(&sdir).unwrap();
        log.sync().unwrap_err();
        assert!(!sdir.exists(), "nothing is written after close");
    }

    #[test]
    fn a_closed_log_writes_nothing_more() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("log.jsonl");
        let log = SessionLog::open("s".into(), &path).unwrap();
        log.append(None, msg("a")).unwrap();
        log.close();
        let len = std::fs::metadata(&path).unwrap().len();
        assert!(len > 0, "queued Events are written before the writer stops");
        std::fs::remove_dir_all(dir.path()).unwrap();
        assert!(log.append(None, EventKind::Error { message: "late".into() }).is_err());
        assert!(!dir.path().exists(), "a late append does not recreate the directory");
    }

    #[test]
    fn closed_sink_is_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let log = open_in(dir.path());
        log.subscribe(0, Box::new(|_: &Event| false)).unwrap();
        log.append(None, msg("a")).unwrap();
        eventually("sink dropped", || log.subscriber_count() == 0);
    }

    // ----- item 3: never lose history -----

    #[test]
    fn a_garbage_line_mid_file_is_kept_and_later_events_survive() {
        let dir = tempfile::tempdir().unwrap();
        let content =
            [line(0, ERR_KIND), "not json at all\n".into(), line(1, ERR_KIND), "{\"v\":1,\"seq\":2,\"kind\":{\"type\":\"Error\"}}\n".into(), line(3, ERR_KIND)]
                .concat();
        let path = write_file(dir.path(), &[&content]);
        let log = open_in(dir.path());
        // Both bad lines lack an Event envelope: left out of the view, kept in the file.
        let events = log.events().unwrap();
        assert_eq!(events.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![0, 1, 3]);
        assert_eq!(log.append(None, err("new")).unwrap().seq, 4);
        drop(log);
        let after = std::fs::read(&path).unwrap();
        assert!(after.starts_with(content.as_bytes()), "no byte of history lost or changed");
        let copies = backups(dir.path());
        assert_eq!(copies.len(), 1);
        assert_eq!(std::fs::read(&copies[0]).unwrap(), content.as_bytes());
        // Opening again does not make another copy.
        drop(open_in(dir.path()));
        assert_eq!(backups(dir.path()).len(), 1);
    }

    #[test]
    fn a_standin_keeps_seq_for_a_line_whose_kind_does_not_parse() {
        let dir = tempfile::tempdir().unwrap();
        write_file(dir.path(), &[&line(0, ERR_KIND), &line(1, "{\"type\":\"Error\"}"), &line(2, ERR_KIND)]);
        let events = open_in(dir.path()).events().unwrap();
        assert_eq!(events.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![0, 1, 2]);
        assert!(matches!(events[1].kind, EventKind::Unknown));
    }

    #[test]
    fn an_unknown_type_reads_as_unknown_without_a_copy() {
        let dir = tempfile::tempdir().unwrap();
        let content = [line(0, ERR_KIND), line(1, "{\"type\":\"BrandNewKind\",\"x\":[1,2],\"y\":{\"z\":1}}"), line(2, ERR_KIND)].concat();
        let path = write_file(dir.path(), &[&content]);
        let log = open_in(dir.path());
        let events = log.events().unwrap();
        assert_eq!(events.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![0, 1, 2]);
        assert!(matches!(events[1].kind, EventKind::Unknown));
        assert_eq!(log.append(None, err("n")).unwrap().seq, 3);
        drop(log);
        assert!(std::fs::read(&path).unwrap().starts_with(content.as_bytes()));
        assert!(backups(dir.path()).is_empty());
    }

    #[test]
    fn a_future_schema_version_opens_read_only_and_is_not_rewritten() {
        let dir = tempfile::tempdir().unwrap();
        let future = format!(
            "{{\"v\":{},\"seq\":1,\"session_id\":\"s\",\"thread_id\":null,\"ts_ms\":5,\"kind\":{{\"type\":\"Shiny\",\"a\":1}}}}\n",
            EVENT_SCHEMA_VERSION + 1
        );
        // A torn tail too: a read-only log is not touched at all.
        let content = [line(0, ERR_KIND), future, "{\"v\":".into()].concat();
        let path = write_file(dir.path(), &[&content]);
        let log = open_in(dir.path());
        let reason = log.read_only_reason().unwrap().to_owned();
        assert!(reason.contains("newer version"), "{reason}");
        assert!(log.append(None, err("n")).unwrap_err().to_string().contains("newer version"));
        assert_eq!(log.events().unwrap().len(), 2);
        drop(log);
        assert_eq!(std::fs::read(&path).unwrap(), content.as_bytes());
    }

    #[test]
    fn only_a_torn_tail_shortens_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let good = [line(0, ERR_KIND), line(1, ERR_KIND)].concat();
        let path = write_file(dir.path(), &[&good, "{\"v\":1,\"seq\":2,\"sess"]);
        let log = open_in(dir.path());
        assert_eq!(log.events().unwrap().len(), 2);
        drop(log);
        assert_eq!(std::fs::read(&path).unwrap(), good.as_bytes());
    }

    #[test]
    fn open_and_a_fresh_read_agree() {
        let dir = tempfile::tempdir().unwrap();
        let content = [line(0, ERR_KIND), "garbage\n".into(), line(1, "{\"type\":\"New\"}"), line(2, ERR_KIND)].concat();
        write_file(dir.path(), &[&content]);
        let log = open_in(dir.path());
        let next = log.append(None, err("n")).unwrap().seq;
        let seqs: Vec<u64> = log.events().unwrap().iter().map(|e| e.seq).collect();
        assert_eq!(seqs, vec![0, 1, 2, next]);
        assert_eq!(next, 3);
        // Reading the file from scratch gives the same.
        drop(log);
        let again: Vec<u64> = open_in(dir.path()).events().unwrap().iter().map(|e| e.seq).collect();
        assert_eq!(again, seqs);
    }

    // ----- item 6: memory and projections -----

    #[test]
    fn reads_and_projections_do_not_touch_the_file_after_load() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("log.jsonl");
        let log = open_in(dir.path());
        log.append(Some("t".into()), EventKind::mode_changed("plan".into(), None)).unwrap();
        log.append(Some("t".into()), EventKind::config_options(serde_json::json!([{"id":"mode","currentValue":"auto"}]))).unwrap();
        log.append(Some("u".into()), EventKind::mode_changed("x".into(), None)).unwrap();
        log.append(Some("t".into()), EventKind::config_options(serde_json::json!([{"id":"model","currentValue":"m"}]))).unwrap();
        log.append(None, EventKind::SessionInfoUpdated { title: Some("  ".into()) }).unwrap();
        log.append(Some("t".into()), EventKind::SessionInfoUpdated { title: Some("Hello".into()) }).unwrap();
        assert_eq!(log.events().unwrap().len(), 6);
        std::fs::remove_file(&path).unwrap();
        assert_eq!(log.thread_mode(&"t".into()).unwrap().as_deref(), Some("auto"));
        assert_eq!(log.thread_mode(&"u".into()).unwrap().as_deref(), Some("x"));
        assert_eq!(log.thread_mode(&"v".into()).unwrap(), None);
        assert_eq!(log.agent_title(&"t".into()).unwrap().as_deref(), Some("Hello"));
        log.append(Some("t".into()), EventKind::mode_changed("plan".into(), None)).unwrap();
        assert_eq!(log.thread_mode(&"t".into()).unwrap().as_deref(), Some("plan"));
        assert_eq!(log.events().unwrap().len(), 7);
    }

    #[test]
    fn before_plan_projection_keeps_the_newest_non_plan_mode_per_thread() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = |v: &str| EventKind::config_options(serde_json::json!([{"id":"mode","category":"mode","currentValue":v}]));
        let log = open_in(dir.path());
        let before = |l: &SessionLog, t: &str| l.thread_mode_before_plan(&t.into()).unwrap();
        // A Thread that started in plan has nothing to go back to.
        log.append(Some("t".into()), cfg("plan")).unwrap();
        assert_eq!(before(&log, "t"), None);
        log.append(Some("t".into()), EventKind::mode_changed("auto".into(), None)).unwrap();
        log.append(Some("t".into()), cfg("plan")).unwrap();
        // plan -> plan keeps the earlier mode.
        log.append(Some("t".into()), EventKind::mode_changed("plan".into(), None)).unwrap();
        assert_eq!(before(&log, "t").as_deref(), Some("auto"));
        // An empty id is no mode.
        log.append(Some("t".into()), EventKind::mode_changed(String::new(), None)).unwrap();
        log.append(Some("t".into()), cfg("")).unwrap();
        assert_eq!(before(&log, "t").as_deref(), Some("auto"));
        assert_eq!(log.thread_mode(&"t".into()).unwrap().as_deref(), Some("plan"));
        // Threads are isolated.
        log.append(Some("u".into()), cfg("default")).unwrap();
        assert_eq!(before(&log, "u").as_deref(), Some("default"));
        assert_eq!(before(&log, "t").as_deref(), Some("auto"));
        assert_eq!(before(&log, "v"), None);
        // The same after reopening the log from disk.
        log.sync().unwrap();
        drop(log);
        let log = open_in(dir.path());
        assert_eq!(before(&log, "t").as_deref(), Some("auto"));
        assert_eq!(before(&log, "u").as_deref(), Some("default"));
        assert_eq!(log.thread_mode(&"t".into()).unwrap().as_deref(), Some("plan"));
    }

    #[test]
    fn a_permission_path_query_on_a_big_log_is_memory_only_and_fast() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("log.jsonl");
        let mut content = String::new();
        for i in 0..50_000u64 {
            content.push_str(
                &line(i, if i % 1000 == 0 { "{\"type\":\"ModeChanged\",\"mode_id\":\"m\"}" } else { ERR_KIND })
                    .replace("\"thread_id\":null", "\"thread_id\":\"t\""),
            );
        }
        std::fs::write(&path, content).unwrap();
        let log = open_in(dir.path());
        assert_eq!(log.thread_mode(&"t".into()).unwrap().as_deref(), Some("m"));
        std::fs::remove_file(&path).unwrap();
        let start = Instant::now();
        for _ in 0..1000 {
            assert_eq!(log.thread_mode(&"t".into()).unwrap().as_deref(), Some("m"));
        }
        let per_call = start.elapsed() / 1000;
        assert!(per_call < Duration::from_micros(200), "{per_call:?} per call");
        assert_eq!(log.events().unwrap().len(), 50_000, "still served from memory");
    }

    // ----- item 7: fan-out -----

    #[test]
    fn a_slow_sink_does_not_slow_appends() {
        let dir = tempfile::tempdir().unwrap();
        let log = open_in(dir.path());
        log.subscribe(
            0,
            Box::new(|_: &Event| {
                std::thread::sleep(Duration::from_millis(200));
                true
            }),
        )
        .unwrap();
        let mut worst = Duration::ZERO;
        for i in 0..100 {
            let t = Instant::now();
            log.append(None, err(&i.to_string())).unwrap();
            worst = worst.max(t.elapsed());
        }
        assert!(worst < Duration::from_millis(20), "slowest append {worst:?}");
        // A subscribe while the other is stuck also returns at once.
        let t = Instant::now();
        let (sink, seen) = collector();
        log.subscribe(0, sink).unwrap();
        assert!(t.elapsed() < Duration::from_millis(100));
        eventually("second view caught up", || seen.lock().len() == 100);
    }

    #[test]
    fn replay_plus_live_has_no_gaps_or_duplicates_under_concurrent_appends() {
        let dir = tempfile::tempdir().unwrap();
        let log = Arc::new(open_in(dir.path()));
        for i in 0..200 {
            log.append(None, err(&i.to_string())).unwrap();
        }
        let appender = {
            let log = log.clone();
            std::thread::spawn(move || {
                for i in 0..2000 {
                    log.append(None, err(&i.to_string())).unwrap();
                }
            })
        };
        let mut views = Vec::new();
        for from in [0u64, 50, 150, 300] {
            let (sink, seen) = collector();
            log.subscribe(from, sink).unwrap();
            views.push((from, seen));
            std::thread::sleep(Duration::from_millis(1));
        }
        appender.join().unwrap();
        let last = log.last_seq().unwrap();
        assert_eq!(last, 2199);
        for (from, seen) in views {
            eventually("view caught up", || seen.lock().last() == Some(&last));
            let want: Vec<u64> = (from..=last).collect();
            assert_eq!(*seen.lock(), want, "view from {from}");
        }
    }

    // ----- pages (ADR 0029) -----

    fn seqs(page: &LogPage) -> Vec<u64> {
        page.events.iter().map(|r| serde_json::from_str::<Event>(r.get()).unwrap().seq).collect()
    }

    /// Reads the log as a View that opens it does: the first page, then on up to its `end`.
    /// Returns (the `seq`s read, `end`, how many pages).
    fn read_all(log: &SessionLog, from: u64, max_events: usize, max_bytes: usize) -> (Vec<u64>, u64, usize) {
        let first = log.read_page(from, None, max_events, max_bytes).unwrap();
        let end = first.end;
        let (mut got, mut more, mut pages) = (seqs(&first), first.more, 1);
        while more {
            let next = got.last().map_or(from, |s| s + 1);
            let page = log.read_page(next, Some(end), max_events, max_bytes).unwrap();
            assert!(!page.events.is_empty(), "a page with more to come makes progress");
            assert_eq!(page.end, end);
            got.extend(seqs(&page));
            more = page.more;
            pages += 1;
        }
        (got, end, pages)
    }

    #[test]
    fn an_empty_log_reads_as_one_empty_page_that_ends_at_zero() {
        let dir = tempfile::tempdir().unwrap();
        let log = open_in(dir.path());
        let page = log.read_page(0, None, 10, PAGE_BYTES).unwrap();
        assert_eq!((seqs(&page), page.end, page.more), (vec![], 0, false));
    }

    #[test]
    fn a_page_covers_a_seq_range_up_to_the_event_limit() {
        let dir = tempfile::tempdir().unwrap();
        let log = open_in(dir.path());
        for i in 0..10 {
            log.append(None, err(&i.to_string())).unwrap();
        }
        let page = log.read_page(0, None, 4, PAGE_BYTES).unwrap();
        assert_eq!((seqs(&page), page.end, page.more), (vec![0, 1, 2, 3], 10, true), "end: the next seq");
        let page = log.read_page(4, Some(7), 4, PAGE_BYTES).unwrap();
        assert_eq!((seqs(&page), page.end, page.more), (vec![4, 5, 6], 7, false));
        // Appended after the first page: not in a read bounded by its end.
        log.append(None, err("late")).unwrap();
        let page = log.read_page(8, Some(10), 4, PAGE_BYTES).unwrap();
        assert_eq!((seqs(&page), page.end, page.more), (vec![8, 9], 10, false));
        // Without a bound the end moved on.
        let page = log.read_page(8, None, 4, PAGE_BYTES).unwrap();
        assert_eq!((seqs(&page), page.end, page.more), (vec![8, 9, 10], 11, false));
        // From the end or past it, or a bound below the start: nothing, and nothing more.
        let page = log.read_page(11, None, 4, PAGE_BYTES).unwrap();
        assert_eq!((seqs(&page), page.end, page.more), (vec![], 11, false));
        let page = log.read_page(5, Some(3), 4, PAGE_BYTES).unwrap();
        assert_eq!((seqs(&page), page.end, page.more), (vec![], 3, false));
        // A zero limit still makes progress.
        let page = log.read_page(0, None, 0, 0).unwrap();
        assert_eq!((seqs(&page), page.more), (vec![0], true));
    }

    #[test]
    fn the_byte_limit_cuts_a_page_and_a_bigger_event_comes_alone() {
        let dir = tempfile::tempdir().unwrap();
        let log = open_in(dir.path());
        for m in ["a", "b", &"x".repeat(10_000), "c", "d"] {
            log.append(None, err(m)).unwrap();
        }
        let small = serde_json::to_string(&*log.events().unwrap()[0]).unwrap().len();
        let limit = 2 * small + 1;
        let page = log.read_page(0, None, 100, limit).unwrap();
        assert_eq!((seqs(&page), page.more), (vec![0, 1], true));
        let page = log.read_page(2, Some(5), 100, limit).unwrap();
        assert_eq!((seqs(&page), page.more), (vec![2], true), "larger than the limit, but a page holds at least one");
        let page = log.read_page(3, Some(5), 100, limit).unwrap();
        assert_eq!((seqs(&page), page.more), (vec![3, 4], false));
        assert_eq!(read_all(&log, 0, 100, limit), ((0..5).collect(), 5, 3));
        // The page's Events are the log's, serialized whole.
        let page = log.read_page(2, Some(3), 100, limit).unwrap();
        let ev: Event = serde_json::from_str(page.events[0].get()).unwrap();
        assert!(matches!(ev.kind, EventKind::Error { message } if message.len() == 10_000));
    }

    #[test]
    fn pages_then_a_subscription_from_their_end_have_no_gap_or_duplicate_under_concurrent_appends() {
        let dir = tempfile::tempdir().unwrap();
        let log = Arc::new(open_in(dir.path()));
        for i in 0..200 {
            log.append(None, err(&i.to_string())).unwrap();
        }
        let appender = {
            let log = log.clone();
            std::thread::spawn(move || {
                for i in 0..2000 {
                    log.append(None, err(&i.to_string())).unwrap();
                }
            })
        };
        // A fresh View from 0 and one with a cached fold up to 50, each paging while appends go on.
        let mut views = Vec::new();
        for from in [0u64, 50] {
            let (paged, end, _) = read_all(&log, from, 7, PAGE_BYTES);
            assert_eq!(paged, (from..end).collect::<Vec<_>>(), "pages from {from} hold every Event below their end");
            let (sink, live) = collector();
            log.subscribe(end, sink).unwrap();
            views.push((from, paged, live));
        }
        appender.join().unwrap();
        let last = log.last_seq().unwrap();
        assert_eq!(last, 2199);
        for (from, paged, live) in views {
            // The appender may have finished before the subscription: then live has nothing.
            eventually("live caught up", || paged.last().max(live.lock().last()) == Some(&last));
            let all: Vec<u64> = paged.iter().chain(live.lock().iter()).copied().collect();
            assert_eq!(all, (from..=last).collect::<Vec<_>>(), "View from {from}");
        }
    }

    #[tokio::test]
    async fn a_held_chunk_is_in_the_page_or_after_its_end_never_lost() {
        let dir = tempfile::tempdir().unwrap();
        let log = open_in(dir.path());
        log.append(None, err("a")).unwrap();
        log.append(Some("t".into()), msg("Hel")).unwrap();
        // The read flushes the held chunk: it is in the page, below the end.
        let page = log.read_page(0, None, 10, PAGE_BYTES).unwrap();
        assert_eq!((seqs(&page), page.end, page.more), (vec![0, 1], 2, false));
        let chunk: Event = serde_json::from_str(page.events[1].get()).unwrap();
        assert!(matches!(chunk.kind, EventKind::AgentMessageChunk { text, .. } if text == "Hel"));
        // A chunk after the read is a new Event at the end, held until the subscription flushes it.
        log.append(Some("t".into()), msg("lo")).unwrap();
        let (sink, live) = collector();
        log.subscribe(page.end, sink).unwrap();
        eventually("the held chunk", || *live.lock() == vec![2]);
    }

    /// Serializing a big log for a View: one message per Event (a subscription's replay: a deep
    /// clone, then its own JSON, as `ViewSink` and a Tauri Channel do) against pages (`read_page`,
    /// then the page's JSON, as the Tauri command's answer). Rust side only: the IPC cost per
    /// message and the parse in the webview are not in it.
    /// `cargo test -p harness-core --release --lib -- --ignored --nocapture page_bench`
    #[test]
    #[ignore = "bench: run with --release --ignored --nocapture"]
    fn page_bench() {
        use crate::api::SessionMessage;
        const N: u64 = 15_000;
        let dir = tempfile::tempdir().unwrap();
        let text = "lorem ipsum ".repeat(25);
        let output = "0123456789abcdef ".repeat(180);
        let mut content = String::new();
        for i in 0..N {
            let kind = if i % 10 < 7 {
                format!("{{\"type\":\"AgentMessageChunk\",\"text\":\"{text}\"}}")
            } else {
                format!(
                    "{{\"type\":\"ToolCallUpdate\",\"tool_call_id\":\"t{i}\",\"status\":\"completed\",\"content\":[{{\"type\":\"content\",\"content\":{{\"type\":\"text\",\"text\":\"{output}\"}}}}],\"raw_output\":{{\"output\":\"{output}\",\"exit\":0}}}}"
                )
            };
            content.push_str(&line(i, &kind));
        }
        std::fs::write(dir.path().join("log.jsonl"), &content).unwrap();
        let log = open_in(dir.path());
        let events = log.events().unwrap();
        assert_eq!(events.len() as u64, N);

        let t = Instant::now();
        let mut one_bytes = 0;
        for ev in &events {
            one_bytes += serde_json::to_string(&SessionMessage::Event((**ev).clone())).unwrap().len();
        }
        let one = t.elapsed();

        let t = Instant::now();
        let (mut page_bytes, mut pages, mut from, mut to) = (0, 0, 0, None);
        loop {
            let page = log.read_page(from, to, PAGE_EVENTS, PAGE_BYTES).unwrap();
            from = seqs_last(&page).map_or(from, |s| s + 1);
            to = Some(page.end);
            page_bytes += serde_json::to_string(&page).unwrap().len();
            pages += 1;
            if !page.more {
                break;
            }
        }
        let paged = t.elapsed();
        eprintln!(
            "page_bench: {N} Events, {:.1} MB in the file\n  one per Event: {N} messages, {:.1} MB, {:.1} ms\n  pages:         {pages} messages, {:.1} MB, {:.1} ms",
            content.len() as f64 / 1e6,
            one_bytes as f64 / 1e6,
            one.as_secs_f64() * 1e3,
            page_bytes as f64 / 1e6,
            paged.as_secs_f64() * 1e3,
        );
    }

    /// The `seq` of a page's last Event, read without parsing the others.
    fn seqs_last(page: &LogPage) -> Option<u64> {
        page.events.last().map(|r| serde_json::from_str::<Event>(r.get()).unwrap().seq)
    }

    #[test]
    fn overflow_delivers_lagged_then_drops_the_subscriber() {
        struct Stuck {
            gate: Arc<StdMutex<()>>,
            got: Arc<StdMutex<Vec<u64>>>,
            lagged: Arc<StdMutex<Option<Option<u64>>>>,
        }
        impl EventSink for Stuck {
            fn send(&self, e: &Event) -> bool {
                let _g = self.gate.lock();
                self.got.lock().push(e.seq);
                true
            }
            fn lagged(&self, last_seq: Option<u64>) {
                *self.lagged.lock() = Some(last_seq);
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let log = open_in(dir.path());
        let gate = Arc::new(StdMutex::new(()));
        let held = gate.lock();
        let got = Arc::new(StdMutex::new(Vec::new()));
        let lagged = Arc::new(StdMutex::new(None));
        log.subscribe(0, Box::new(Stuck { gate: gate.clone(), got: got.clone(), lagged: lagged.clone() })).unwrap();
        // One Event is in the sink (blocked), QUEUE_CAP queued, the next overflows.
        for i in 0..(QUEUE_CAP + 10) {
            log.append(None, err(&i.to_string())).unwrap();
        }
        assert_eq!(log.subscriber_count(), 0, "dropped");
        drop(held);
        eventually("lagged", || lagged.lock().is_some());
        let last = lagged.lock().unwrap().unwrap();
        eventually("queue drained", || got.lock().last() == Some(&last));
        // Everything up to `last_seq` arrived in order, nothing after it.
        assert_eq!(*got.lock(), (0..=last).collect::<Vec<u64>>());
        assert!(last < (QUEUE_CAP + 10) as u64 - 1);
        // The View resubscribes from last_seq + 1 and gets the rest.
        let (sink, seen) = collector();
        log.subscribe(last + 1, sink).unwrap();
        eventually("resubscribed", || seen.lock().len() as u64 == (QUEUE_CAP as u64 + 10) - (last + 1));
        assert_eq!(*seen.lock().first().unwrap(), last + 1);
    }

    // ----- item 8: checkpoint -----

    #[test]
    fn open_trusts_the_checkpoint_and_parses_only_the_tail() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("log.jsonl");
        {
            let log = open_in(dir.path());
            for i in 0..5 {
                log.append(None, err(&i.to_string())).unwrap();
            }
            log.append(None, EventKind::AgentProcessState { state: ProcessState::Ready, message: None }).unwrap();
            log.sync().unwrap();
            log.append(None, err("after the checkpoint")).unwrap();
        }
        let cp: Checkpoint = serde_json::from_slice(&std::fs::read(checkpoint_path(&path)).unwrap()).unwrap();
        assert_eq!(cp.next_seq, 6);
        assert!(cp.agent_was_running);
        // Corrupt a byte before `byte_len` without changing lengths: a full parse would notice.
        let mut bytes = std::fs::read(&path).unwrap();
        bytes[3] = b'#';
        std::fs::write(&path, &bytes).unwrap();
        let log = open_in(dir.path());
        assert!(backups(dir.path()).is_empty(), "the prefix was not parsed");
        assert_eq!(log.append(None, err("n")).unwrap().seq, 7, "next_seq counts the tail event");
        assert!(log.agent_was_running);
    }

    #[test]
    fn a_stale_checkpoint_falls_back_to_a_full_scan() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("log.jsonl");
        {
            let log = open_in(dir.path());
            for i in 0..4 {
                log.append(None, err(&i.to_string())).unwrap();
            }
            log.sync().unwrap();
        }
        // The file is shorter than the checkpoint says (restored from a backup, say).
        let content = std::fs::read_to_string(&path).unwrap();
        let first_two: String = content.lines().take(2).map(|l| format!("{l}\n")).collect();
        std::fs::write(&path, &first_two).unwrap();
        assert_eq!(open_in(dir.path()).append(None, err("n")).unwrap().seq, 2);
        // A checkpoint that does not end at a line boundary is not trusted either.
        std::fs::write(checkpoint_path(&path), br#"{"next_seq":99,"last_ts_ms":1,"agent_was_running":false,"byte_len":10}"#).unwrap();
        assert_eq!(open_in(dir.path()).append(None, err("m")).unwrap().seq, 3);
        // Garbage checkpoint.
        std::fs::write(checkpoint_path(&path), b"nope").unwrap();
        assert_eq!(open_in(dir.path()).append(None, err("k")).unwrap().seq, 4);
    }

    #[test]
    fn sync_writes_the_checkpoint_once_per_length() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("log.jsonl");
        let log = open_in(dir.path());
        log.append(None, err("a")).unwrap();
        log.sync().unwrap();
        let cp: Checkpoint = serde_json::from_slice(&std::fs::read(checkpoint_path(&path)).unwrap()).unwrap();
        assert_eq!(cp.byte_len, std::fs::metadata(&path).unwrap().len());
        assert_eq!(cp.next_seq, 1);
    }

    #[test]
    fn two_logs_on_one_file_never_leave_a_gap() {
        // The data directory lock keeps two Harnesses apart; append mode is the second defense.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("log.jsonl");
        let first = open_in(dir.path());
        first.append(None, msg("a")).unwrap();
        first.sync().unwrap();
        let second = open_in(dir.path());
        first.append(None, msg("b")).unwrap();
        second.append(None, msg("c")).unwrap();
        first.sync().unwrap();
        second.sync().unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert!(!bytes.contains(&0), "no zero-byte gap");
        assert_eq!(bytes.iter().filter(|&&b| b == b'\n').count(), 3);
    }

    fn health_hook(log: &SessionLog) -> Arc<StdMutex<Vec<LogHealth>>> {
        let seen = Arc::new(StdMutex::new(Vec::new()));
        let s = seen.clone();
        log.set_health_hook(move |c| s.lock().push(c.clone()));
        seen
    }

    #[cfg(unix)]
    fn chmod(path: &Path, mode: u32) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    /// A write that fails marks the log degraded once, later appends try again, and a good write
    /// clears it. The file stays well formed and Views kept getting the Events live.
    #[cfg(unix)]
    #[test]
    fn an_unwritable_file_degrades_the_log_and_recovers() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_file(dir.path(), &[&line(0, ERR_KIND), &line(1, ERR_KIND)]);
        let log = open_in(dir.path());
        let hooks = health_hook(&log);
        let (sink, live) = collector();
        log.subscribe(0, sink).unwrap();
        assert_eq!(log.events().unwrap().len(), 2);
        assert_eq!(log.degraded(), None);

        // Nothing written yet, so the writer has not opened the file: it cannot now.
        chmod(&path, 0o000);
        for i in 0..3 {
            log.append(None, err(&format!("lost {i}"))).unwrap();
        }
        eventually("degraded", || log.degraded().is_some());
        assert!(log.sync().is_err(), "a sync says the file is not written");
        log.append(None, err("lost 3")).unwrap();
        log.append(None, err("lost 4")).unwrap();
        eventually("all lost", || log.sync().is_err() && log.events().unwrap().len() == 7);
        // Live Views and memory still have everything; no lock is held across the failure.
        eventually("live", || live.lock().len() == 7);
        assert_eq!(log.last_seq().unwrap(), 6);
        eventually("hook", || !hooks.lock().is_empty());
        assert!(matches!(&hooks.lock()[..], [LogHealth::Degraded(_)]), "reported once: {:?}", hooks.lock());

        chmod(&path, 0o644);
        let kept = log.append(None, err("kept")).unwrap();
        assert_eq!(kept.seq, 7);
        log.sync().unwrap();
        assert_eq!(log.degraded(), None);
        eventually("recovered", || hooks.lock().len() == 2);
        assert_eq!(hooks.lock()[1], LogHealth::Recovered { dropped: 5 });
        // Later writes just work, and report nothing more.
        log.append(None, err("after")).unwrap();
        log.sync().unwrap();
        drop(log);

        let text = std::fs::read_to_string(&path).unwrap();
        let seqs: Vec<u64> = text.lines().map(|l| serde_json::from_str::<Event>(l).unwrap().seq).collect();
        assert_eq!(seqs, vec![0, 1, 7, 8], "whole lines, ascending; the lost Events leave a gap");
        let again = open_in(dir.path());
        assert_eq!(again.events().unwrap().len(), 4);
        assert_eq!(again.last_seq().unwrap(), 8);
        assert_eq!(again.degraded(), None);
    }

    #[test]
    fn a_partial_tail_gets_a_newline_and_nothing_is_cut() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_file(dir.path(), &[&line(0, ERR_KIND)]);
        let mut st = FileState::new(std::fs::metadata(&path).unwrap().len());
        st.append(&path, line(1, ERR_KIND).as_bytes()).unwrap();
        // A write that died half way left a partial line (here ending in a multi-byte character).
        let partial = "{\"v\":1,\"seq\":2,\"message\":\"h\u{e9}\u{1f600}".as_bytes();
        std::fs::OpenOptions::new().append(true).open(&path).unwrap().write_all(&partial[..partial.len() - 2]).unwrap();
        st.broke();
        st.append(&path, line(3, ERR_KIND).as_bytes()).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        let lines: Vec<&[u8]> = bytes.split(|b| *b == b'\n').filter(|l| !l.is_empty()).collect();
        assert_eq!(lines.len(), 4);
        assert!(lines[2].starts_with(b"{\"v\":1,\"seq\":2"), "the partial line is kept as it was");
        assert!(bytes.ends_with(line(3, ERR_KIND).as_bytes()));
        // `open` keeps it as a bad line and reads the Events around it.
        let log = open_in(dir.path());
        assert_eq!(log.events().unwrap().iter().map(|e| e.seq).collect::<Vec<_>>(), vec![0, 1, 3]);
    }

    #[test]
    fn a_longer_foreign_file_is_not_cut() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_file(dir.path(), &[&line(0, ERR_KIND)]);
        let mut st = FileState::new(std::fs::metadata(&path).unwrap().len());
        st.append(&path, line(1, ERR_KIND).as_bytes()).unwrap();
        let foreign = format!("{}{}", line(2, ERR_KIND), line(3, ERR_KIND));
        std::fs::OpenOptions::new().append(true).open(&path).unwrap().write_all(foreign.as_bytes()).unwrap();
        st.broke();
        st.append(&path, line(4, ERR_KIND).as_bytes()).unwrap();
        let expected = [line(0, ERR_KIND), line(1, ERR_KIND), foreign, line(4, ERR_KIND)].concat();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), expected);
    }

    #[test]
    fn a_file_that_went_missing_is_started_again_without_zero_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_file(dir.path(), &[&line(0, ERR_KIND)]);
        let mut st = FileState::new(std::fs::metadata(&path).unwrap().len());
        st.append(&path, line(1, ERR_KIND).as_bytes()).unwrap();
        std::fs::write(checkpoint_path(&path), b"{}").unwrap();
        std::fs::remove_file(&path).unwrap();
        st.broke();
        st.append(&path, line(2, ERR_KIND).as_bytes()).unwrap();
        assert!(!checkpoint_path(&path).exists(), "the checkpoint described the old file");
        let bytes = std::fs::read(&path).unwrap();
        assert!(!bytes.contains(&0));
        assert_eq!(bytes, line(2, ERR_KIND).into_bytes());
    }

    #[test]
    fn a_refused_append_is_reported_and_a_closed_log_is_not() {
        let dir = tempfile::tempdir().unwrap();
        let future = "{\"v\":999,\"seq\":0,\"session_id\":\"s\",\"thread_id\":null,\"ts_ms\":5,\"kind\":{\"type\":\"Error\",\"message\":\"x\"}}\n";
        write_file(dir.path(), &[future]);
        let log = open_in(dir.path());
        let hooks = health_hook(&log);
        assert!(log.append_or_report(None, err("a")).is_none());
        assert!(log.degraded().unwrap().contains("newer version"));
        log.append_or_report(None, err("b"));
        eventually("hook", || !hooks.lock().is_empty());
        assert_eq!(hooks.lock().len(), 1, "reported once");

        let dir = tempfile::tempdir().unwrap();
        let log = open_in(dir.path());
        assert!(log.append_or_report(None, err("a")).is_some());
        log.close();
        assert!(log.append_or_report(None, err("b")).is_none());
        assert_eq!(log.degraded(), None, "closing on purpose is not a failure");
    }

    /// Restart after the tail was dropped: `last_seq` is what the file has, and the dropped `seq`s
    /// are not handed out again (the checkpoint carries `next_seq`).
    #[test]
    fn a_restart_after_a_dropped_tail_does_not_name_or_reuse_missing_seqs() {
        let dir = tempfile::tempdir().unwrap();
        let log = open_in(dir.path());
        log.append(None, err("kept")).unwrap();
        log.sync().unwrap();
        log.inject_write_failure(true);
        for i in 0..3 {
            log.append(None, err(&format!("lost {i}"))).unwrap();
        }
        eventually("degraded", || log.degraded().is_some());
        // The sync is queued behind the three writes and fails while the injection is on: once it
        // answers, all three were processed (degraded alone only says the first one failed).
        assert!(log.sync().is_err());
        log.inject_write_failure(false);
        // The disk is back; a sync probes it and writes the checkpoint with the counted `next_seq`.
        log.sync().unwrap();
        assert_eq!(log.degraded(), None);
        drop(log);
        let again = open_in(dir.path());
        assert_eq!(again.last_seq().unwrap(), 0, "the newest Event in the file");
        assert_eq!(again.append(None, err("next")).unwrap().seq, 4, "no seq of a dropped Event is used again");
        assert_eq!(again.last_seq().unwrap(), 4);
    }

    /// Whatever order a caller-thread failure and a writer-thread success arrive in, what was
    /// reported ends up the same as the flag.
    #[test]
    fn what_was_reported_matches_the_flag() {
        let dir = tempfile::tempdir().unwrap();
        let log = Arc::new(open_in(dir.path()));
        let hooks = health_hook(&log);
        let failer = {
            let log = log.clone();
            std::thread::spawn(move || {
                for _ in 0..300 {
                    log.health.fail("refused".into(), false);
                }
            })
        };
        for i in 0..300 {
            log.append(None, err(&i.to_string())).unwrap();
        }
        failer.join().unwrap();
        log.sync().unwrap();
        eventually("settled", || {
            let h = hooks.lock();
            let reported_degraded = h.last().map(|c| matches!(c, LogHealth::Degraded(_)));
            reported_degraded.unwrap_or(false) == log.degraded().is_some()
        });
        let h = hooks.lock();
        assert!(
            h.windows(2).all(|w| matches!(
                (&w[0], &w[1]),
                (LogHealth::Degraded(_), LogHealth::Recovered { .. }) | (LogHealth::Recovered { .. }, LogHealth::Degraded(_))
            )),
            "{h:?}"
        );
    }

    #[test]
    fn a_closed_log_reports_nothing_and_a_late_hook_hears_the_current_state() {
        let dir = tempfile::tempdir().unwrap();
        let log = open_in(dir.path());
        log.inject_write_failure(true);
        log.append(None, err("a")).unwrap();
        eventually("degraded", || log.degraded().is_some());
        let hooks = health_hook(&log);
        eventually("told on set", || hooks.lock().len() == 1);
        assert!(matches!(&hooks.lock()[0], LogHealth::Degraded(_)));
        log.close();
        log.inject_write_failure(false);
        assert_eq!(hooks.lock().len(), 1);
    }

    #[test]
    fn nothing_is_reported_after_close_returns() {
        let dir = tempfile::tempdir().unwrap();
        for _ in 0..20 {
            let log = open_in(dir.path());
            let hooks = health_hook(&log);
            log.inject_write_failure(true);
            log.append(None, err("a")).unwrap();
            log.close();
            let at_close = hooks.lock().len();
            std::thread::sleep(Duration::from_millis(20));
            assert_eq!(hooks.lock().len(), at_close, "the hook thread emitted after close");
        }
    }

    #[test]
    fn only_events_with_a_seq_count_as_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let log = open_in(dir.path());
        let hooks = health_hook(&log);
        log.inject_write_failure(true);
        log.append(None, err("a")).unwrap();
        eventually("degraded", || log.degraded().is_some());
        log.health.fail("refused".into(), false);
        log.health.fail("refused".into(), false);
        log.inject_write_failure(false);
        log.append(None, err("b")).unwrap();
        eventually("recovered", || hooks.lock().len() == 2);
        assert_eq!(hooks.lock()[1], LogHealth::Recovered { dropped: 1 });
    }
}
