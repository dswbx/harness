//! File-backed panels (ADR 0023): Markdown files the Agent writes into its Session's `panels/`
//! folder, shown by `render_ui` items that name them with `source`. Path checks, reads, and the
//! watcher that tells windows a file changed.

use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

/// The folder in the Session Directory.
pub const DIR: &str = "panels";

/// How long the watcher waits for quiet before it reports changed files.
pub const DEBOUNCE: Duration = Duration::from_millis(200);

/// Largest source file the Harness reads.
const MAX_BYTES: u64 = 1_000_000;

/// Where `path` really is (symlinks followed) when that is inside `dir`; `None` otherwise. `path`
/// may not exist yet (a file the Agent is about to write): then its deepest existing ancestor is
/// resolved and the rest appended. `..` is refused, and so is a dangling symlink (a write would
/// follow it out of the folder).
pub fn resolve_inside(dir: &Path, path: &Path) -> Option<PathBuf> {
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return None;
    }
    let real_dir = dir.canonicalize().ok()?;
    let mut existing = path;
    let mut rest = Vec::new();
    while std::fs::symlink_metadata(existing).is_err() {
        rest.push(existing.file_name()?);
        existing = existing.parent()?;
    }
    let mut real = existing.canonicalize().ok()?;
    for part in rest.iter().rev() {
        real.push(part);
    }
    (real != real_dir && real.starts_with(&real_dir)).then_some(real)
}

/// Checks a `source` name: relative to the panels folder, `/` separated, no `..`, ending in `.md`.
pub fn check_name(name: &str) -> anyhow::Result<()> {
    let p = Path::new(name);
    anyhow::ensure!(
        !name.is_empty() && p.components().all(|c| matches!(c, Component::Normal(_))),
        "source {name:?} must be a file name relative to panels_dir, e.g. \"progress.md\" or \"upgrade/progress.md\""
    );
    anyhow::ensure!(name.ends_with(".md"), "source {name:?} must be a Markdown file (.md)");
    Ok(())
}

/// The file a `source` name points to, checked to be inside `dir`.
pub fn source_path(dir: &Path, name: &str) -> anyhow::Result<PathBuf> {
    check_name(name)?;
    resolve_inside(dir, &dir.join(name)).ok_or_else(|| anyhow::anyhow!("source {name:?} is outside panels_dir"))
}

/// A source file's text and a hash of it (sha256, hex).
pub fn read(dir: &Path, name: &str) -> anyhow::Result<(String, String)> {
    use sha2::{Digest, Sha256};
    let path = source_path(dir, name)?;
    let meta = std::fs::metadata(&path).map_err(|_| anyhow::anyhow!("source {name:?} does not exist in panels_dir ({})", dir.display()))?;
    anyhow::ensure!(meta.is_file(), "source {name:?} is not a file");
    anyhow::ensure!(meta.len() <= MAX_BYTES, "source {name:?} is larger than 1 MB");
    let content = std::fs::read_to_string(&path).map_err(|e| anyhow::anyhow!("source {name:?} could not be read: {e}"))?;
    let hash = format!("{:x}", Sha256::digest(content.as_bytes()));
    Ok((content, hash))
}

/// When a source file was last written (ms epoch); `None` when it cannot be read.
pub fn mtime_ms(dir: &Path, name: &str) -> Option<i64> {
    let modified = std::fs::metadata(source_path(dir, name).ok()?).ok()?.modified().ok()?;
    Some(modified.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as i64)
}

/// Watches a panels folder (recursively) while it lives; dropping it stops the watch.
pub struct Watcher {
    _inner: notify::RecommendedWatcher,
}

/// Calls `on_change` with the name of each `.md` file under `dir` that changed, once per burst of
/// writes: after `debounce` without a new change.
pub fn watch(dir: &Path, debounce: Duration, on_change: impl Fn(String) + Send + 'static) -> anyhow::Result<Watcher> {
    use notify::Watcher as _;
    let real_dir = dir.canonicalize()?;
    let dir = dir.to_owned();
    let (tx, rx) = mpsc::channel::<PathBuf>();
    let mut inner = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        if matches!(event.kind, notify::EventKind::Access(_)) {
            return;
        }
        for p in event.paths {
            let _ = tx.send(p);
        }
    })?;
    inner.watch(&real_dir, notify::RecursiveMode::Recursive)?;
    let name_of = move |p: &Path| -> Option<String> {
        let rel = p.strip_prefix(&real_dir).or_else(|_| p.strip_prefix(&dir)).ok()?;
        let name = rel.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
        name.ends_with(".md").then_some(name)
    };
    std::thread::Builder::new().name("panels-watch".into()).spawn(move || {
        // Ends when the watcher (holding the sender) is dropped.
        while let Ok(first) = rx.recv() {
            let mut changed = BTreeSet::new();
            changed.extend(name_of(&first));
            let gone = loop {
                match rx.recv_timeout(debounce) {
                    Ok(p) => changed.extend(name_of(&p)),
                    Err(mpsc::RecvTimeoutError::Timeout) => break false,
                    Err(mpsc::RecvTimeoutError::Disconnected) => break true,
                }
            };
            for name in changed {
                on_change(name);
            }
            if gone {
                break;
            }
        }
    })?;
    Ok(Watcher { _inner: inner })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "tests fail loudly")]
    use super::*;
    use std::sync::{Arc, Mutex};

    #[test]
    fn names_stay_inside_the_folder() {
        let d = tempfile::tempdir().unwrap();
        let panels = d.path().join("panels");
        std::fs::create_dir_all(panels.join("sub")).unwrap();
        std::fs::write(panels.join("a.md"), "a").unwrap();
        std::fs::write(d.path().join("secret.md"), "s").unwrap();
        std::os::unix::fs::symlink(d.path().join("secret.md"), panels.join("link.md")).unwrap();
        std::os::unix::fs::symlink(d.path(), panels.join("out")).unwrap();
        std::os::unix::fs::symlink(d.path().join("new.md"), panels.join("dangling.md")).unwrap();

        assert!(source_path(&panels, "a.md").is_ok());
        assert!(source_path(&panels, "sub/new.md").is_ok(), "a file that does not exist yet");
        assert!(source_path(&panels, "sub/deeper/new.md").is_ok());
        for bad in ["../secret.md", "sub/../../secret.md", "/etc/x.md", "", "a.txt", "./a.md", "link.md", "out/secret.md", "dangling.md"] {
            assert!(source_path(&panels, bad).is_err(), "{bad}");
        }
        assert_eq!(read(&panels, "a.md").unwrap().0, "a");
        assert!(read(&panels, "missing.md").unwrap_err().to_string().contains("does not exist"));
        assert!(resolve_inside(&panels, &panels).is_none(), "the folder itself is not a file in it");
        assert!(resolve_inside(&panels, &d.path().join("secret.md")).is_none());
    }

    #[test]
    fn one_event_per_burst_of_writes() {
        let d = tempfile::tempdir().unwrap();
        let panels = d.path().join("panels");
        std::fs::create_dir_all(panels.join("sub")).unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let s = seen.clone();
        let _w = watch(&panels, DEBOUNCE, move |n| s.lock().unwrap().push(n)).unwrap();
        std::thread::sleep(Duration::from_millis(150));
        for i in 0..3 {
            std::fs::write(panels.join("p.md"), format!("v{i}")).unwrap();
            std::thread::sleep(Duration::from_millis(20));
        }
        std::fs::write(panels.join("notes.txt"), "ignored").unwrap();
        std::thread::sleep(Duration::from_millis(900));
        assert_eq!(*seen.lock().unwrap(), vec!["p.md".to_owned()]);
        std::fs::write(panels.join("sub/q.md"), "q").unwrap();
        std::thread::sleep(Duration::from_millis(900));
        assert_eq!(*seen.lock().unwrap(), vec!["p.md".to_owned(), "sub/q.md".to_owned()]);
    }
}
