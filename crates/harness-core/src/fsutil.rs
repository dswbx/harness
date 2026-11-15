//! File system helpers: durable writes (a rename alone can survive a power loss as an empty file:
//! the data must be synced before the rename and the directory after it) and the `inside` family,
//! the "is this path inside that folder" checks, one named variant per rule.

use std::fs::File;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
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
    sync_dir(parent_of(path)?)
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

// ---------- "is this path inside that folder" ----------
//
// Every variant is named for its rule. None of them is "the" right one: a call site picks the one
// that matches what it must guarantee. `root` itself counts as inside unless the name says
// `below`. Case is compared as the file system hands it back (no folding).

/// Lexical: `path` is `root` or under it, compared by components. Nothing is read from disk and
/// symlinks are not followed, so `/a/bc` is not inside `/a/b`, a trailing slash does not matter,
/// and `..` is NOT resolved (see `normalize_lexical`; `/a/b/../c` counts as under `/a/b`).
pub fn inside_lexical(root: &Path, path: &Path) -> bool {
    path.starts_with(root)
}

/// Resolves `.` and `..` without touching the disk, so `folder/../x` cannot pass `inside_lexical`
/// as inside `folder`. A `..` above the start is dropped.
pub fn normalize_lexical(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            c => out.push(c),
        }
    }
    out
}

/// `root` and `path` with symlinks resolved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Real {
    pub root: PathBuf,
    pub path: PathBuf,
}

impl Real {
    /// `path` is `root` or under it.
    pub fn within(&self) -> bool {
        self.path.starts_with(&self.root)
    }

    /// `path` is under `root`, not `root` itself.
    pub fn below(&self) -> bool {
        self.within() && self.path != self.root
    }
}

/// Canonicalized, both must exist: errors when `root` or `path` is missing (or a symlink on the
/// way dangles). Symlinks are followed on both sides, so a link inside `root` that points out of
/// it is outside; `..` is resolved by the file system.
pub fn inside_existing(root: &Path, path: &Path) -> std::io::Result<Real> {
    Ok(Real { root: root.canonicalize()?, path: path.canonicalize()? })
}

/// Canonicalized, `path` may not exist yet (a file about to be written): its deepest existing
/// ancestor is resolved and the rest appended. `root` must exist. Returns the real path when it
/// is strictly below `root` (not `root` itself); `None` otherwise. `..` anywhere in `path` is
/// refused outright, and so is a dangling symlink (a write would follow it out of the folder).
pub fn resolve_below_via_ancestor(root: &Path, path: &Path) -> Option<PathBuf> {
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return None;
    }
    let real_root = root.canonicalize().ok()?;
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
    (real != real_root && real.starts_with(&real_root)).then_some(real)
}

/// The real location of an absolute `path`, resolved component by component as the OS would:
/// symbolic links are followed, `..` applies to the real directory reached so far (so `link/..`
/// is the parent of the link's target). The part below the deepest existing component is appended
/// as written. `None` for a relative path, a dangling link or a link loop, an unreadable
/// component, or a `..` after a component that does not exist.
pub fn resolve_physical(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() {
        return None;
    }
    let mut real = PathBuf::new();
    let mut missing = false;
    for c in path.components() {
        match c {
            Component::Prefix(_) | Component::RootDir => real.push(c),
            Component::CurDir => {}
            Component::ParentDir if missing => return None,
            Component::ParentDir => {
                real.pop();
            }
            Component::Normal(name) => {
                real.push(name);
                if missing {
                    continue;
                }
                match std::fs::symlink_metadata(&real) {
                    Ok(m) if m.file_type().is_symlink() => real = real.canonicalize().ok()?,
                    Ok(_) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => missing = true,
                    Err(_) => return None,
                }
            }
        }
    }
    Some(real)
}

/// The parent directory of a path the Harness built itself (always below a data directory).
pub fn parent_of(path: &Path) -> anyhow::Result<&Path> {
    path.parent().ok_or_else(|| anyhow::anyhow!("{} has no parent directory", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_physical_follows_links_and_applies_dotdot_to_the_real_directory() {
        let d = tempfile::tempdir().unwrap();
        let base = d.path().canonicalize().unwrap();
        std::fs::create_dir_all(base.join("a/b")).unwrap();
        std::fs::create_dir_all(base.join("far/deep")).unwrap();
        std::os::unix::fs::symlink(base.join("far/deep"), base.join("a/link")).unwrap();
        std::os::unix::fs::symlink(base.join("loop2"), base.join("loop1")).unwrap();
        std::os::unix::fs::symlink(base.join("loop1"), base.join("loop2")).unwrap();
        std::os::unix::fs::symlink(base.join("nowhere"), base.join("dangling")).unwrap();
        assert_eq!(resolve_physical(&base.join("a/b/../b/x")), Some(base.join("a/b/x")));
        assert_eq!(resolve_physical(&base.join("a/link/../x")), Some(base.join("far/x")));
        assert_eq!(resolve_physical(&base.join("a/link/new/y")), Some(base.join("far/deep/new/y")));
        assert_eq!(resolve_physical(&base.join("a/missing/../x")), None);
        assert_eq!(resolve_physical(&base.join("loop1/x")), None);
        assert_eq!(resolve_physical(&base.join("dangling")), None);
        assert_eq!(resolve_physical(Path::new("rel/x")), None);
    }

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

    /// `<tmp>/b` (the root) with a file, a sub folder, links in and out; `<tmp>/bc` is a sibling
    /// that shares the root's name as a prefix.
    struct Tree {
        _tmp: tempfile::TempDir,
        tmp: PathBuf,
        root: PathBuf,
    }

    fn tree() -> Tree {
        let tmp = tempfile::tempdir().unwrap();
        let t = tmp.path().canonicalize().unwrap();
        let root = t.join("b");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::create_dir_all(t.join("bc")).unwrap();
        std::fs::write(root.join("file"), "").unwrap();
        std::fs::write(root.join("sub/file"), "").unwrap();
        std::fs::write(t.join("bc/file"), "").unwrap();
        std::os::unix::fs::symlink(root.join("sub"), root.join("link_in")).unwrap();
        std::os::unix::fs::symlink(t.join("bc"), root.join("link_out")).unwrap();
        std::os::unix::fs::symlink(t.join("nowhere"), root.join("dangling")).unwrap();
        Tree { _tmp: tmp, tmp: t, root }
    }

    #[test]
    fn inside_lexical_compares_components_only() {
        let t = tree();
        let (r, tmp) = (&t.root, &t.tmp);
        // (path, inside)
        let cases: Vec<(PathBuf, bool)> = vec![
            (r.clone(), true),
            (r.join("file"), true),
            (r.join("missing/leaf"), true),
            (PathBuf::from(format!("{}/", r.display())), true),
            (r.join("file/"), true),
            (tmp.join("bc/file"), false),
            (tmp.join("bc"), false),
            (tmp.clone(), false),
            // Symlinks are not followed: a link out of the root still reads as inside.
            (r.join("link_out/file"), true),
            // `..` is not resolved here (see normalize_lexical).
            (r.join("../bc/file"), true),
            (r.join("sub/../../bc"), true),
        ];
        for (p, want) in cases {
            assert_eq!(inside_lexical(r, &p), want, "{}", p.display());
        }
        // A root given with a trailing slash behaves the same.
        assert!(inside_lexical(Path::new(&format!("{}/", r.display())), &r.join("file")));
        assert!(!inside_lexical(&tmp.join("b/"), &tmp.join("bc")));
    }

    #[test]
    fn normalize_lexical_resolves_dots_without_the_disk() {
        let cases = [("/a/b/../c", "/a/c"), ("/a/./b", "/a/b"), ("/a/b/../../..", "/"), ("/a/b/sub/../../../c", "/c"), ("/a/b/", "/a/b")];
        for (p, want) in cases {
            assert_eq!(normalize_lexical(Path::new(p)), PathBuf::from(want), "{p}");
        }
        let t = tree();
        assert!(!inside_lexical(&t.root, &normalize_lexical(&t.root.join("../bc/file"))));
        assert!(inside_lexical(&t.root, &normalize_lexical(&t.root.join("sub/../file"))));
    }

    #[test]
    fn inside_existing_follows_symlinks_and_needs_both_to_exist() {
        let t = tree();
        let (r, tmp) = (&t.root, &t.tmp);
        // (path, error, within, below)
        let cases: Vec<(PathBuf, bool, bool, bool)> = vec![
            (r.clone(), false, true, false),
            (r.join("file"), false, true, true),
            (r.join("sub"), false, true, true),
            (PathBuf::from(format!("{}/", r.join("sub").display())), false, true, true),
            (r.join("link_in/file"), false, true, true),
            (r.join("link_out"), false, false, false),
            (r.join("link_out/file"), false, false, false),
            (r.join("sub/../file"), false, true, true),
            (r.join("../bc/file"), false, false, false),
            (r.join("sub/../../bc"), false, false, false),
            (tmp.join("bc/file"), false, false, false),
            (tmp.join("bc"), false, false, false),
            (r.join("missing"), true, false, false),
            (r.join("missing/leaf"), true, false, false),
            (r.join("dangling"), true, false, false),
            (r.join("file/under-a-file"), true, false, false),
        ];
        for (p, err, within, below) in cases {
            match inside_existing(r, &p) {
                Err(_) => assert!(err, "{} should exist", p.display()),
                Ok(real) => assert_eq!((err, real.within(), real.below()), (false, within, below), "{}", p.display()),
            }
        }
        assert!(inside_existing(&r.join("missing"), &r.join("file")).is_err(), "a missing root is an error");
        // The root may itself be reached through a link.
        let real = inside_existing(&r.join("link_in"), &r.join("sub/file")).unwrap();
        assert!(real.below());
    }

    #[test]
    fn resolve_below_via_ancestor_allows_a_missing_leaf_but_not_escapes() {
        let t = tree();
        let (r, tmp) = (&t.root, &t.tmp);
        // (path, resolved)
        let cases: Vec<(PathBuf, Option<PathBuf>)> = vec![
            (r.join("file"), Some(r.join("file"))),
            (r.join("sub"), Some(r.join("sub"))),
            (PathBuf::from(format!("{}/", r.join("sub").display())), Some(r.join("sub"))),
            (r.join("link_in/file"), Some(r.join("sub/file"))),
            // Missing leaf and missing parents: the deepest existing ancestor is resolved.
            (r.join("new.md"), Some(r.join("new.md"))),
            (r.join("sub/new/deeper.md"), Some(r.join("sub/new/deeper.md"))),
            (r.join("link_in/new.md"), Some(r.join("sub/new.md"))),
            // The root itself is not a file in it.
            (r.clone(), None),
            (PathBuf::from(format!("{}/", r.display())), None),
            // Out through a link, existing or not.
            (r.join("link_out/file"), None),
            (r.join("link_out/new.md"), None),
            (r.join("link_out"), None),
            // A dangling link is refused: a write would follow it out.
            (r.join("dangling"), None),
            (r.join("dangling/x"), None),
            // `..` is refused outright, even when it stays inside.
            (r.join("sub/../file"), None),
            (r.join("../bc/file"), None),
            // Same-prefix sibling and unrelated paths.
            (tmp.join("bc/file"), None),
            (tmp.join("bc/new"), None),
            (tmp.join("elsewhere/new"), None),
        ];
        for (p, want) in cases {
            assert_eq!(resolve_below_via_ancestor(r, &p), want, "{}", p.display());
        }
        assert_eq!(resolve_below_via_ancestor(&r.join("missing-root"), &r.join("file")), None);
    }
}
