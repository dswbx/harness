//! The Session Note (ADR 0028): one Markdown file, `<session dir>/note.md`, typed by the user.
//! Its images are in `<session dir>/attachments/note/`, so `ReadAttachment` serves them. Not in
//! the Session Log; it goes with the Session Directory when the Session is deleted.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use super::Session;
use crate::api::{AttachmentInput, Note};

const FILE: &str = "note.md";
/// Below the Session Directory.
const IMAGES: [&str; 2] = ["attachments", "note"];
/// Largest note.
const MAX_BYTES: usize = 1024 * 1024;
/// Largest image.
const MAX_IMAGE: u64 = 25 * 1024 * 1024;

impl Session {
    /// `note.md` (it may not exist yet). The Agent reads it; only the user writes it.
    pub fn note_path(&self) -> PathBuf {
        self.dir.join(FILE)
    }

    pub fn read_note(&self) -> anyhow::Result<Note> {
        read(&self.dir)
    }

    /// See `write`.
    pub fn write_note(&self, content: &str, base_hash: Option<&str>) -> anyhow::Result<Note> {
        let _guard = self.note_lock.lock();
        write(&self.dir, content, base_hash)
    }

    pub fn add_note_images(&self, files: Vec<AttachmentInput>) -> anyhow::Result<Note> {
        let _guard = self.note_lock.lock();
        add_images(&self.dir, files)
    }
}

fn hash(content: &str) -> String {
    format!("{:x}", Sha256::digest(content.as_bytes()))
}

fn images_dir(dir: &Path) -> PathBuf {
    IMAGES.iter().fold(dir.to_owned(), |p, part| p.join(part))
}

/// The note in Session Directory `dir`; empty when it was never written.
pub(crate) fn read(dir: &Path) -> anyhow::Result<Note> {
    let path = dir.join(FILE);
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e.into()),
    };
    let mut images: Vec<String> = match std::fs::read_dir(images_dir(dir)) {
        Ok(entries) => entries.filter_map(Result::ok).filter(|e| e.file_type().is_ok_and(|t| t.is_file())).map(|e| e.path().display().to_string()).collect(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(e.into()),
    };
    // Stored names start with a uuid v7: by name is oldest first.
    images.sort();
    Ok(Note { hash: hash(&content), updated_ms: crate::panels::file_mtime_ms(&path), content, images })
}

/// Replaces the note. With `base_hash`, refuses (`conflict`) when the note changed since that hash
/// was read. The caller serializes writes.
pub(crate) fn write(dir: &Path, content: &str, base_hash: Option<&str>) -> anyhow::Result<Note> {
    if content.len() > MAX_BYTES {
        return Err(crate::error::invalid("the note is larger than 1 MB"));
    }
    if let Some(base) = base_hash
        && base != read(dir)?.hash
    {
        return Err(crate::error::conflict("the note changed elsewhere: reload it"));
    }
    crate::fsutil::write_atomic(&dir.join(FILE), content.as_bytes())?;
    read(dir)
}

/// Copies images into `attachments/note/`. Refuses anything that is not an image.
pub(crate) fn add_images(dir: &Path, files: Vec<AttachmentInput>) -> anyhow::Result<Note> {
    if files.is_empty() {
        return Err(crate::error::invalid("no files"));
    }
    let loaded = files.into_iter().map(|f| crate::attachments::load(f, MAX_IMAGE)).collect::<anyhow::Result<Vec<_>>>()?;
    if let Some((name, ..)) = loaded.iter().find(|(_, mime, _)| !mime.starts_with("image/")) {
        return Err(crate::error::invalid(format!("{name} is not an image")));
    }
    let images = images_dir(dir);
    std::fs::create_dir_all(&images)?;
    for (name, _, bytes) in loaded {
        crate::fsutil::write_atomic(&images.join(crate::attachments::stored_name(&name)), &bytes)?;
    }
    read(dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::ErrorCode;
    use crate::api::HarnessError;
    use base64::Engine;

    fn code(e: anyhow::Error) -> ErrorCode {
        HarnessError::from(e).code
    }

    #[test]
    fn a_missing_note_is_empty_and_a_written_one_reads_back() {
        let dir = tempfile::tempdir().unwrap();
        let empty = read(dir.path()).unwrap();
        assert_eq!((empty.content.as_str(), empty.updated_ms, empty.images.len()), ("", None, 0));
        let note = write(dir.path(), "# Plan\n\n- one\n", Some(&empty.hash)).unwrap();
        assert_eq!(note.content, "# Plan\n\n- one\n");
        assert!(note.updated_ms.is_some());
        assert_ne!(note.hash, empty.hash);
        assert_eq!(read(dir.path()).unwrap(), note);
        assert_eq!(std::fs::read_to_string(dir.path().join("note.md")).unwrap(), "# Plan\n\n- one\n");
    }

    #[test]
    fn a_write_on_an_old_hash_conflicts() {
        let dir = tempfile::tempdir().unwrap();
        let base = read(dir.path()).unwrap().hash;
        write(dir.path(), "window a", Some(&base)).unwrap();
        let e = write(dir.path(), "window b", Some(&base)).unwrap_err();
        assert_eq!(code(e), ErrorCode::Conflict);
        assert_eq!(read(dir.path()).unwrap().content, "window a", "the refused write changed nothing");
        // Without a base the write wins.
        assert_eq!(write(dir.path(), "window b", None).unwrap().content, "window b");
    }

    #[test]
    fn images_go_to_attachments_note_and_are_readable_as_attachments() {
        let dir = tempfile::tempdir().unwrap();
        let png = dir.path().join("shot.png");
        std::fs::write(&png, b"png").unwrap();
        let data =
            AttachmentInput::Data { name: "pasted.jpg".into(), mime: "image/jpeg".into(), data: base64::engine::general_purpose::STANDARD.encode(b"jpg") };
        let note = add_images(dir.path(), vec![AttachmentInput::Path { path: png.display().to_string() }, data]).unwrap();
        assert_eq!(note.images.len(), 2);
        let below = dir.path().join("attachments").join("note");
        for path in &note.images {
            assert!(Path::new(path).starts_with(&below), "{path}");
            assert!(crate::attachments::read(dir.path(), path).is_ok(), "ReadAttachment serves {path}");
        }
        assert!(note.images[0].ends_with("-shot.png") && note.images[1].ends_with("-pasted.jpg"), "oldest first: {:?}", note.images);
        // Not an image.
        std::fs::write(dir.path().join("a.txt"), b"text").unwrap();
        let e = add_images(dir.path(), vec![AttachmentInput::Path { path: dir.path().join("a.txt").display().to_string() }]).unwrap_err();
        assert_eq!(code(e), ErrorCode::Invalid);
        assert_eq!(read(dir.path()).unwrap().images.len(), 2);
    }
}
