//! Background jobs: shell commands an Agent left running after their tool call finished
//! (`ToolCallUpdate.background_job`). The Agent sends no ACP signal when such a job ends, so the
//! Harness watches the job's output file: while the job runs, its shell and children hold the
//! file open as stdout/stderr. Once `lsof` finds no process with it open, the job has ended and
//! `BackgroundJobEnded` is logged.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use tokio::task::AbortHandle;

use crate::api::{BackgroundJob, EventKind, ThreadId};
use crate::session::Session;

const POLL: Duration = Duration::from_secs(3);
/// Stop watching after this long; the job is then left as running until the Agent stops.
const GIVE_UP: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Default)]
struct State {
    /// Shutdown: no watcher starts any more.
    closed: bool,
    /// Output files watched now, so a repeated update does not start a second watcher.
    watching: HashMap<String, AbortHandle>,
}

/// A Session's job watchers. They end with the job, `stop_all` (the Session is deleted or archived)
/// or `close` (the Harness shuts down).
#[derive(Clone, Default)]
pub struct JobWatchers(Arc<Mutex<State>>, Arc<std::sync::atomic::AtomicUsize>);

/// Counts a watcher task while it exists, however it ends (also when aborted).
struct Running(Arc<std::sync::atomic::AtomicUsize>);

impl Drop for Running {
    fn drop(&mut self) {
        self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

impl JobWatchers {
    pub(crate) fn stop_all(&self) {
        for (_, h) in self.0.lock().watching.drain() {
            h.abort();
        }
    }

    /// Stops every watcher and refuses new ones.
    pub(crate) fn close(&self) {
        self.0.lock().closed = true;
        self.stop_all();
    }

    /// Watcher tasks that have not ended yet.
    pub(crate) fn len(&self) -> usize {
        self.1.load(std::sync::atomic::Ordering::SeqCst)
    }
}

/// Starts watching `job` (needs a tokio runtime; without one, e.g. in sync tests, does nothing).
pub(super) fn watch(session: &Arc<Session>, thread: Option<ThreadId>, job: BackgroundJob) {
    let Ok(rt) = tokio::runtime::Handle::try_current() else { return };
    let watchers = session.job_watchers().clone();
    // Held across the spawn: the task removes its entry under this lock, so it never runs before the insert.
    let mut state = watchers.0.lock();
    if state.closed || state.watching.contains_key(&job.output_file) {
        return;
    }
    let session = Arc::downgrade(session);
    let file = job.output_file.clone();
    let done = watchers.clone();
    watchers.1.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let running = Running(watchers.1.clone());
    let handle = rt.spawn(async move {
        let _running = running;
        let started = tokio::time::Instant::now();
        let ended = loop {
            if !is_open(&job.output_file).await {
                break true;
            }
            if started.elapsed() >= GIVE_UP {
                break false;
            }
            tokio::time::sleep(POLL).await;
        };
        done.0.lock().watching.remove(&job.output_file);
        if ended && let Some(s) = session.upgrade() {
            let _ = s.log().append(thread, EventKind::BackgroundJobEnded { job_id: job.id });
        }
    });
    state.watching.insert(file, handle.abort_handle());
}

/// Whether any process has `file` open. A missing file or a failed `lsof` counts as not open.
async fn is_open(file: &str) -> bool {
    let opts = crate::proc::Opts::new(crate::proc::LOCAL).arg("--").arg(file).max_output(1024 * 1024).truncate();
    crate::proc::run("lsof", opts).await.is_ok_and(|o| o.success() && !o.stdout.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn open_while_a_process_writes_it() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("job.output");
        let path = file.to_str().unwrap().to_owned();
        let mut child = std::process::Command::new("sh").arg("-c").arg(format!("exec sleep 30 > '{path}'")).spawn().unwrap();
        // Wait until the shell has opened the file.
        for _ in 0..50 {
            if is_open(&path).await {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(is_open(&path).await);
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(!is_open(&path).await);
        assert!(!is_open("/nonexistent/x.output").await);
    }
}
