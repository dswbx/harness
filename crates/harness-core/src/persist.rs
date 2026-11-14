//! One JSON settings/state file in the data dir. A missing file is not an error; a file that does
//! not parse is moved aside to `<name>.corrupt-<ts_ms>` (never lost, never blocks startup) and
//! reads as missing; writes are atomic (`fsutil::write_atomic`). The Session Log has its own,
//! append-only version of this (`log.rs`).

use std::marker::PhantomData;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde::de::DeserializeOwned;

/// A file that did not parse and was moved aside.
#[derive(Debug, Clone)]
pub struct MovedAside {
    pub file: PathBuf,
    pub copy: PathBuf,
    pub error: String,
}

impl std::fmt::Display for MovedAside {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} is not valid ({}); moved to {}, starting with defaults", self.file.display(), self.error, self.copy.display())
    }
}

/// What `JsonFile::load` found.
#[derive(Debug)]
pub struct Loaded<T> {
    /// `None` when the file is missing or was moved aside.
    pub value: Option<T>,
    pub moved_aside: Option<MovedAside>,
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

    /// Errors only on an I/O failure other than "not found" (or on moving a corrupt file aside).
    pub fn load(&self) -> anyhow::Result<Loaded<T>> {
        let bytes = match std::fs::read(&self.path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Loaded { value: None, moved_aside: None }),
            Err(e) => return Err(e.into()),
        };
        match serde_json::from_slice(&bytes) {
            Ok(v) => Ok(Loaded { value: Some(v), moved_aside: None }),
            Err(e) => {
                let name = self.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                let copy = self.path.with_file_name(format!("{name}.corrupt-{}", crate::log::now_ms()));
                std::fs::rename(&self.path, &copy)?;
                Ok(Loaded { value: None, moved_aside: Some(MovedAside { file: self.path.clone(), copy, error: e.to_string() }) })
            }
        }
    }

    /// The value, `T::default()` when missing or corrupt (logged). For startup loads.
    pub fn load_or_default(&self) -> anyhow::Result<T>
    where
        T: Default,
    {
        let loaded = self.load()?;
        if let Some(m) = &loaded.moved_aside {
            tracing::warn!("{m}");
        }
        Ok(loaded.value.unwrap_or_default())
    }

    /// The value, `None` when missing, corrupt or unreadable (logged unless missing).
    pub fn load_logged(&self) -> Option<T> {
        match self.load() {
            Ok(l) => {
                if let Some(m) = &l.moved_aside {
                    tracing::warn!("{m}");
                }
                l.value
            }
            Err(e) => {
                tracing::warn!("reading {}: {e:#}", self.path.display());
                None
            }
        }
    }

    pub fn save(&self, value: &T) -> anyhow::Result<()> {
        crate::fsutil::write_atomic(&self.path, &serde_json::to_vec_pretty(value)?)
    }

    /// Deletes the file; no error when it is not there.
    pub fn remove(&self) {
        let _ = std::fs::remove_file(&self.path);
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
        assert!(l.value.is_none() && l.moved_aside.is_none());
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
    fn corrupt_is_moved_aside_with_its_bytes() {
        let (d, f) = file();
        std::fs::write(&f.path, b"{\"a\": ").unwrap();
        let l = f.load().unwrap();
        assert!(l.value.is_none());
        let m = l.moved_aside.unwrap();
        assert_eq!(std::fs::read(&m.copy).unwrap(), b"{\"a\": ");
        assert!(m.copy.file_name().unwrap().to_string_lossy().starts_with("x.json.corrupt-"));
        assert_eq!(names(d.path()).len(), 1);
        // The next load is a clean "missing"; a save works.
        assert!(f.load().unwrap().moved_aside.is_none());
        f.save(&json!(1)).unwrap();
        assert_eq!(f.load().unwrap().value, Some(json!(1)));
    }

    #[test]
    fn wrong_shape_counts_as_corrupt() {
        let d = tempfile::tempdir().unwrap();
        let f: JsonFile<Vec<String>> = JsonFile::in_dir(d.path(), "x.json");
        std::fs::write(&f.path, b"{\"a\":1}").unwrap();
        assert!(f.load().unwrap().moved_aside.is_some());
        assert!(f.load_or_default().unwrap().is_empty());
    }

    #[test]
    fn load_or_default_survives_corruption() {
        let d = tempfile::tempdir().unwrap();
        let f: JsonFile<Vec<String>> = JsonFile::in_dir(d.path(), "x.json");
        std::fs::write(&f.path, [0xff, 0xfe, 0x00]).unwrap();
        assert!(f.load_or_default().unwrap().is_empty());
        assert_eq!(names(d.path()).len(), 1);
    }
}
