//! Shared Artifacts (ADR 0024): artifacts that live outside any Session, in
//! `<data dir>/shared/<id>/`. Each folder holds `meta.json`, the content (`content.md`,
//! `content.html` or `ui.json`), and optionally `state.json` and `files/` (copied images). The Host
//! keeps an in-memory index of the `meta.json` files, built at startup; there is no catalog.
//! Attachments live in the Session Logs; `meta.attached` is a cache of them.

use parking_lot::{Mutex, RwLock};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use crate::api::{SessionId, SharedArtifactEntry, SharedArtifactMeta, SharedCreator, SharedKind, StatePatchOp};

/// The folder in the data dir.
pub const DIR: &str = "shared";
/// A `render_ui` `source` (or `id`) that names a Shared Artifact: `shared:<id>`.
pub const PREFIX: &str = "shared:";
const META: &str = "meta.json";
const STATE: &str = "state.json";
const META_VERSION: u32 = 1;
/// Most results of a search.
const MAX_RESULTS: usize = 20;

/// The content file of a kind.
pub fn content_name(kind: SharedKind) -> &'static str {
    match kind {
        SharedKind::Md => "content.md",
        SharedKind::Html => "content.html",
        SharedKind::Ui => "ui.json",
    }
}

/// Whether `id` is a valid Shared Artifact id: `^[a-z0-9][a-z0-9-]{0,63}$`.
pub fn is_id(id: &str) -> bool {
    let b = id.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// The artifact id a `shared:<id>` reference names.
pub fn reference(s: &str) -> Option<&str> {
    s.strip_prefix(PREFIX)
}

/// `title` cut to `[a-z0-9-]`, at most 40 characters; `artifact` when nothing is left.
fn slug(title: &str) -> String {
    let mut out = String::new();
    for c in title.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    let out: String = out.trim_end_matches('-').chars().take(40).collect();
    let out = out.trim_end_matches('-');
    if out.is_empty() { "artifact".to_owned() } else { out.to_owned() }
}

/// A new id: `<slug>-<6 hex>`, e.g. `release-q4-checklist-3f9a1c`.
pub fn new_id(title: &str) -> String {
    let hex = uuid::Uuid::new_v4().simple().to_string();
    format!("{}-{}", slug(title), &hex[..6])
}

/// What `SharedArtifacts::read` returns.
pub struct Read {
    pub meta: SharedArtifactMeta,
    pub content: String,
    pub hash: String,
    pub mtime_ms: i64,
    pub state: Value,
    pub dir: PathBuf,
}

pub struct SharedArtifacts {
    dir: PathBuf,
    index: RwLock<BTreeMap<String, SharedArtifactMeta>>,
    watch: Mutex<Option<crate::panels::Watcher>>,
    /// Serializes writes of `meta.json` and `state.json`.
    write_lock: Mutex<()>,
}

impl SharedArtifacts {
    /// Opens `dir` (made when missing) and indexes its artifacts.
    pub fn open(dir: PathBuf) -> anyhow::Result<Self> {
        std::fs::create_dir_all(&dir)?;
        let index = RwLock::new(scan(&dir));
        Ok(Self { dir, index, watch: Default::default(), write_lock: Default::default() })
    }

    /// An artifact's folder; refuses a bad id.
    pub fn folder(&self, id: &str) -> anyhow::Result<PathBuf> {
        if !is_id(id) {
            return Err(crate::error::invalid(format!("{id:?} is not a shared artifact id")));
        }
        Ok(self.dir.join(id))
    }

    /// The artifact's content file (`content.md`, `content.html` or `ui.json`); refuses an unknown id.
    pub fn content_path(&self, id: &str) -> anyhow::Result<PathBuf> {
        let meta = self.get(id)?;
        Ok(self.folder(id)?.join(content_name(meta.kind)))
    }

    pub fn get(&self, id: &str) -> anyhow::Result<SharedArtifactMeta> {
        self.index.read().get(id).cloned().ok_or_else(|| crate::error::not_found(format!("no shared artifact {id:?}")))
    }

    /// All artifacts, most recently updated first; with `query`, the matches (see `Command::ListSharedArtifacts`).
    pub fn list(&self, query: Option<&str>) -> Vec<SharedArtifactEntry> {
        let mut metas: Vec<SharedArtifactMeta> = self.index.read().values().cloned().collect();
        metas.sort_by_key(|m| std::cmp::Reverse(m.updated_ms));
        let Some(q) = query.map(str::trim).filter(|q| !q.is_empty()) else {
            return metas.into_iter().map(|meta| SharedArtifactEntry { meta, snippet: None }).collect();
        };
        let q = q.to_ascii_lowercase();
        let mut hits: Vec<(bool, SharedArtifactEntry)> = Vec::new();
        for meta in metas {
            let content = self.content(&meta).map(|(c, _)| c).unwrap_or_default();
            let in_title = meta.title.to_ascii_lowercase().contains(&q);
            let at = content.to_ascii_lowercase().find(&q);
            if !in_title && at.is_none() {
                continue;
            }
            let snippet = snippet(&content, at.unwrap_or(0), if at.is_some() { q.len() } else { 0 });
            hits.push((in_title, SharedArtifactEntry { meta, snippet }));
        }
        // Stable: within each group the order stays most recently updated first.
        hits.sort_by_key(|(in_title, _)| !*in_title);
        hits.into_iter().take(MAX_RESULTS).map(|(_, e)| e).collect()
    }

    /// The content file's text and hash.
    fn content(&self, meta: &SharedArtifactMeta) -> anyhow::Result<(String, String)> {
        let folder = self.folder(&meta.id)?;
        let path = crate::panels::resolve_inside(&folder, &folder.join(content_name(meta.kind)))
            .ok_or_else(|| anyhow::anyhow!("{} of {} is outside its folder", content_name(meta.kind), meta.id))?;
        crate::panels::read_file(&path).map_err(|e| anyhow::anyhow!("{} of shared artifact {} {e:#}", content_name(meta.kind), meta.id))
    }

    pub fn read(&self, id: &str) -> anyhow::Result<Read> {
        let meta = self.get(id)?;
        let dir = self.folder(id)?;
        let (content, hash) = self.content(&meta)?;
        let mtime_ms = crate::panels::file_mtime_ms(&dir.join(content_name(meta.kind))).unwrap_or(0);
        Ok(Read { state: self.state(id)?, meta, content, hash, mtime_ms, dir })
    }

    /// The artifact's state; `{}` when it has none.
    pub fn state(&self, id: &str) -> anyhow::Result<Value> {
        match std::fs::read(self.folder(id)?.join(STATE)) {
            Ok(b) => Ok(serde_json::from_slice(&b)?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
            Err(e) => Err(e.into()),
        }
    }

    /// Applies `ops` to the artifact's state (all or nothing) and stores it. The caller logs it.
    pub fn patch_state(&self, id: &str, ops: &[StatePatchOp]) -> anyhow::Result<Value> {
        anyhow::ensure!(!ops.is_empty(), "no operations");
        self.get(id)?;
        let _guard = self.write_lock.lock();
        let next = crate::state::apply(&self.state(id)?, ops)?;
        crate::fsutil::write_atomic(&self.folder(id)?.join(STATE), &serde_json::to_vec_pretty(&next)?)?;
        self.touch(id);
        Ok(next)
    }

    /// Makes a new artifact: `fill` writes its content (and state, files) into a new folder, which
    /// then appears whole under its id.
    pub fn create(
        &self,
        title: &str,
        kind: SharedKind,
        created_by: SharedCreator,
        attached: Vec<SessionId>,
        fill: impl FnOnce(&Path) -> anyhow::Result<()>,
    ) -> anyhow::Result<SharedArtifactMeta> {
        let title = title.trim();
        let title = if title.is_empty() { "Untitled" } else { title };
        let id = new_id(title);
        let now = crate::log::now_ms();
        let meta =
            SharedArtifactMeta { v: META_VERSION, id: id.clone(), title: title.to_owned(), kind, created_ms: now, updated_ms: now, created_by, attached };
        let tmp = self.dir.join(format!(".new-{id}"));
        std::fs::create_dir_all(&tmp)?;
        let made = fill(&tmp).and_then(|()| write_meta(&tmp, &meta)).and_then(|()| Ok(std::fs::rename(&tmp, self.folder(&id)?)?));
        if let Err(e) = made {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err(e);
        }
        self.index.write().insert(id, meta.clone());
        Ok(meta)
    }

    /// Replaces a `ui` artifact's tree: `ui.json` becomes `{root, files}`, the images in `images`
    /// (`src` as given, file) copied into `files/`.
    pub fn write_ui(&self, id: &str, root: &Value, images: Vec<(String, PathBuf)>) -> anyhow::Result<()> {
        let meta = self.get(id)?;
        if meta.kind != SharedKind::Ui {
            let msg = format!("shared artifact {id} is a {} file, not a render_ui tree: edit the file instead", content_name(meta.kind));
            return Err(crate::error::invalid(msg));
        }
        let folder = self.folder(id)?;
        let files = crate::frontend_files::store(&folder, images)?;
        crate::fsutil::write_atomic(&folder.join(content_name(SharedKind::Ui)), &serde_json::to_vec_pretty(&json!({ "root": root, "files": files }))?)?;
        self.touch(id);
        Ok(())
    }

    /// Adds or removes `session` in the artifact's `attached` cache.
    pub fn set_attached(&self, id: &str, session: &str, attached: bool) -> anyhow::Result<()> {
        self.update_meta(id, |m| {
            m.attached.retain(|s| s != session);
            if attached {
                m.attached.push(session.to_owned());
            }
        })
        .map(drop)
    }

    pub fn rename(&self, id: &str, title: &str) -> anyhow::Result<SharedArtifactMeta> {
        let title = title.trim();
        if title.is_empty() {
            return Err(crate::error::invalid("a title is required"));
        }
        self.update_meta(id, |m| {
            m.title = title.to_owned();
            m.updated_ms = crate::log::now_ms();
        })
    }

    pub fn delete(&self, id: &str) -> anyhow::Result<()> {
        self.get(id)?;
        let folder = self.folder(id)?;
        let _guard = self.write_lock.lock();
        std::fs::remove_dir_all(&folder)?;
        self.index.write().remove(id);
        Ok(())
    }

    /// Removes a deleted Session from every `attached`. Returns whether any artifact changed.
    pub fn forget_session(&self, session: &str) -> bool {
        let ids: Vec<String> = self.index.read().values().filter(|m| m.attached.iter().any(|s| s == session)).map(|m| m.id.clone()).collect();
        for id in &ids {
            if let Err(e) = self.set_attached(id, session, false) {
                tracing::warn!("detaching deleted session from shared artifact {id}: {e:#}");
            }
        }
        !ids.is_empty()
    }

    /// Reads one artifact's meta again (after a change on disk). Returns whether the list changed:
    /// it appeared, went away, or its title changed.
    pub fn refresh(&self, id: &str) -> bool {
        let fresh = self.folder(id).ok().and_then(|f| load(&f).ok());
        let mut index = self.index.write();
        match fresh {
            Some(meta) => index.insert(id.to_owned(), meta.clone()).is_none_or(|old| old.title != meta.title || old.attached != meta.attached),
            None => index.remove(id).is_some(),
        }
    }

    /// Watches `shared/` and calls `on_change` with the id of each artifact whose folder changed,
    /// once per burst of writes. Does nothing when already watching.
    pub fn start_watch(&self, on_change: impl Fn(String) + Send + 'static) {
        let mut watch = self.watch.lock();
        if watch.is_some() {
            return;
        }
        let accept = |name: &str| {
            let id = name.split('/').next().unwrap_or_default();
            is_id(id).then(|| id.to_owned())
        };
        match crate::panels::watch_with(&self.dir, crate::panels::DEBOUNCE, accept, on_change) {
            Ok(w) => *watch = Some(w),
            Err(e) => tracing::warn!("watching {}: {e:#}", self.dir.display()),
        }
    }

    /// Read-modify-write of `meta.json` from disk; the index follows.
    fn update_meta(&self, id: &str, f: impl FnOnce(&mut SharedArtifactMeta)) -> anyhow::Result<SharedArtifactMeta> {
        self.get(id)?;
        let folder = self.folder(id)?;
        let _guard = self.write_lock.lock();
        let mut meta: SharedArtifactMeta = serde_json::from_slice(&std::fs::read(folder.join(META))?)?;
        f(&mut meta);
        write_meta(&folder, &meta)?;
        let meta = effective(&folder, meta);
        self.index.write().insert(id.to_owned(), meta.clone());
        Ok(meta)
    }

    /// Marks the artifact as just changed in the index.
    fn touch(&self, id: &str) {
        if let Some(m) = self.index.write().get_mut(id) {
            m.updated_ms = m.updated_ms.max(crate::log::now_ms());
        }
    }
}

fn write_meta(folder: &Path, meta: &SharedArtifactMeta) -> anyhow::Result<()> {
    crate::fsutil::write_atomic(&folder.join(META), &serde_json::to_vec_pretty(meta)?)
}

/// `meta` with `updated_ms` raised to the last write of its content or state (edits from outside).
fn effective(folder: &Path, mut meta: SharedArtifactMeta) -> SharedArtifactMeta {
    for f in [content_name(meta.kind), STATE] {
        if let Some(t) = crate::panels::file_mtime_ms(&folder.join(f)) {
            meta.updated_ms = meta.updated_ms.max(t);
        }
    }
    meta
}

/// One artifact's meta from its folder, checked against the folder name.
fn load(folder: &Path) -> anyhow::Result<SharedArtifactMeta> {
    let meta: SharedArtifactMeta = serde_json::from_slice(&std::fs::read(folder.join(META))?)?;
    let name = folder.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    anyhow::ensure!(meta.id == name, "meta.json names {:?}", meta.id);
    Ok(effective(folder, meta))
}

/// The index: every folder of `dir` with a good `meta.json`. Others are skipped with a warning.
fn scan(dir: &Path) -> BTreeMap<String, SharedArtifactMeta> {
    let mut out = BTreeMap::new();
    let Ok(entries) = std::fs::read_dir(dir) else { return out };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if !path.is_dir() || !is_id(&name) {
            continue;
        }
        match load(&path) {
            Ok(meta) => {
                out.insert(name, meta);
            }
            Err(e) => tracing::warn!("skipping shared artifact {}: {e:#}", path.display()),
        }
    }
    out
}

/// One line of text around `content[at..at + len]`, at most about 120 characters; `None` for empty content.
fn snippet(content: &str, at: usize, len: usize) -> Option<String> {
    if content.trim().is_empty() {
        return None;
    }
    let start = content.floor_char_boundary(at.saturating_sub(40));
    let end = content.ceil_char_boundary((at + len + 80).min(content.len()));
    let text: String = content[start..end].split_whitespace().collect::<Vec<_>>().join(" ");
    Some(format!("{}{text}{}", if start > 0 { "…" } else { "" }, if end < content.len() { "…" } else { "" }))
}

/// Moves a file; copies and removes it when a rename cannot (another file system).
pub fn move_file(from: &Path, to: &Path) -> anyhow::Result<()> {
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    std::fs::copy(from, to)?;
    std::fs::remove_file(from)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "tests fail loudly")]
    use super::*;

    fn creator() -> SharedCreator {
        SharedCreator { session_id: "s1".into(), session_title: "Session".into(), origin: None }
    }

    fn make(store: &SharedArtifacts, title: &str, kind: SharedKind, content: &str) -> SharedArtifactMeta {
        let content = content.to_owned();
        store.create(title, kind, creator(), vec!["s1".into()], |dir| Ok(std::fs::write(dir.join(content_name(kind)), content)?)).unwrap()
    }

    #[test]
    fn ids_are_slugs_with_a_suffix() {
        let id = new_id("Release Q4 — checklist!");
        assert!(id.starts_with("release-q4-checklist-") && id.len() == "release-q4-checklist-".len() + 6, "{id}");
        assert!(is_id(&id));
        assert!(new_id("***").starts_with("artifact-"));
        assert!(is_id(&new_id(&"x".repeat(200))), "long titles are cut");
        for bad in ["", "-a", "A", "a/b", "a_b", "..", &"a".repeat(65)] {
            assert!(!is_id(bad), "{bad}");
        }
        assert_eq!(reference("shared:abc"), Some("abc"));
        assert_eq!(reference("p.md"), None);
    }

    #[test]
    fn content_path_is_the_kind_file() {
        let d = tempfile::tempdir().unwrap();
        let store = SharedArtifacts::open(d.path().join("shared")).unwrap();
        let m = make(&store, "Plan", SharedKind::Html, "<p>x</p>");
        let p = store.content_path(&m.id).unwrap();
        assert_eq!(p, d.path().join("shared").join(&m.id).join("content.html"));
        assert!(p.is_file());
        assert!(store.content_path("nope-aaaaaa").is_err());
        assert!(store.content_path("../x").is_err());
    }

    #[test]
    fn scan_skips_bad_folders() {
        let d = tempfile::tempdir().unwrap();
        let store = SharedArtifacts::open(d.path().join("shared")).unwrap();
        let good = make(&store, "Good one", SharedKind::Md, "# Good");
        let shared = d.path().join("shared");
        std::fs::create_dir_all(shared.join("broken-aaaaaa")).unwrap();
        std::fs::write(shared.join("broken-aaaaaa/meta.json"), "{ not json").unwrap();
        std::fs::create_dir_all(shared.join("no-meta-bbbbbb")).unwrap();
        std::fs::create_dir_all(shared.join("wrong-cccccc")).unwrap();
        std::fs::write(shared.join("wrong-cccccc/meta.json"), serde_json::to_vec(&good).unwrap()).unwrap();
        std::fs::create_dir_all(shared.join(".new-x")).unwrap();
        let reopened = SharedArtifacts::open(shared).unwrap();
        let ids: Vec<String> = reopened.list(None).into_iter().map(|e| e.meta.id).collect();
        assert_eq!(ids, vec![good.id]);
    }

    #[test]
    fn search_ranks_title_matches_first() {
        let d = tempfile::tempdir().unwrap();
        let store = SharedArtifacts::open(d.path().join("shared")).unwrap();
        let in_text = make(&store, "Notes", SharedKind::Md, &format!("{}The Release plan is here.\nMore.", "x ".repeat(50)));
        std::thread::sleep(std::time::Duration::from_millis(5));
        let newer_text = make(&store, "Board", SharedKind::Html, "<p>release board</p>");
        std::thread::sleep(std::time::Duration::from_millis(5));
        let in_title = make(&store, "Release checklist", SharedKind::Md, "- [ ] ship");
        make(&store, "Other", SharedKind::Md, "nothing here");

        let hits = store.list(Some("RELEASE"));
        let ids: Vec<&str> = hits.iter().map(|e| e.meta.id.as_str()).collect();
        assert_eq!(ids, vec![in_title.id.as_str(), newer_text.id.as_str(), in_text.id.as_str()]);
        let s = hits[2].snippet.as_deref().unwrap();
        assert!(s.starts_with('…') && s.contains("The Release plan is here. More."), "{s}");
        assert_eq!(hits[0].snippet.as_deref(), Some("- [ ] ship"));
        assert!(store.list(Some("nope")).is_empty());
        assert_eq!(store.list(None).len(), 4);
        assert_eq!(store.list(Some("  ")).len(), 4, "a blank query lists all");
    }

    #[test]
    fn state_rename_attach_and_delete() {
        let d = tempfile::tempdir().unwrap();
        let store = SharedArtifacts::open(d.path().join("shared")).unwrap();
        let m = make(&store, "Plan", SharedKind::Ui, r#"{"root":{"type":"Markdown","props":{"text":"x"}},"files":{}}"#);
        assert_eq!(store.state(&m.id).unwrap(), json!({}));
        let next = store.patch_state(&m.id, &[StatePatchOp::Add { path: "/a".into(), value: json!(1) }]).unwrap();
        assert_eq!(next, json!({ "a": 1 }));
        assert!(store.patch_state(&m.id, &[StatePatchOp::Test { path: "/a".into(), value: json!(2) }]).is_err());
        let read = store.read(&m.id).unwrap();
        assert_eq!((read.state, read.hash.len()), (json!({ "a": 1 }), 64));

        store.set_attached(&m.id, "s2", true).unwrap();
        store.set_attached(&m.id, "s2", true).unwrap();
        assert_eq!(store.get(&m.id).unwrap().attached, vec!["s1", "s2"]);
        assert!(store.forget_session("s1"));
        assert!(!store.forget_session("s1"));
        let renamed = store.rename(&m.id, " New name ").unwrap();
        assert_eq!((renamed.title.as_str(), renamed.attached.clone()), ("New name", vec!["s2".to_owned()]));
        assert_eq!(renamed.id, m.id, "the id never changes");
        let reopened = SharedArtifacts::open(d.path().join("shared")).unwrap();
        assert_eq!(reopened.get(&m.id).unwrap().title, "New name", "meta.json is the truth");

        store.write_ui(&m.id, &json!({ "type": "Markdown", "props": { "text": "y" } }), vec![]).unwrap();
        assert!(store.read(&m.id).unwrap().content.contains("\"y\""));
        let md = make(&store, "Text", SharedKind::Md, "x");
        assert!(store.write_ui(&md.id, &json!({}), vec![]).is_err(), "only ui artifacts take a tree");

        store.delete(&m.id).unwrap();
        assert!(!d.path().join("shared").join(&m.id).exists());
        assert!(store.get(&m.id).is_err() && store.read(&m.id).is_err());
        assert!(store.folder("../x").is_err());
    }

    #[test]
    fn refresh_follows_the_disk() {
        let d = tempfile::tempdir().unwrap();
        let store = SharedArtifacts::open(d.path().join("shared")).unwrap();
        let m = make(&store, "Plan", SharedKind::Md, "x");
        assert!(!store.refresh(&m.id), "unchanged");
        let folder = store.folder(&m.id).unwrap();
        let mut edited = m.clone();
        edited.title = "Edited".into();
        write_meta(&folder, &edited).unwrap();
        assert!(store.refresh(&m.id));
        std::fs::remove_dir_all(&folder).unwrap();
        assert!(store.refresh(&m.id));
        assert!(store.list(None).is_empty());
    }
}
