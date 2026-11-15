//! The one way the core runs an external program to completion (git, gh, tar, lsof, npm, ...).
//! Every call has a timeout, kills the child and its process group on timeout or drop, reads no
//! stdin unless given some, and caps what it captures. Agent processes, the Terminal PTY and the
//! MCP shim are not run through here.

use std::ffi::{OsStr, OsString};
use std::path::PathBuf;
use std::process::{ExitStatus, Stdio};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

/// A read-only local query (`git status`, `lsof`, `open`).
pub const LOCAL: Duration = Duration::from_secs(30);
/// Background or opportunistic network work (a fetch that refreshes a base ref, a `gh` query).
pub const NETWORK: Duration = Duration::from_secs(60);
/// User-initiated git that may run hooks or scale with the repository (`commit`, `push`, `checkout`, `add -A`, ...).
pub const GIT_LONG: Duration = Duration::from_secs(600);
/// `gh` calls that push, check out or wait (`pr create`, `pr merge`, `pr checkout`).
pub const GH_LONG: Duration = Duration::from_secs(300);
/// Unpacking a downloaded archive.
pub const UNPACK: Duration = Duration::from_secs(300);
/// `npm install` / `uv tool install`: download and build.
pub const INSTALL: Duration = Duration::from_secs(900);

/// Default capture limit per stream.
const MAX_OUTPUT: usize = 128 * 1024 * 1024;
/// stderr is only ever shown in error messages: always truncated, never an error.
const MAX_STDERR: usize = 1024 * 1024;

/// What to run and how. `Opts::new(timeout)` then the builder methods.
#[derive(Debug, Clone)]
pub struct Opts {
    args: Vec<OsString>,
    cwd: Option<PathBuf>,
    env: Vec<(OsString, OsString)>,
    input: Option<Vec<u8>>,
    timeout: Duration,
    max_output: usize,
    truncate: bool,
}

impl Opts {
    pub fn new(timeout: Duration) -> Self {
        Self { args: vec![], cwd: None, env: vec![], input: None, timeout, max_output: MAX_OUTPUT, truncate: false }
    }
    pub fn arg(mut self, a: impl AsRef<OsStr>) -> Self {
        self.args.push(a.as_ref().to_owned());
        self
    }
    pub fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.args.extend(args.into_iter().map(|a| a.as_ref().to_owned()));
        self
    }
    pub fn cwd(mut self, dir: impl Into<PathBuf>) -> Self {
        self.cwd = Some(dir.into());
        self
    }
    pub fn env(mut self, k: impl AsRef<OsStr>, v: impl AsRef<OsStr>) -> Self {
        self.env.push((k.as_ref().to_owned(), v.as_ref().to_owned()));
        self
    }
    /// Bytes written to stdin (then closed). Without this stdin is null.
    #[cfg_attr(not(test), expect(dead_code, reason = "no caller feeds stdin yet"))]
    pub fn input(mut self, bytes: Vec<u8>) -> Self {
        self.input = Some(bytes);
        self
    }
    /// stdout limit in bytes; more than this is `ProcError::TooLarge` unless `truncate`.
    pub fn max_output(mut self, n: usize) -> Self {
        self.max_output = n;
        self
    }
    /// Keep the first `max_output` bytes of stdout and flag `Output::truncated` instead of failing.
    pub fn truncate(mut self) -> Self {
        self.truncate = true;
        self
    }
}

#[derive(Debug)]
pub struct Output {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    /// stdout was cut at the limit (only with `Opts::truncate`).
    #[cfg_attr(not(test), expect(dead_code, reason = "the callers that truncate do not need the flag"))]
    pub truncated: bool,
}

impl Output {
    pub fn success(&self) -> bool {
        self.status.success()
    }
    pub fn stdout_lossy(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
    pub fn stderr_lossy(&self) -> String {
        String::from_utf8_lossy(&self.stderr).into_owned()
    }
}

/// Why a run did not produce an `Output`. A non-zero exit is not an error here: see `Output::status`.
#[derive(Debug)]
pub enum ProcError {
    Spawn { program: String, source: std::io::Error },
    Timeout { program: String, after: Duration },
    TooLarge { program: String, limit: usize },
    Io { program: String, source: std::io::Error },
}

impl std::fmt::Display for ProcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Spawn { program, source } => write!(f, "could not run {program}: {source}"),
            Self::Timeout { program, after } => write!(f, "{program} timed out after {}s", after.as_secs()),
            Self::TooLarge { program, limit } => write!(f, "{program} printed more than {limit} bytes"),
            Self::Io { program, source } => write!(f, "{program}: {source}"),
        }
    }
}

impl std::error::Error for ProcError {}

/// Kills the child's whole process group unless disarmed (the future was dropped or timed out).
struct GroupGuard(Option<i32>);

impl GroupGuard {
    fn kill(&mut self) {
        if let Some(pgid) = self.0.take() {
            // The group we created with `process_group(0)`; already gone is fine.
            let _ = nix::sys::signal::killpg(nix::unistd::Pid::from_raw(pgid), nix::sys::signal::Signal::SIGKILL);
        }
    }
}

impl Drop for GroupGuard {
    fn drop(&mut self) {
        self.kill();
    }
}

enum Stop {
    TooLarge,
}

/// What a pipe has delivered so far, and whether bytes past the cap were dropped.
#[derive(Default)]
struct Acc {
    buf: Vec<u8>,
    cut: bool,
}

/// After the process exits, how long a grandchild that still holds the pipes open may keep them.
const PIPE_GRACE: Duration = Duration::from_secs(2);

/// Reads `r` to the end into `acc`, keeping at most `cap` bytes. Past the cap it either stops with
/// `TooLarge` or keeps draining (so the child never blocks on a full pipe) and flags the cut.
async fn read_capped<R: AsyncRead + Unpin>(mut r: R, cap: usize, truncate: bool, acc: &mut Acc) -> Result<(), Stop> {
    // On the heap: a stack array would bloat every caller's future.
    let mut chunk = vec![0u8; 16 * 1024];
    loop {
        let n = match r.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        let room = cap.saturating_sub(acc.buf.len());
        if n > room {
            if !truncate {
                return Err(Stop::TooLarge);
            }
            acc.cut = true;
        }
        acc.buf.extend_from_slice(&chunk[..n.min(room)]);
    }
    Ok(())
}

/// Runs `program` to completion. Same env as the parent plus `opts.env`.
pub async fn run(program: impl AsRef<OsStr>, opts: Opts) -> Result<Output, ProcError> {
    let name = program.as_ref().to_string_lossy().into_owned();
    let label = || name.clone();
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(&opts.args).envs(opts.env.iter().map(|(k, v)| (k, v)));
    if let Some(d) = &opts.cwd {
        cmd.current_dir(d);
    }
    cmd.stdin(if opts.input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        // Its own group, so a timeout also reaches what it spawned (hooks, credential helpers).
        .process_group(0);
    let mut child = cmd.spawn().map_err(|source| ProcError::Spawn { program: label(), source })?;
    let mut guard = GroupGuard(child.id().map(|p| p as i32));
    let (stdin, stdout, stderr) = (child.stdin.take(), child.stdout.take().expect("piped"), child.stderr.take().expect("piped"));
    let input = opts.input.clone();
    let write = async move {
        if let (Some(mut w), Some(bytes)) = (stdin, input) {
            let _ = w.write_all(&bytes).await;
        }
        Ok::<_, Stop>(())
    };
    let (mut out, mut err) = (Acc::default(), Acc::default());
    let work = async {
        let io = async {
            tokio::try_join!(write, read_capped(stdout, opts.max_output, opts.truncate, &mut out), read_capped(stderr, MAX_STDERR, true, &mut err)).map(|_| ())
        };
        tokio::pin!(io);
        let status = tokio::select! {
            r = &mut io => {
                r?;
                child.wait().await
            }
            status = child.wait() => {
                // The process is done; a grandchild may hold its pipes open for good. What was read is the answer.
                if let Ok(Err(stop)) = tokio::time::timeout(PIPE_GRACE, &mut io).await {
                    return Err(stop);
                }
                status
            }
        };
        Ok::<_, Stop>(status.map_err(|_| Stop::TooLarge).ok())
    };
    let result = tokio::time::timeout(opts.timeout, work).await;
    match result {
        Ok(Ok(Some(status))) => {
            guard.0 = None;
            Ok(Output { status, stdout: out.buf, stderr: err.buf, truncated: out.cut })
        }
        Ok(Ok(None)) => {
            guard.kill();
            Err(ProcError::Io { program: label(), source: std::io::Error::other("wait failed") })
        }
        Ok(Err(Stop::TooLarge)) => {
            guard.kill();
            let _ = child.wait().await;
            Err(ProcError::TooLarge { program: label(), limit: opts.max_output })
        }
        Err(_) => {
            guard.kill();
            let _ = child.wait().await;
            Err(ProcError::Timeout { program: label(), after: opts.timeout })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sh(script: &str, opts: Opts) -> Opts {
        opts.args(["-c", script])
    }

    fn alive(pid: i32) -> bool {
        nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None).is_ok()
    }

    #[tokio::test]
    async fn a_grandchild_holding_the_pipes_does_not_hold_up_a_finished_process() {
        let started = std::time::Instant::now();
        let out = run("sh", sh("sleep 6 & echo done", Opts::new(Duration::from_secs(60)))).await.unwrap();
        assert_eq!(out.stdout_lossy(), "done\n");
        assert!(out.success());
        assert!(started.elapsed() < Duration::from_secs(5), "took {:?}", started.elapsed());
    }

    #[tokio::test]
    async fn captures_output_and_status() {
        let out = run("sh", sh("echo hi; echo err >&2; exit 3", Opts::new(LOCAL))).await.unwrap();
        assert_eq!(out.stdout_lossy(), "hi\n");
        assert_eq!(out.stderr_lossy(), "err\n");
        assert_eq!(out.status.code(), Some(3));
        assert!(!out.success());
    }

    #[tokio::test]
    async fn timeout_is_distinct_and_kills_the_group() {
        let dir = tempfile::tempdir().unwrap();
        let pidfile = dir.path().join("pid");
        let script = format!("sleep 30 & echo $! > '{}'; wait", pidfile.display());
        let err = run("sh", sh(&script, Opts::new(Duration::from_millis(500)))).await.unwrap_err();
        assert!(matches!(err, ProcError::Timeout { .. }), "{err}");
        let pid: i32 = std::fs::read_to_string(&pidfile).unwrap().trim().parse().unwrap();
        for _ in 0..50 {
            if !alive(pid) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("grandchild {pid} survived the timeout");
    }

    #[tokio::test]
    async fn dropping_the_future_kills_the_group() {
        let dir = tempfile::tempdir().unwrap();
        let pidfile = dir.path().join("pid");
        let script = format!("sleep 30 & echo $! > '{}'; wait", pidfile.display());
        let fut = run("sh", sh(&script, Opts::new(LOCAL)));
        let _ = tokio::time::timeout(Duration::from_millis(500), fut).await;
        let pid: i32 = std::fs::read_to_string(&pidfile).unwrap().trim().parse().unwrap();
        for _ in 0..50 {
            if !alive(pid) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("grandchild {pid} survived the drop");
    }

    #[tokio::test]
    async fn output_over_the_cap_is_an_error_or_truncated() {
        let script = "yes | head -c 100000";
        let err = run("sh", sh(script, Opts::new(LOCAL).max_output(1000))).await.unwrap_err();
        assert!(matches!(err, ProcError::TooLarge { limit: 1000, .. }), "{err}");
        let out = run("sh", sh(script, Opts::new(LOCAL).max_output(1000).truncate())).await.unwrap();
        assert_eq!(out.stdout.len(), 1000);
        assert!(out.truncated && out.success());
    }

    #[tokio::test]
    async fn stdin_is_null_unless_given() {
        let out = run("cat", Opts::new(LOCAL)).await.unwrap();
        assert!(out.success() && out.stdout.is_empty());
        let out = run("cat", Opts::new(LOCAL).input(b"abc".to_vec())).await.unwrap();
        assert_eq!(out.stdout, b"abc");
    }

    #[tokio::test]
    async fn env_cwd_and_spawn_errors() {
        let dir = tempfile::tempdir().unwrap();
        let out = run("sh", sh("printf %s \"$X:$(pwd -P)\"", Opts::new(LOCAL).env("X", "1").cwd(dir.path()))).await.unwrap();
        assert_eq!(out.stdout_lossy(), format!("1:{}", dir.path().canonicalize().unwrap().display()));
        let err = run("harness-no-such-program", Opts::new(LOCAL)).await.unwrap_err();
        assert!(matches!(err, ProcError::Spawn { .. }), "{err}");
    }

    /// Only the allowlisted files may spawn a process (see the module docs); everything else goes
    /// through `run` so it has a timeout.
    #[test]
    fn no_command_new_outside_the_allowlist() {
        // env.rs: login-shell probe on a std thread with its own timeout. terminal.rs: the PTY and its pid helpers.
        const ALLOWED: [&str; 3] = ["proc.rs", "env.rs", "terminal.rs"];
        fn walk(dir: &std::path::Path, out: &mut Vec<PathBuf>) {
            for e in std::fs::read_dir(dir).unwrap().flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, out);
                } else if p.extension().is_some_and(|x| x == "rs") {
                    out.push(p);
                }
            }
        }
        let mut files = vec![];
        walk(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src"), &mut files);
        let mut bad = vec![];
        for f in files {
            if ALLOWED.contains(&f.file_name().unwrap().to_str().unwrap()) {
                continue;
            }
            let text = std::fs::read_to_string(&f).unwrap();
            // Unit tests sit at the end of a file and may call git directly.
            let code = text.split("#[cfg(test)]").next().unwrap();
            if code.contains("Command::new(") || code.contains("process::Command") {
                bad.push(f.display().to_string());
            }
            // HTTP goes through `crate::http`, never a `curl` subprocess.
            if code.contains(concat!("\"cur", "l\"")) {
                bad.push(format!("{}: runs curl, use crate::http", f.display()));
            }
        }
        assert!(bad.is_empty(), "spawn through crate::proc::run instead: {bad:?}");
    }
}
