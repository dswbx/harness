//! Session Log: append-only JSONL in the Session Directory, plus live fan-out to subscribed Views.
//!
//! Appends and subscriptions are serialized under one lock, so a subscriber replaying from any
//! `seq` switches to live delivery without gaps or duplicates.
//!
//! Message and thought chunks are coalesced: a chunk is held for up to `COALESCE` (its `seq`
//! already reserved) and later chunks of the same kind and Thread are appended to it. Any other
//! append, a subscribe, a read or a sync flushes it first, so ordering is unchanged. Agents that
//! stream token by token would otherwise write one event per token.

use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::api::{Event, EventKind, EventSink, EVENT_SCHEMA_VERSION, SessionId, ThreadId};

pub type SubscriptionId = u64;

/// How long a chunk may wait for the next one.
const COALESCE: Duration = Duration::from_millis(50);

pub struct SessionLog {
    session_id: SessionId,
    path: PathBuf,
    inner: Arc<Mutex<Inner>>,
}

struct Inner {
    file: File,
    next_seq: u64,
    next_sub: SubscriptionId,
    subscribers: Vec<(SubscriptionId, Box<dyn EventSink>)>,
    /// A chunk not yet written; its `seq` is `next_seq`.
    pending: Option<Event>,
}

impl Inner {
    fn write(&mut self, event: &Event) -> anyhow::Result<()> {
        let mut line = serde_json::to_vec(event)?;
        line.push(b'\n');
        self.file.write_all(&line)?;
        self.next_seq = event.seq + 1;
        self.subscribers.retain(|(_, sink)| sink.send(event));
        Ok(())
    }

    fn flush(&mut self) -> anyhow::Result<()> {
        match self.pending.take() {
            Some(e) => self.write(&e),
            None => Ok(()),
        }
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
    /// Opens (or creates) the log at `path`, truncating a torn trailing line.
    pub fn open(session_id: SessionId, path: &Path) -> anyhow::Result<Self> {
        let mut next_seq = 0;
        let mut valid_len = 0u64;
        if path.exists() {
            let mut reader = BufReader::new(File::open(path)?);
            let mut line = String::new();
            loop {
                line.clear();
                let n = reader.read_line(&mut line)?;
                if n == 0 || !line.ends_with('\n') {
                    break;
                }
                match serde_json::from_str::<Event>(&line) {
                    Ok(ev) => {
                        next_seq = ev.seq + 1;
                        valid_len += n as u64;
                    }
                    Err(_) => break,
                }
            }
        }
        let file = OpenOptions::new().create(true).truncate(false).read(true).write(true).open(path)?;
        file.set_len(valid_len)?;
        // Append mode: every write lands at the current end, so a second writer on the same file
        // (another Harness on the same data dir) can't leave a gap of zero bytes or overwrite lines.
        let file = OpenOptions::new().append(true).open(path)?;
        Ok(Self {
            session_id,
            path: path.to_owned(),
            inner: Arc::new(Mutex::new(Inner { file, next_seq, next_sub: 1, subscribers: Vec::new(), pending: None })),
        })
    }

    pub fn append(&self, thread_id: Option<ThreadId>, kind: EventKind) -> anyhow::Result<Event> {
        let mut inner = self.inner.lock().unwrap();
        if let Some(p) = inner.pending.as_mut()
            && merge_chunk(p, &thread_id, &kind)
        {
            return Ok(p.clone());
        }
        inner.flush()?;
        let event = Event {
            v: EVENT_SCHEMA_VERSION,
            seq: inner.next_seq,
            session_id: self.session_id.clone(),
            thread_id,
            ts_ms: now_ms(),
            kind,
        };
        let chunk = matches!(event.kind, EventKind::AgentMessageChunk { .. } | EventKind::AgentThoughtChunk { .. });
        match tokio::runtime::Handle::try_current() {
            Ok(rt) if chunk => {
                inner.pending = Some(event.clone());
                let weak = Arc::downgrade(&self.inner);
                let seq = event.seq;
                rt.spawn(async move {
                    tokio::time::sleep(COALESCE).await;
                    if let Some(inner) = weak.upgrade() {
                        let mut inner = inner.lock().unwrap();
                        if inner.pending.as_ref().is_some_and(|p| p.seq == seq) {
                            let _ = inner.flush();
                        }
                    }
                });
            }
            _ => inner.write(&event)?,
        }
        Ok(event)
    }

    /// Flushes to disk; called at Turn end and on permission events.
    pub fn sync(&self) -> anyhow::Result<()> {
        let mut inner = self.inner.lock().unwrap();
        inner.flush()?;
        inner.file.sync_data()?;
        Ok(())
    }

    /// Replays events with `seq >= from_seq`, then delivers live events until unsubscribed.
    pub fn subscribe(&self, from_seq: u64, sink: Box<dyn EventSink>) -> anyhow::Result<SubscriptionId> {
        let mut inner = self.inner.lock().unwrap();
        inner.flush()?;
        inner.file.flush()?;
        for event in read_events(&self.path)? {
            if event.seq >= from_seq && !sink.send(&event) {
                return Ok(0);
            }
        }
        let id = inner.next_sub;
        inner.next_sub += 1;
        inner.subscribers.push((id, sink));
        Ok(id)
    }

    pub fn unsubscribe(&self, id: SubscriptionId) {
        self.inner.lock().unwrap().subscribers.retain(|(sid, _)| *sid != id);
    }

    /// Live subscribers, i.e. open Views.
    pub fn subscriber_count(&self) -> usize {
        self.inner.lock().unwrap().subscribers.len()
    }

    pub fn events(&self) -> anyhow::Result<Vec<Event>> {
        let mut inner = self.inner.lock().unwrap();
        inner.flush()?;
        read_events(&self.path)
    }
}

impl Drop for SessionLog {
    fn drop(&mut self) {
        let _ = self.inner.lock().unwrap().flush();
    }
}

/// Complete lines only: a line another writer is still writing (no trailing newline) is skipped.
fn read_events(path: &Path) -> anyhow::Result<Vec<Event>> {
    let mut reader = BufReader::new(File::open(path)?);
    let mut out = Vec::new();
    let mut line = String::new();
    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 || !line.ends_with('\n') {
            break;
        }
        if !line.trim().is_empty() {
            out.push(serde_json::from_str(&line)?);
        }
    }
    Ok(out)
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex as StdMutex};

    fn collector() -> (Box<dyn EventSink>, Arc<StdMutex<Vec<u64>>>) {
        let seen = Arc::new(StdMutex::new(Vec::new()));
        let s = seen.clone();
        (Box::new(move |e: &Event| {
            s.lock().unwrap().push(e.seq);
            true
        }), seen)
    }

    fn msg(t: &str) -> EventKind {
        EventKind::AgentMessageChunk { text: t.into() }
    }

    #[test]
    fn replay_then_live_without_gaps() {
        let dir = tempfile::tempdir().unwrap();
        let log = SessionLog::open("s".into(), &dir.path().join("log.jsonl")).unwrap();
        for i in 0..5 {
            log.append(None, msg(&i.to_string())).unwrap();
        }
        let (sink, seen) = collector();
        log.subscribe(2, sink).unwrap();
        log.append(None, msg("x")).unwrap();
        assert_eq!(*seen.lock().unwrap(), vec![2, 3, 4, 5]);
    }

    #[test]
    fn reopen_continues_seq_and_drops_torn_line() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("log.jsonl");
        {
            let log = SessionLog::open("s".into(), &path).unwrap();
            log.append(None, msg("a")).unwrap();
            log.append(None, msg("b")).unwrap();
        }
        std::fs::OpenOptions::new().append(true).open(&path).unwrap().write_all(b"{\"v\":1,\"se").unwrap();
        let log = SessionLog::open("s".into(), &path).unwrap();
        let ev = log.append(None, msg("c")).unwrap();
        assert_eq!(ev.seq, 2);
        assert_eq!(log.events().unwrap().len(), 3);
    }

    /// Two logs on one file (a second Harness on the same data dir): the second one trims a torn
    /// line while the first keeps writing. No zero-byte gap, no overwritten line.
    #[test]
    fn a_second_writer_never_corrupts_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("log.jsonl");
        let first = SessionLog::open("s".into(), &path).unwrap();
        first.append(None, msg("a")).unwrap();
        std::fs::OpenOptions::new().append(true).open(&path).unwrap().write_all(b"{\"v\":1,\"se").unwrap();
        let second = SessionLog::open("s".into(), &path).unwrap();
        first.append(None, msg("b")).unwrap();
        second.append(None, msg("c")).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert!(!bytes.contains(&0), "no zero-byte gap");
        assert_eq!(second.events().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn chunks_coalesce_until_something_else_happens() {
        let dir = tempfile::tempdir().unwrap();
        let log = SessionLog::open("s".into(), &dir.path().join("log.jsonl")).unwrap();
        let (sink, seen) = collector();
        log.subscribe(0, sink).unwrap();
        for t in ["Hel", "lo", " world"] {
            log.append(Some("t".into()), msg(t)).unwrap();
        }
        assert!(seen.lock().unwrap().is_empty(), "held back");
        log.append(Some("u".into()), msg("other thread")).unwrap();
        log.append(None, EventKind::Error { message: "x".into() }).unwrap();
        let events = log.events().unwrap();
        let texts: Vec<String> = events.iter().map(|e| serde_json::to_value(&e.kind).unwrap()["text"].as_str().unwrap_or("-").to_owned()).collect();
        assert_eq!(texts, vec!["Hello world", "other thread", "-"]);
        assert_eq!(events.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![0, 1, 2]);

        // A lone chunk is flushed by the timer.
        log.append(None, msg("tail")).unwrap();
        tokio::time::sleep(COALESCE * 3).await;
        assert_eq!(*seen.lock().unwrap(), vec![0, 1, 2, 3]);
    }

    #[test]
    fn closed_sink_is_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let log = SessionLog::open("s".into(), &dir.path().join("log.jsonl")).unwrap();
        log.subscribe(0, Box::new(|_: &Event| false)).unwrap();
        log.append(None, msg("a")).unwrap();
        assert!(log.inner.lock().unwrap().subscribers.is_empty());
    }
}
