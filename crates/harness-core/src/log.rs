//! Session Log: append-only JSONL in the Session Directory, plus live fan-out to subscribed Views.
//!
//! **Never lose history.** The file is only ever appended to, with one exception: a torn final
//! line (no trailing newline) is cut on open. A complete line that does not parse is kept, after
//! a one-time copy of the file to `log.jsonl.corrupt-<ts_ms>`; it reads as `EventKind::Unknown`
//! (the original text stays in the file only; a type this build does not know is not counted as a bad line) or, when it is not even JSON, is left out of the
//! in-memory view. An Event with a `v` newer than this build knows opens the Session read-only.
//! Old shapes are read through `upcast` (ADR 0021).
//!
//! **Memory.** Events load into memory on first need (`events`, `subscribe`, a projection), not
//! on open. After that reads never touch the file. Small projections (current mode per Thread,
//! the Agent's title) are kept up to date on append for hot paths.
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

use crate::api::{EVENT_SCHEMA_VERSION, Event, EventKind, EventSink, ProcessState, SessionId, ThreadId};

pub type SubscriptionId = u64;

/// How long a chunk may wait for the next one.
const COALESCE: Duration = Duration::from_millis(50);

/// Events a subscriber may fall behind by before it is dropped with `Lagged`.
const QUEUE_CAP: usize = 4096;

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
    options.as_array()?.iter().find(|o| is_mode_option(o)).and_then(|o| o["currentValue"].as_str()).map(str::to_owned)
}

/// Facts derived from the Events, kept current on append.
#[derive(Default)]
struct Projections {
    /// Thread -> its current Agent mode: the newest of its `ModeChanged` events and the mode
    /// option in its `ConfigOptionsChanged` events (Agents without legacy modes only report the latter).
    modes: HashMap<ThreadId, String>,
    /// Thread (None: Session level) -> (seq, newest non-blank title from `SessionInfoUpdated`).
    titles: HashMap<Option<ThreadId>, (u64, String)>,
}

impl Projections {
    fn apply(&mut self, e: &Event) {
        match &e.kind {
            EventKind::ModeChanged { mode_id } => {
                if let Some(t) = &e.thread_id {
                    self.modes.insert(t.clone(), mode_id.clone());
                }
            }
            EventKind::ConfigOptionsChanged { options } => {
                if let (Some(t), Some(mode)) = (&e.thread_id, config_mode(options)) {
                    self.modes.insert(t.clone(), mode);
                }
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

enum Job {
    Write(Arc<Event>),
    /// Answers with the bytes written so far, after `fsync` when asked.
    Sync {
        fsync: bool,
        reply: Sender<Result<u64, String>>,
    },
}

/// The only owner of the log's file handle. Lines are written in the order they were queued.
struct Writer {
    tx: Sender<Job>,
    handle: Option<std::thread::JoinHandle<()>>,
    error: Arc<Mutex<Option<String>>>,
}

impl Writer {
    fn spawn(path: PathBuf, start_len: u64) -> anyhow::Result<Self> {
        let (tx, rx) = mpsc::channel::<Job>();
        let error = Arc::new(Mutex::new(None));
        let err = error.clone();
        let handle = std::thread::Builder::new().name("session-log-writer".into()).spawn(move || write_loop(&path, start_len, &rx, &err))?;
        Ok(Self { tx, handle: Some(handle), error })
    }

    fn check(&self) -> anyhow::Result<()> {
        match self.error.lock().as_ref() {
            Some(e) => Err(anyhow::anyhow!("writing the Session Log failed: {e}")),
            None => Ok(()),
        }
    }

    fn write(&self, ev: Arc<Event>) -> anyhow::Result<()> {
        self.check()?;
        self.tx.send(Job::Write(ev)).map_err(|_| anyhow::anyhow!("the Session Log writer stopped"))
    }

    /// Waits until everything queued so far is written (and synced when `fsync`); returns the file length.
    fn barrier(&self, fsync: bool) -> anyhow::Result<u64> {
        let (reply, rx) = mpsc::channel();
        self.tx.send(Job::Sync { fsync, reply }).map_err(|_| anyhow::anyhow!("the Session Log writer stopped"))?;
        rx.recv().map_err(|_| anyhow::anyhow!("the Session Log writer stopped"))?.map_err(|e| anyhow::anyhow!("writing the Session Log failed: {e}"))
    }
}

fn write_loop(path: &Path, start_len: u64, rx: &Receiver<Job>, error: &Mutex<Option<String>>) {
    let mut file: Option<File> = None;
    let mut len = start_len;
    for job in rx {
        match job {
            Job::Write(ev) => {
                if error.lock().is_some() {
                    continue;
                }
                let result = (|| -> anyhow::Result<()> {
                    if file.is_none() {
                        // Append mode: every write lands at the current end.
                        file = Some(OpenOptions::new().create(true).append(true).open(path)?);
                    }
                    let mut line = serde_json::to_vec(&*ev)?;
                    line.push(b'\n');
                    if let Some(f) = file.as_mut() {
                        f.write_all(&line)?;
                    }
                    len += line.len() as u64;
                    Ok(())
                })();
                if let Err(e) = result {
                    *error.lock() = Some(format!("{e:#}"));
                }
            }
            Job::Sync { fsync, reply } => {
                let answer = match error.lock().clone() {
                    Some(e) => Err(e),
                    None => match (&file, fsync) {
                        (Some(f), true) => f.sync_data().map(|()| len).map_err(|e| e.to_string()),
                        _ => Ok(len),
                    },
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
    /// `ts_ms` of the last Event (0 when empty); kept in memory, read for `SessionSummary.updated_ms`.
    last_ts_ms: AtomicI64,
    /// When opened, the log's last process state said an Agent was running.
    agent_was_running: bool,
    /// Why appends are refused (the file holds Events from a newer build).
    read_only: Option<String>,
    /// `byte_len` of the checkpoint on disk; held while writing one.
    checkpointed_len: Mutex<Option<u64>>,
}

struct Inner {
    path: PathBuf,
    /// File length when opened, then kept by the writer.
    start_len: u64,
    writer: Option<Writer>,
    next_seq: u64,
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
}

impl Inner {
    fn writer(&mut self) -> anyhow::Result<&Writer> {
        anyhow::ensure!(!self.closed, "the Session Log is closed");
        if self.writer.is_none() {
            self.writer = Some(Writer::spawn(self.path.clone(), self.start_len)?);
        }
        self.writer.as_ref().ok_or_else(|| anyhow::anyhow!("no writer"))
    }

    /// Hands the Event to memory, the writer and the subscribers. Never waits for a sink or the disk.
    fn write(&mut self, event: Event) -> anyhow::Result<()> {
        let ev = Arc::new(event);
        self.writer()?.write(ev.clone())?;
        self.next_seq = ev.seq + 1;
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
        Ok(())
    }
}

/// Appends `text` to `pending` when both are chunks of the same kind and Thread.
fn merge_chunk(pending: &mut Event, thread_id: &Option<ThreadId>, kind: &EventKind) -> bool {
    if pending.thread_id != *thread_id {
        return false;
    }
    match (&mut pending.kind, kind) {
        (EventKind::AgentMessageChunk { text: a }, EventKind::AgentMessageChunk { text: b })
        | (EventKind::AgentThoughtChunk { text: a }, EventKind::AgentThoughtChunk { text: b }) => {
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
        let mut last_ts_ms = 0;
        let mut running = false;
        let mut offset = 0;
        if let Some(cp) = &checkpoint {
            next_seq = cp.next_seq;
            last_ts_ms = cp.last_ts_ms;
            running = cp.agent_was_running;
            offset = cp.byte_len;
        }
        let scan = scan_lines(path, offset, |ev| {
            next_seq = ev.seq + 1;
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
        Ok(Self {
            session_id,
            path: path.to_owned(),
            inner: Arc::new(Mutex::new(Inner {
                path: path.to_owned(),
                start_len,
                writer: None,
                next_seq,
                running,
                events: None,
                proj: Projections::default(),
                next_sub: 1,
                subscribers: Vec::new(),
                pending: None,
                closed: false,
            })),
            checkpointed_len: Mutex::new(checkpoint.map(|c| c.byte_len)),
            last_ts_ms: AtomicI64::new(last_ts_ms),
            agent_was_running: running,
            read_only,
        })
    }

    fn writable(&self) -> anyhow::Result<()> {
        match &self.read_only {
            Some(reason) => anyhow::bail!("{reason}"),
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
        if !self.agent_was_running {
            return Ok(());
        }
        self.writable()?;
        let mut inner = self.inner.lock();
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

    pub fn append(&self, thread_id: Option<ThreadId>, kind: EventKind) -> anyhow::Result<Event> {
        self.writable()?;
        let mut inner = self.inner.lock();
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

    /// Flushes to disk and writes the checkpoint; called at Turn end and on permission events.
    pub fn sync(&self) -> anyhow::Result<()> {
        let (writer_tx_reply, cp) = {
            let mut inner = self.inner.lock();
            inner.flush()?;
            let cp =
                Checkpoint { next_seq: inner.next_seq, last_ts_ms: self.last_ts_ms.load(Ordering::Relaxed), agent_was_running: inner.running, byte_len: 0 };
            // Queued under the lock: the answer covers exactly the Events counted in `cp`.
            let (reply, rx) = mpsc::channel();
            let w = inner.writer()?;
            w.check()?;
            w.tx.send(Job::Sync { fsync: true, reply }).map_err(|_| anyhow::anyhow!("the Session Log writer stopped"))?;
            (rx, cp)
        };
        let byte_len = writer_tx_reply
            .recv()
            .map_err(|_| anyhow::anyhow!("the Session Log writer stopped"))?
            .map_err(|e| anyhow::anyhow!("writing the Session Log failed: {e}"))?;
        // One writer at a time, and never an older checkpoint over a newer one.
        let mut written = self.checkpointed_len.lock();
        if written.is_none_or(|w| w < byte_len) {
            crate::fsutil::write_atomic(&checkpoint_path(&self.path), &serde_json::to_vec(&Checkpoint { byte_len, ..cp })?)?;
            *written = Some(byte_len);
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

    pub fn unsubscribe(&self, id: SubscriptionId) {
        let mut inner = self.inner.lock();
        for s in inner.subscribers.iter().filter(|s| s.id == id) {
            s.state.dead.store(true, Ordering::Relaxed);
        }
        inner.subscribers.retain(|s| s.id != id);
    }

    /// `seq` of the newest Event, 0 for an empty log. Flushes a held chunk, so subscribers have
    /// been handed this `seq` when the call returns.
    pub fn last_seq(&self) -> anyhow::Result<u64> {
        let mut inner = self.inner.lock();
        inner.flush()?;
        Ok(inner.next_seq.saturating_sub(1))
    }

    /// Time of the last appended Event, None for an empty log.
    pub fn last_ts_ms(&self) -> Option<i64> {
        Some(self.last_ts_ms.load(Ordering::Relaxed)).filter(|&t| t > 0)
    }

    /// Live subscribers, i.e. open Views.
    pub fn subscriber_count(&self) -> usize {
        self.inner.lock().subscribers.iter().filter(|s| !s.state.dead.load(Ordering::Relaxed)).count()
    }

    /// All Events, from memory (loaded from the file the first time). Prefer a projection on hot paths.
    pub fn events(&self) -> anyhow::Result<Vec<Event>> {
        let mut inner = self.inner.lock();
        inner.flush()?;
        inner.ensure_loaded()?;
        Ok(inner.events.as_deref().unwrap_or_default().iter().map(|e| (**e).clone()).collect())
    }

    /// The Thread's current Agent mode: the newest `ModeChanged`, or the mode option of the
    /// newest `ConfigOptionsChanged` that has one. Projection, no scan.
    pub fn thread_mode(&self, thread: &ThreadId) -> anyhow::Result<Option<String>> {
        let mut inner = self.inner.lock();
        inner.flush()?;
        inner.ensure_loaded()?;
        Ok(inner.proj.modes.get(thread).cloned())
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
        EventKind::AgentMessageChunk { text: t.into() }
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
        log.append(Some("t".into()), EventKind::ModeChanged { mode_id: "plan".into() }).unwrap();
        log.append(Some("t".into()), EventKind::ConfigOptionsChanged { options: serde_json::json!([{"id":"mode","currentValue":"auto"}]) }).unwrap();
        log.append(Some("u".into()), EventKind::ModeChanged { mode_id: "x".into() }).unwrap();
        log.append(Some("t".into()), EventKind::ConfigOptionsChanged { options: serde_json::json!([{"id":"model","currentValue":"m"}]) }).unwrap();
        log.append(None, EventKind::SessionInfoUpdated { title: Some("  ".into()) }).unwrap();
        log.append(Some("t".into()), EventKind::SessionInfoUpdated { title: Some("Hello".into()) }).unwrap();
        assert_eq!(log.events().unwrap().len(), 6);
        std::fs::remove_file(&path).unwrap();
        assert_eq!(log.thread_mode(&"t".into()).unwrap().as_deref(), Some("auto"));
        assert_eq!(log.thread_mode(&"u".into()).unwrap().as_deref(), Some("x"));
        assert_eq!(log.thread_mode(&"v".into()).unwrap(), None);
        assert_eq!(log.agent_title(&"t".into()).unwrap().as_deref(), Some("Hello"));
        log.append(Some("t".into()), EventKind::ModeChanged { mode_id: "plan".into() }).unwrap();
        assert_eq!(log.thread_mode(&"t".into()).unwrap().as_deref(), Some("plan"));
        assert_eq!(log.events().unwrap().len(), 7);
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
}
