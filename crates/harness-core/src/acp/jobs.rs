//! Background jobs: shell commands an Agent left running after their tool call finished
//! (`ToolCallUpdate.background_job`). The Agent sends no ACP signal when such a job ends, so the
//! Harness watches the job's output file: while the job runs, its shell and children hold the
//! file open as stdout/stderr. Once `lsof` finds no process with it open, the job has ended and
//! `BackgroundJobEnded` is logged.

use std::collections::HashSet;
use std::process::Stdio;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use parking_lot::Mutex;

use crate::api::{BackgroundJob, EventKind, ThreadId};
use crate::session::Session;

const POLL: Duration = Duration::from_secs(3);
/// Stop watching after this long; the job is then left as running until the Agent stops.
const GIVE_UP: Duration = Duration::from_secs(24 * 60 * 60);

/// Output files watched now, so a repeated update does not start a second watcher.
static WATCHED: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);

/// Starts watching `job` (needs a tokio runtime; without one, e.g. in sync tests, does nothing).
pub(super) fn watch(session: &Arc<Session>, thread: Option<ThreadId>, job: BackgroundJob) {
    let Ok(rt) = tokio::runtime::Handle::try_current() else { return };
    if !WATCHED.lock().insert(job.output_file.clone()) {
        return;
    }
    let session = Arc::downgrade(session);
    rt.spawn(async move {
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
        WATCHED.lock().remove(&job.output_file);
        if ended && let Some(s) = session.upgrade() {
            let _ = s.log().append(thread, EventKind::BackgroundJobEnded { job_id: job.id });
        }
    });
}

/// Whether any process has `file` open. A missing file or a failed `lsof` counts as not open.
async fn is_open(file: &str) -> bool {
    tokio::process::Command::new("lsof")
        .arg("--")
        .arg(file)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .await
        .is_ok_and(|o| o.status.success() && !o.stdout.is_empty())
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
