//! One JSON settings/state file in the data dir. A missing file is not an error. A file that does
//! not load is moved aside (never lost, never blocks startup) and reads as missing: not valid JSON
//! to `<name>.corrupt-<ts_ms>`, valid JSON of another shape (a newer build wrote it) to
//! `<name>.unreadable-<ts_ms>`; a taken name is never replaced. Each case is recorded as a
//! `Problem` the host hands to the user (`take_problems`). When the move fails the file stays and
//! is never overwritten this run. Writes are atomic (`fsutil::write_atomic`); saves and
//! move-asides share one lock, so a load never moves a file that was saved in between. The
//! Session Log has its own, append-only version of this (`log.rs`).

use std::marker::PhantomData;
use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::api::{NoticeKind, StartupNotice};

/// A file that did not load.
#[derive(Debug, Clone)]
pub struct Problem {
    pub file: PathBuf,
    pub kind: NoticeKind,
    /// Where the file went; `None` when it could not be moved and stays in place.
    pub copy: Option<PathBuf>,
    pub error: String,
}

impl std::fmt::Display for Problem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.copy {
            Some(c) => write!(f, "{} did not load ({}); moved to {}, starting with defaults", self.file.display(), self.error, c.display()),
            None => write!(f, "{} did not load ({}) and could not be moved aside; left as is, starting with defaults", self.file.display(), self.error),
        }
    }
}

impl Problem {
    pub fn notice(&self) -> StartupNotice {
        let name = file_name(&self.file);
        let what = match name.as_str() {
            "permissions.json" => "Permission rules were reset".to_owned(),
            "agents.json" => "Installed Agents were reset".to_owned(),
            "agent-config.json" => "Agent settings were reset".to_owned(),
            "mcp.json" => "MCP servers were reset".to_owned(),
            "editor.json" => "The editor setting was reset".to_owned(),
            "appearance.json" => "Appearance settings were reset".to_owned(),
            "themes.json" => "Imported themes were reset".to_owned(),
            "overlay.json" => "Quick overlay settings were reset".to_owned(),
            "worktree_dir.json" => "The Worktree folder setting was reset".to_owned(),
            _ => format!("{name} was reset"),
        };
        let why = match self.kind {
            NoticeKind::Corrupt => format!("{name} is not valid JSON."),
            NoticeKind::Unreadable => format!("{name} could not be read. It may have been written by a newer version of Harness."),
        };
        let kept = match &self.copy {
            Some(c) => format!("The file is kept as {}.", c.display()),
            None => "The file could not be moved aside, so it stays where it is and will not be overwritten while Harness runs.".to_owned(),
        };
        StartupNotice {
            file: name,
            kind: self.kind.clone(),
            path: self.file.to_string_lossy().into_owned(),
            copy: self.copy.as_ref().map(|c| c.to_string_lossy().into_owned()),
            message: format!("{what}. {why} {kept}"),
        }
    }
}

fn file_name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

struct Registry {
    pending: Vec<Problem>,
    /// Files that could not be moved aside: saving would destroy them.
    held: Vec<PathBuf>,
}

static REGISTRY: Mutex<Registry> = Mutex::new(Registry { pending: Vec::new(), held: Vec::new() });
/// Held by saves and move-asides.
static IO: Mutex<()> = Mutex::new(());

/// Takes the problems found so far in files directly inside `dir`.
pub fn take_problems(dir: &Path) -> Vec<Problem> {
    let mut r = REGISTRY.lock();
    let (mine, rest) = std::mem::take(&mut r.pending).into_iter().partition(|p| p.file.parent() == Some(dir));
    r.pending = rest;
    mine
}

/// Whether `take_problems(dir)` would return something.
pub fn has_problems(dir: &Path) -> bool {
    REGISTRY.lock().pending.iter().any(|p| p.file.parent() == Some(dir))
}

/// What `JsonFile::load` found.
#[derive(Debug)]
pub struct Loaded<T> {
    /// `None` when the file is missing or did not load.
    pub value: Option<T>,
    pub problem: Option<Problem>,
}

pub struct JsonFile<T> {
    path: PathBuf,
    _t: PhantomData<fn() -> T>,
}

impl<T: Serialize + DeserializeOwned> JsonFile<T> {
    pub fn new(path: PathBuf) -> Self {
        Self { path, _t: PhantomData }
    }

    pub fn in_dir(dir: &Path, name: &str) -> Self {
        Self::new(dir.join(name))
    }

    fn parse(bytes: &[u8]) -> Result<T, (NoticeKind, String)> {
        let json: serde_json::Value = serde_json::from_slice(bytes).map_err(|e| (NoticeKind::Corrupt, e.to_string()))?;
        serde_json::from_value(json).map_err(|e| (NoticeKind::Unreadable, e.to_string()))
    }

    fn read(&self) -> std::io::Result<Option<Vec<u8>>> {
        match std::fs::read(&self.path) {
            Ok(b) => Ok(Some(b)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Errors only on an I/O failure reading the file (not on a file that does not load).
    pub fn load(&self) -> anyhow::Result<Loaded<T>> {
        self.load_with(|| {})
    }

    /// `between` runs after the first read and before the move-aside (tests make a save happen there).
    fn load_with(&self, between: impl FnOnce()) -> anyhow::Result<Loaded<T>> {
        let missing = || Loaded { value: None, problem: None };
        let Some(bytes) = self.read()? else {
            REGISTRY.lock().held.retain(|p| p != &self.path);
            return Ok(missing());
        };
        if let Ok(v) = Self::parse(&bytes) {
            REGISTRY.lock().held.retain(|p| p != &self.path);
            return Ok(Loaded { value: Some(v), problem: None });
        }
        between();
        let _io = IO.lock();
        // Look again under the lock: a save may have replaced the file, or another load moved it.
        let Some(bytes) = self.read()? else { return Ok(missing()) };
        let (kind, error) = match Self::parse(&bytes) {
            Ok(v) => return Ok(Loaded { value: Some(v), problem: None }),
            Err(e) => e,
        };
        let name = file_name(&self.path);
        let suffix = match kind {
            NoticeKind::Corrupt => "corrupt",
            NoticeKind::Unreadable => "unreadable",
        };
        let ts = crate::log::now_ms();
        let mut copy = self.path.with_file_name(format!("{name}.{suffix}-{ts}"));
        for n in 1.. {
            if copy.symlink_metadata().is_err() {
                break;
            }
            copy = self.path.with_file_name(format!("{name}.{suffix}-{ts}-{n}"));
        }
        let (copy, error) = match std::fs::rename(&self.path, &copy) {
            Ok(()) => (Some(copy), error),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(missing()),
            Err(e) => (None, format!("{error}; moving it aside failed: {e}")),
        };
        let problem = Problem { file: self.path.clone(), kind, copy, error };
        let mut r = REGISTRY.lock();
        if problem.copy.is_none() && r.held.contains(&self.path) {
            // Reported on an earlier load already.
            return Ok(Loaded { value: None, problem: Some(problem) });
        }
        if problem.copy.is_none() {
            r.held.push(self.path.clone());
        }
        r.pending.push(problem.clone());
        Ok(Loaded { value: None, problem: Some(problem) })
    }

    /// The value, `T::default()` when missing or not loading (logged, reported). For startup loads.
    pub fn load_or_default(&self) -> anyhow::Result<T>
    where
        T: Default,
    {
        let loaded = self.load()?;
        if let Some(p) = &loaded.problem {
            tracing::warn!("{p}");
        }
        Ok(loaded.value.unwrap_or_default())
    }

    /// The value, `None` when missing, not loading or unreadable (logged unless missing).
    pub fn load_logged(&self) -> Option<T> {
        match self.load() {
            Ok(l) => {
                if let Some(p) = &l.problem {
                    tracing::warn!("{p}");
                }
                l.value
            }
            Err(e) => {
                tracing::warn!("reading {}: {e:#}", self.path.display());
                None
            }
        }
    }

    /// Refused for a file that could not be moved aside: it holds what the user had.
    pub fn save(&self, value: &T) -> anyhow::Result<()> {
        let bytes = serde_json::to_vec_pretty(value)?;
        let _io = IO.lock();
        self.ensure_not_held()?;
        crate::fsutil::write_atomic(&self.path, &bytes)
    }

    fn ensure_not_held(&self) -> anyhow::Result<()> {
        anyhow::ensure!(
            !REGISTRY.lock().held.contains(&self.path),
            "{} could not be read and could not be moved aside; not overwriting it (fix or move it, then restart)",
            self.path.display()
        );
        Ok(())
    }

    /// Deletes the file; no error when it is not there. Leaves an unmovable unreadable file alone.
    pub fn remove(&self) {
        let _io = IO.lock();
        if self.ensure_not_held().is_ok() {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn file() -> (tempfile::TempDir, JsonFile<Value>) {
        let d = tempfile::tempdir().unwrap();
        let f = JsonFile::in_dir(d.path(), "x.json");
        (d, f)
    }

    fn names(d: &Path) -> Vec<String> {
        let mut n: Vec<_> = std::fs::read_dir(d).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        n.sort();
        n
    }

    #[test]
    fn missing_is_none_and_touches_nothing() {
        let (d, f) = file();
        let l = f.load().unwrap();
        assert!(l.value.is_none() && l.problem.is_none());
        assert!(names(d.path()).is_empty());
    }

    #[test]
    fn round_trips() {
        let (_d, f) = file();
        f.save(&json!({"a": [1, 2]})).unwrap();
        assert_eq!(f.load().unwrap().value, Some(json!({"a": [1, 2]})));
        f.remove();
        assert!(f.load().unwrap().value.is_none());
    }

    #[test]
    fn invalid_json_is_moved_aside_as_corrupt_with_its_bytes() {
        let (d, f) = file();
        std::fs::write(&f.path, b"{\"a\": ").unwrap();
        let l = f.load().unwrap();
        assert!(l.value.is_none());
        let m = l.problem.unwrap();
        assert_eq!(m.kind, NoticeKind::Corrupt);
        assert_eq!(std::fs::read(m.copy.as_ref().unwrap()).unwrap(), b"{\"a\": ");
        assert!(m.copy.unwrap().file_name().unwrap().to_string_lossy().starts_with("x.json.corrupt-"));
        assert_eq!(names(d.path()).len(), 1);
        // The next load is a clean "missing"; a save works.
        assert!(f.load().unwrap().problem.is_none());
        f.save(&json!(1)).unwrap();
        assert_eq!(f.load().unwrap().value, Some(json!(1)));
        take_problems(d.path());
    }

    #[test]
    fn valid_json_of_another_shape_is_moved_aside_as_unreadable() {
        let d = tempfile::tempdir().unwrap();
        let f: JsonFile<Vec<String>> = JsonFile::in_dir(d.path(), "x.json");
        std::fs::write(&f.path, b"{\"a\":1}").unwrap();
        let p = f.load().unwrap().problem.unwrap();
        assert_eq!(p.kind, NoticeKind::Unreadable);
        assert!(p.copy.unwrap().file_name().unwrap().to_string_lossy().starts_with("x.json.unreadable-"));
        assert!(f.load_or_default().unwrap().is_empty());
        take_problems(d.path());
    }

    #[test]
    fn load_or_default_survives_corruption() {
        let d = tempfile::tempdir().unwrap();
        let f: JsonFile<Vec<String>> = JsonFile::in_dir(d.path(), "x.json");
        std::fs::write(&f.path, [0xff, 0xfe, 0x00]).unwrap();
        assert!(f.load_or_default().unwrap().is_empty());
        assert_eq!(names(d.path()).len(), 1);
        take_problems(d.path());
    }

    #[test]
    fn problems_become_notices_once() {
        let d = tempfile::tempdir().unwrap();
        let f: JsonFile<Vec<String>> = JsonFile::in_dir(d.path(), "permissions.json");
        std::fs::write(&f.path, b"{").unwrap();
        let g: JsonFile<Vec<String>> = JsonFile::in_dir(d.path(), "mcp.json");
        std::fs::write(&g.path, b"{\"a\":1}").unwrap();
        f.load().unwrap();
        g.load().unwrap();
        assert!(has_problems(d.path()));
        let mut n: Vec<_> = take_problems(d.path()).iter().map(Problem::notice).collect();
        n.sort_by(|a, b| a.file.cmp(&b.file));
        assert_eq!(n.len(), 2);
        assert_eq!((n[0].file.as_str(), n[0].kind.clone()), ("mcp.json", NoticeKind::Unreadable));
        assert!(n[0].message.starts_with("MCP servers were reset."), "{}", n[0].message);
        assert!(n[0].message.contains("newer version"));
        assert!(n[0].copy.as_ref().unwrap().contains("mcp.json.unreadable-"));
        assert_eq!((n[1].file.as_str(), n[1].kind.clone()), ("permissions.json", NoticeKind::Corrupt));
        assert!(n[1].message.starts_with("Permission rules were reset. permissions.json is not valid JSON."), "{}", n[1].message);
        assert!(n[1].message.contains(&n[1].copy.clone().unwrap()));
        assert!(!has_problems(d.path()) && take_problems(d.path()).is_empty());
    }

    #[test]
    fn another_dirs_problems_stay_put() {
        let (a, fa) = file();
        let (b, _) = file();
        std::fs::write(&fa.path, b"{").unwrap();
        fa.load().unwrap();
        assert!(!has_problems(b.path()) && take_problems(b.path()).is_empty());
        assert_eq!(take_problems(a.path()).len(), 1);
    }

    #[test]
    fn a_taken_name_is_never_replaced() {
        let (d, f) = file();
        let ts = crate::log::now_ms();
        // Occupy every name this millisecond could pick, and the next few.
        for t in ts..ts + 50 {
            std::fs::write(d.path().join(format!("x.json.corrupt-{t}")), b"old").unwrap();
        }
        std::fs::write(&f.path, b"{").unwrap();
        let m = f.load().unwrap().problem.unwrap().copy.unwrap();
        assert_eq!(std::fs::read(&m).unwrap(), b"{");
        for t in ts..ts + 50 {
            assert_eq!(std::fs::read(d.path().join(format!("x.json.corrupt-{t}"))).unwrap(), b"old");
        }
        take_problems(d.path());
    }

    #[test]
    fn a_valid_file_saved_between_read_and_move_is_kept() {
        let (d, f) = file();
        std::fs::write(&f.path, b"{").unwrap();
        let l = f.load_with(|| f.save(&json!({"fresh": true})).unwrap()).unwrap();
        assert_eq!(l.value, Some(json!({"fresh": true})));
        assert!(l.problem.is_none());
        assert_eq!(names(d.path()), ["x.json"]);
        assert!(!has_problems(d.path()));
    }

    #[test]
    fn a_file_moved_by_another_load_is_not_an_error() {
        let (d, f) = file();
        std::fs::write(&f.path, b"{").unwrap();
        // The other load wins between this one's read and its move.
        let l = f.load_with(|| drop(f.load().unwrap())).unwrap();
        assert!(l.value.is_none() && l.problem.is_none());
        assert_eq!(names(d.path()).len(), 1);
        assert_eq!(take_problems(d.path()).len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn a_move_that_fails_keeps_the_file_reports_it_and_refuses_saves() {
        use std::os::unix::fs::PermissionsExt;
        let (d, f) = file();
        std::fs::write(&f.path, b"{").unwrap();
        std::fs::set_permissions(d.path(), std::fs::Permissions::from_mode(0o555)).unwrap();
        if std::fs::write(d.path().join("probe"), b"").is_ok() {
            return; // running as root: the directory is writable anyway
        }
        let l = f.load().unwrap();
        assert!(l.value.is_none());
        let p = l.problem.unwrap();
        assert!(p.copy.is_none());
        // A second load does not report again.
        f.load().unwrap();
        std::fs::set_permissions(d.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(std::fs::read(&f.path).unwrap(), b"{");
        assert!(f.save(&json!(1)).is_err());
        f.remove();
        assert_eq!(std::fs::read(&f.path).unwrap(), b"{");
        let n: Vec<_> = take_problems(d.path()).iter().map(Problem::notice).collect();
        assert_eq!(n.len(), 1);
        assert!(n[0].copy.is_none() && n[0].message.contains("will not be overwritten"), "{}", n[0].message);
        // Once the file loads (or is gone), saving works again.
        std::fs::remove_file(&f.path).unwrap();
        f.load().unwrap();
        f.save(&json!(2)).unwrap();
    }
}
