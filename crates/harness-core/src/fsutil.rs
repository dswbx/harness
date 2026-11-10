//! Durable file writes. A rename alone can survive a power loss as an empty file: the data must be
//! synced before the rename and the directory after it.

use std::fs::File;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

/// Writes `bytes` to `path` atomically: temp file next to it, `fsync`, rename, `fsync` of the
/// directory. A crash leaves the old file or the new one, never a partial one.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let mut name = path.file_name().ok_or_else(|| anyhow::anyhow!("{} has no file name", path.display()))?.to_owned();
    // Unique per call: two writers of one file must not share a temp file.
    name.push(format!(".tmp{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
    let tmp = path.with_file_name(name);
    let mut file = File::create(&tmp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&tmp, path)?;
    sync_dir(crate::env::parent_of(path)?)
}

/// `fsync` of a directory, which makes a rename or a new file in it durable.
pub fn sync_dir(dir: &Path) -> anyhow::Result<()> {
    File::open(dir)?.sync_all()?;
    Ok(())
}

/// Takes the exclusive advisory lock `<dir>/.lock`, held while the returned file lives (the OS
/// drops it with the process). Fails when another process, or another `Harness`, still holds it
/// after `LOCK_WAIT`: two writers on one data directory would interleave Session Logs. The short
/// wait covers a relaunch (an update, a restart) that starts before the old process has exited.
pub fn lock_dir(dir: &Path) -> anyhow::Result<File> {
    lock_dir_within(dir, LOCK_WAIT)
}

const LOCK_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

fn lock_dir_within(dir: &Path, wait: std::time::Duration) -> anyhow::Result<File> {
    let path = dir.join(".lock");
    let file = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(&path)?;
    let deadline = std::time::Instant::now() + wait;
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(file),
            Err(std::fs::TryLockError::WouldBlock) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            Err(std::fs::TryLockError::WouldBlock) => {
                anyhow::bail!("another Harness is using {} (lock {} is held); close it first", dir.display(), path.display())
            }
            Err(std::fs::TryLockError::Error(e)) => return Err(anyhow::Error::new(e).context(format!("locking {}", path.display()))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_data_dir_lock_waits_for_a_holder_that_lets_go() {
        let dir = tempfile::tempdir().unwrap();
        let first = lock_dir(dir.path()).unwrap();
        let release = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(100));
            drop(first);
        });
        lock_dir_within(dir.path(), std::time::Duration::from_secs(5)).unwrap();
        release.join().unwrap();
    }

    #[test]
    fn the_data_dir_lock_is_exclusive_until_released() {
        let dir = tempfile::tempdir().unwrap();
        let first = lock_dir(dir.path()).unwrap();
        let err = lock_dir_within(dir.path(), std::time::Duration::from_millis(50)).unwrap_err().to_string();
        assert!(err.contains("another Harness"), "{err}");
        // Other directories are independent.
        let other = tempfile::tempdir().unwrap();
        lock_dir(other.path()).unwrap();
        drop(first);
        lock_dir(dir.path()).unwrap();
    }

    #[test]
    fn replaces_the_file_and_leaves_no_temp() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.json");
        write_atomic(&path, b"one").unwrap();
        write_atomic(&path, b"two").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"two");
        let names: Vec<_> = std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names, vec![std::ffi::OsString::from("a.json")]);
    }

    #[test]
    fn concurrent_writers_of_one_file_do_not_clash() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.json");
        let threads: Vec<_> = (0..8)
            .map(|i| {
                let p = path.clone();
                std::thread::spawn(move || (0..50).for_each(|n| write_atomic(&p, format!("{i}-{n}").as_bytes()).unwrap()))
            })
            .collect();
        threads.into_iter().for_each(|t| t.join().unwrap());
        assert!(std::fs::read_to_string(&path).unwrap().contains('-'));
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn a_failed_write_keeps_the_old_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.json");
        write_atomic(&path, b"old").unwrap();
        assert!(write_atomic(&dir.path().join("missing/a.json"), b"new").is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"old");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}
