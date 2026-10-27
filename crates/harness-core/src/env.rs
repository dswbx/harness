//! Environment for child processes. A GUI-launched macOS app gets a minimal PATH, so we ask the
//! user's login shell once (see docs/spikes/rmcp-and-env.md). `warm_up` runs it in the background
//! at startup so the first Agent spawn does not wait for slow rc files.

use std::io::Read;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

const FALLBACK_PATH: &str = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
/// rc files can hang (prompts, network); after this the fallback PATH is used.
const TIMEOUT: Duration = Duration::from_secs(10);

pub fn login_path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        read_login_path().unwrap_or_else(|| {
            tracing::warn!("could not read the login-shell PATH; using {FALLBACK_PATH}");
            FALLBACK_PATH.to_owned()
        })
    })
}

/// Resolves `login_path` on a background thread.
pub fn warm_up() {
    std::thread::spawn(|| {
        login_path();
    });
}

fn read_login_path() -> Option<String> {
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/zsh".into());
    // Sentinels guard against rc files printing to stdout.
    let mut child = std::process::Command::new(shell)
        .args(["-ilc", "printf '__HARNESS_BEGIN__%s__HARNESS_END__' \"$PATH\""])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if start.elapsed() < TIMEOUT => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    let begin = out.rfind("__HARNESS_BEGIN__")? + "__HARNESS_BEGIN__".len();
    let end = out[begin..].find("__HARNESS_END__")? + begin;
    let path = out[begin..end].trim();
    (!path.is_empty()).then(|| path.to_owned())
}
