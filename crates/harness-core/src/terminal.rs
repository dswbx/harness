//! The user's Terminal per Session (ADR 0017): a PTY running the login shell in the Workspace Folder.
//! Output is a live byte stream to attached Frontends, not Session Log events: it is large, and
//! it is the user's, not something the Agent did. A replay buffer lets a reloaded view redraw.
//!
//! Speed: a reader thread feeds a flush thread that coalesces bursts into one message, and the
//! flush thread stops while Frontends have more than `HIGH_WATER` unacknowledged bytes, which
//! blocks the reader and so the program writing (`yes`, `cat big.log`) instead of the UI.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::mpsc::{Receiver, SyncSender};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize};

use crate::api::SessionId;

/// What attached Frontends receive.
pub enum TerminalOutput<'a> {
    /// Sent once on attach (may be empty): earlier output for a new view to redraw. It contains
    /// the shell's old terminal queries; a view must not answer them, or the answers reach the
    /// shell as typed input.
    Replay(&'a [u8]),
    Data(&'a [u8]),
    /// The shell ended; the next attach starts a new one.
    Exit(Option<u32>),
}

/// Returns `false` to detach.
pub type TerminalSink = Box<dyn Fn(TerminalOutput) -> bool + Send + Sync>;

/// Bytes kept for a view that attaches later.
const REPLAY: usize = 512 * 1024;
/// Unacknowledged bytes before output pauses.
const HIGH_WATER: usize = 1024 * 1024;
/// A Frontend that stops acknowledging (closed mid-write) stalls output at most this long.
const ACK_TIMEOUT: Duration = Duration::from_secs(2);
/// Minimum time between messages while output streams.
const COALESCE: Duration = Duration::from_millis(4);
const MAX_MESSAGE: usize = 256 * 1024;

#[derive(Default, Clone)]
pub struct Terminals {
    map: Arc<Mutex<HashMap<SessionId, Arc<Terminal>>>>,
}

impl Terminals {
    /// Attaches to the Session's Terminal, starting a shell in `folder` if none runs. The sink
    /// first gets `Replay`, then live output.
    pub fn attach(&self, session_id: &str, folder: &Path, cols: u16, rows: u16, sink: TerminalSink) -> anyhow::Result<u64> {
        let term = {
            let mut map = self.map.lock().unwrap();
            match map.get(session_id) {
                Some(t) => t.clone(),
                None => {
                    let t = self.spawn(session_id, shell(folder), cols, rows)?;
                    map.insert(session_id.to_owned(), t.clone());
                    t
                }
            }
        };
        term.resize(cols, rows)?;
        Ok(term.attach(sink))
    }

    pub fn detach(&self, session_id: &str, id: u64) {
        if let Some(t) = self.get(session_id) {
            t.detach(id);
        }
    }

    pub fn input(&self, session_id: &str, data: &[u8]) -> anyhow::Result<()> {
        let t = self.get(session_id).ok_or_else(|| anyhow::anyhow!("no terminal for {session_id}"))?;
        let mut w = t.writer.lock().unwrap();
        w.write_all(data)?;
        w.flush()?;
        Ok(())
    }

    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> anyhow::Result<()> {
        match self.get(session_id) {
            Some(t) => t.resize(cols, rows),
            None => Ok(()),
        }
    }

    /// A Frontend has drawn `bytes` of output.
    pub fn ack(&self, session_id: &str, bytes: usize) {
        if let Some(t) = self.get(session_id) {
            let mut n = t.unacked.0.lock().unwrap();
            *n = n.saturating_sub(bytes);
            t.unacked.1.notify_all();
        }
    }

    pub fn kill(&self, session_id: &str) {
        if let Some(t) = self.map.lock().unwrap().remove(session_id) {
            let _ = t.killer.lock().unwrap().kill();
        }
    }

    fn get(&self, session_id: &str) -> Option<Arc<Terminal>> {
        self.map.lock().unwrap().get(session_id).cloned()
    }

    fn spawn(&self, session_id: &str, cmd: CommandBuilder, cols: u16, rows: u16) -> anyhow::Result<Arc<Terminal>> {
        let pair = portable_pty::native_pty_system().openpty(size(cols, rows))?;
        let mut child = pair.slave.spawn_command(cmd)?;
        drop(pair.slave);
        let reader = pair.master.try_clone_reader()?;
        let term = Arc::new(Terminal {
            writer: Mutex::new(pair.master.take_writer()?),
            master: Mutex::new(pair.master),
            killer: Mutex::new(child.clone_killer()),
            out: Default::default(),
            unacked: Default::default(),
        });
        // Bounded, so a paused flush thread blocks the reader and the PTY fills up.
        let (tx, rx) = std::sync::mpsc::sync_channel(16);
        std::thread::spawn(move || read_loop(reader, tx));
        let (t, map, id) = (term.clone(), self.map.clone(), session_id.to_owned());
        std::thread::spawn(move || {
            t.flush_loop(rx);
            let code = child.wait().ok().map(|s| s.exit_code());
            {
                let mut map = map.lock().unwrap();
                if map.get(&id).is_some_and(|x| Arc::ptr_eq(x, &t)) {
                    map.remove(&id);
                }
            }
            let mut out = t.out.lock().unwrap();
            for (_, s) in out.sinks.drain(..) {
                s(TerminalOutput::Exit(code));
            }
        });
        Ok(term)
    }
}

/// The user's login shell, with the login-shell PATH and without host `CLAUDE*` vars.
fn shell(folder: &Path) -> CommandBuilder {
    let mut cmd = CommandBuilder::new_default_prog();
    cmd.cwd(folder);
    for k in crate::agent_quirks::stripped_env() {
        cmd.env_remove(k);
    }
    cmd.env("PATH", crate::env::login_path());
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "Harness");
    // A GUI-launched app has no locale; shells then mangle UTF-8.
    if std::env::var_os("LANG").is_none() {
        cmd.env("LANG", "en_US.UTF-8");
    }
    cmd
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 }
}

fn read_loop(mut reader: Box<dyn Read + Send>, tx: SyncSender<Vec<u8>>) {
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => return,
            Ok(n) => {
                if tx.send(buf[..n].to_vec()).is_err() {
                    return;
                }
            }
        }
    }
}

#[derive(Default)]
struct Out {
    sinks: Vec<(u64, TerminalSink)>,
    replay: Vec<u8>,
}

struct Terminal {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    out: Mutex<Out>,
    unacked: (Mutex<usize>, Condvar),
}

impl Terminal {
    fn attach(&self, sink: TerminalSink) -> u64 {
        // Unique across shells: a detach for a killed shell must not hit its successor.
        static NEXT_ID: AtomicU64 = AtomicU64::new(1);
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let mut out = self.out.lock().unwrap();
        if sink(TerminalOutput::Replay(&out.replay)) {
            out.sinks.push((id, sink));
        }
        id
    }

    fn detach(&self, id: u64) {
        let mut out = self.out.lock().unwrap();
        out.sinks.retain(|(i, _)| *i != id);
        if out.sinks.is_empty() {
            *self.unacked.0.lock().unwrap() = 0;
            self.unacked.1.notify_all();
        }
    }

    fn resize(&self, cols: u16, rows: u16) -> anyhow::Result<()> {
        self.master.lock().unwrap().resize(size(cols, rows))
    }

    fn flush_loop(&self, rx: Receiver<Vec<u8>>) {
        let mut last = Instant::now() - COALESCE;
        while let Ok(mut msg) = rx.recv() {
            // After a quiet spell (typing) output goes out at once; a stream sends at most every `COALESCE`.
            let deadline = last + COALESCE;
            while msg.len() < MAX_MESSAGE {
                let left = deadline.saturating_duration_since(Instant::now());
                let next = if left.is_zero() { rx.try_recv().ok() } else { rx.recv_timeout(left).ok() };
                let Some(c) = next else { break };
                msg.extend_from_slice(&c);
            }
            self.wait_for_acks();
            self.emit(&msg);
            last = Instant::now();
        }
    }

    fn wait_for_acks(&self) {
        let start = Instant::now();
        let mut n = self.unacked.0.lock().unwrap();
        while *n > HIGH_WATER {
            let left = ACK_TIMEOUT.saturating_sub(start.elapsed());
            if left.is_zero() {
                *n = 0;
                return;
            }
            n = self.unacked.1.wait_timeout(n, left).unwrap().0;
        }
    }

    fn emit(&self, data: &[u8]) {
        let mut out = self.out.lock().unwrap();
        out.replay.extend_from_slice(data);
        if out.replay.len() > REPLAY {
            let cut = out.replay.len() - REPLAY;
            out.replay.drain(..cut);
        }
        out.sinks.retain(|(_, s)| s(TerminalOutput::Data(data)));
        if !out.sinks.is_empty() {
            *self.unacked.0.lock().unwrap() += data.len();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn collect(terms: &Terminals, id: &str, cmd: CommandBuilder) -> mpsc::Receiver<Result<Vec<u8>, Option<u32>>> {
        let t = terms.spawn(id, cmd, 80, 24).unwrap();
        terms.map.lock().unwrap().insert(id.to_owned(), t.clone());
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        t.attach(Box::new(move |o| {
            let msg = match o {
                TerminalOutput::Replay(d) | TerminalOutput::Data(d) => Ok(d.to_vec()),
                TerminalOutput::Exit(c) => Err(c),
            };
            tx.lock().unwrap().send(msg).is_ok()
        }));
        rx
    }

    fn drain(rx: mpsc::Receiver<Result<Vec<u8>, Option<u32>>>) -> (String, Option<u32>) {
        let mut text = Vec::new();
        loop {
            match rx.recv_timeout(Duration::from_secs(10)).expect("terminal output") {
                Ok(d) => text.extend(d),
                Err(code) => return (String::from_utf8_lossy(&text).into_owned(), code),
            }
        }
    }

    #[test]
    fn runs_and_reports_exit() {
        let terms = Terminals::default();
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args(["-c", "echo hello-pty; exit 3"]);
        let (text, code) = drain(collect(&terms, "s1", cmd));
        assert!(text.contains("hello-pty"), "{text:?}");
        assert_eq!(code, Some(3));
        assert!(terms.get("s1").is_none(), "an exited terminal is forgotten");
    }

    #[test]
    fn input_reaches_the_program() {
        let terms = Terminals::default();
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args(["-c", "read x; echo got-$x"]);
        let rx = collect(&terms, "s2", cmd);
        terms.input("s2", b"abc\n").unwrap();
        let (text, code) = drain(rx);
        assert!(text.contains("got-abc"), "{text:?}");
        assert_eq!(code, Some(0));
    }

    #[test]
    fn a_later_view_gets_earlier_output_as_replay_first() {
        let terms = Terminals::default();
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args(["-c", "echo before-attach; read x"]);
        let first = collect(&terms, "s4", cmd);
        // The first view gets an empty replay, then the output.
        let mut seen = Vec::new();
        while !String::from_utf8_lossy(&seen).contains("before-attach") {
            seen.extend(first.recv_timeout(Duration::from_secs(10)).unwrap().unwrap());
        }
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        terms.get("s4").unwrap().attach(Box::new(move |o| {
            let tag = match o {
                TerminalOutput::Replay(d) => format!("replay:{}", String::from_utf8_lossy(d)),
                TerminalOutput::Data(d) => format!("data:{}", String::from_utf8_lossy(d)),
                TerminalOutput::Exit(_) => "exit".into(),
            };
            tx.lock().unwrap().send(tag).is_ok()
        }));
        let msg = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(msg.starts_with("replay:") && msg.contains("before-attach"), "{msg:?}");
        terms.kill("s4");
    }

    #[test]
    fn large_output_arrives_whole_and_coalesced() {
        let terms = Terminals::default();
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args(["-c", "i=0; while [ $i -lt 20000 ]; do echo line-$i; i=$((i+1)); done"]);
        let rx = collect(&terms, "s3", cmd);
        let mut msgs = 0;
        let mut text = Vec::new();
        while let Ok(Ok(d)) = rx.recv_timeout(Duration::from_secs(10)) {
            msgs += 1;
            text.extend(d);
            terms.ack("s3", text.len());
        }
        let text = String::from_utf8_lossy(&text);
        assert!(text.contains("line-19999"));
        assert!(msgs < 2000, "{msgs} messages for {} bytes", text.len());
    }
}
