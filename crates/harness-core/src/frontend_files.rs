//! Images in Frontend Tool input. A Frontend marks a string with `"format": "harness-image"`.
//! The core copies each local image there into the Session's `frontend/files/` and records
//! `src -> copy` (relative to `frontend/`) on the event, so a View shows it after the Workspace is
//! gone. The input stays as the Agent sent it. `https:` and `data:image/` URLs are not copied.

use parking_lot::Mutex;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use jsonschema::Validator;
use serde_json::Value;

use crate::attachments::{guess_mime, is_image, stored_name};

pub const IMAGE_FORMAT: &str = "harness-image";
const MAX_IMAGE: u64 = 20 * 1024 * 1024;
const DIR: &str = "files";

/// A validator for `schema` and the `harness-image` strings it saw in valid input.
pub fn validator(schema: &Value) -> anyhow::Result<(Validator, Arc<Mutex<Vec<String>>>)> {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let s = seen.clone();
    let v = jsonschema::options()
        .with_format(IMAGE_FORMAT, move |src: &str| {
            s.lock().push(src.to_owned());
            true
        })
        .should_validate_formats(true)
        .build(schema)
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok((v, seen))
}

const MAX_ERRORS: usize = 5;

/// The deepest object on `pointer` (a JSON Pointer into `input`) with a string `type`.
fn node_type<'a>(input: &'a Value, pointer: &str) -> Option<&'a str> {
    let mut found = None;
    let mut cur = input;
    let mut path = String::new();
    let tokens = std::iter::once(None).chain(pointer.split('/').skip(1).map(Some));
    for token in tokens {
        if let Some(t) = token {
            path.push('/');
            path.push_str(t);
            let t = t.replace("~1", "/").replace("~0", "~");
            cur = match cur {
                Value::Object(m) => m.get(&t),
                Value::Array(a) => t.parse::<usize>().ok().and_then(|i| a.get(i)),
                _ => None,
            }
            .unwrap_or(&Value::Null);
        }
        if let Some(ty) = cur.get("type").and_then(Value::as_str) {
            found = Some(ty);
        }
    }
    found
}

/// Validation errors as text: `path (NodeType): message`. One per path (anyOf/oneOf repeat
/// themselves), at most 5, then `(N more)`. Empty when the input is valid.
pub fn format_errors(validator: &Validator, input: &Value) -> String {
    let mut seen = std::collections::HashSet::new();
    let all: Vec<String> = validator
        .iter_errors(input)
        .filter_map(|e| {
            let path = e.instance_path.to_string();
            if !seen.insert(path.clone()) {
                return None;
            }
            let ty = node_type(input, &path).map(|t| format!(" ({t})")).unwrap_or_default();
            Some(format!("{path}{ty}: {e}"))
        })
        .collect();
    let mut out = all.iter().take(MAX_ERRORS).cloned().collect::<Vec<_>>().join("\n");
    if all.len() > MAX_ERRORS {
        out.push_str(&format!("\n({} more)", all.len() - MAX_ERRORS));
    }
    out
}

/// A local image checked by `plan`: the file is opened then, and `store` copies from that handle,
/// so a file swapped in the meantime is not the one copied.
#[derive(Debug)]
pub struct Planned {
    /// The source as the Frontend gave it.
    pub src: String,
    /// Its resolved location.
    pub path: PathBuf,
    /// The file lies outside the Workspace Folder: the user approves each such file.
    pub outside: bool,
    file: std::fs::File,
}

/// Local images to copy. Checks them all before anything is written. Relative paths are relative
/// to the Workspace Folder; a source outside it is allowed but flagged `outside`.
pub fn plan(folder: &Path, srcs: &[String]) -> anyhow::Result<Vec<Planned>> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    let mut out: Vec<Planned> = Vec::new();
    for src in srcs {
        if src.starts_with("https://") || src.starts_with("data:image/") || out.iter().any(|p| &p.src == src) {
            continue;
        }
        anyhow::ensure!(!src.contains("://"), "{src}: only https URLs or local image files");
        let path = std::fs::canonicalize(folder.join(src)).map_err(|e| anyhow::anyhow!("{src}: {e}"))?;
        // Before opening: a FIFO or a device would block the open.
        anyhow::ensure!(std::fs::metadata(&path)?.is_file(), "{src} is not a file");
        let file = std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NONBLOCK).open(&path).map_err(|e| anyhow::anyhow!("{src}: {e}"))?;
        let meta = file.metadata()?;
        anyhow::ensure!(meta.is_file(), "{src} is not a file");
        anyhow::ensure!(is_image(guess_mime(&path)), "{src} is not an image (png, jpg, gif, webp)");
        anyhow::ensure!(meta.len() <= MAX_IMAGE, "{src} is larger than 20 MB");
        // The path must still name the file that was opened, and be the path that is shown.
        let now = std::fs::metadata(&path)?;
        anyhow::ensure!((now.dev(), now.ino()) == (meta.dev(), meta.ino()), "{src} changed while it was read");
        anyhow::ensure!(std::fs::canonicalize(&path)? == path, "{src} changed while it was read");
        let outside = !crate::fsutil::inside_existing(folder, &path).is_ok_and(|r| r.within());
        out.push(Planned { src: src.clone(), path, outside, file });
    }
    Ok(out)
}

/// `plan` on a blocking thread: it reads the disk.
pub async fn plan_blocking(folder: PathBuf, srcs: Vec<String>) -> anyhow::Result<Vec<Planned>> {
    tokio::task::spawn_blocking(move || plan(&folder, &srcs)).await?
}

/// `store` on a blocking thread: it copies files.
pub async fn store_blocking(frontend_dir: PathBuf, planned: Vec<Planned>) -> anyhow::Result<BTreeMap<String, String>> {
    tokio::task::spawn_blocking(move || store(&frontend_dir, planned)).await?
}

/// Copies the planned images into `frontend_dir/files/`: `src -> path relative to frontend_dir`.
/// `files` must be a real directory below the real `frontend_dir`.
pub fn store(frontend_dir: &Path, planned: Vec<Planned>) -> anyhow::Result<BTreeMap<String, String>> {
    use std::io::Read;
    let mut files = BTreeMap::new();
    for Planned { src, path, file, .. } in planned {
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let rel = format!("{DIR}/{}", stored_name(&name));
        let dest = frontend_dir.join(&rel);
        let dir = crate::fsutil::parent_of(&dest)?;
        std::fs::create_dir_all(dir)?;
        let real_dir = std::fs::symlink_metadata(dir)?.file_type().is_dir() && crate::fsutil::resolve_below_via_ancestor(frontend_dir, dir).is_some();
        anyhow::ensure!(real_dir, "{DIR} is not a plain directory of the Frontend's folder");
        let mut out = std::fs::OpenOptions::new().write(true).create_new(true).open(&dest)?;
        let copied = std::io::copy(&mut file.take(MAX_IMAGE + 1), &mut out)?;
        if copied > MAX_IMAGE {
            let _ = std::fs::remove_file(&dest);
            anyhow::bail!("{src} is larger than 20 MB");
        }
        files.insert(src, rel);
    }
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn errors_name_the_node_type_and_are_capped() {
        let schema = json!({ "type": "object", "properties": { "root": { "type": "object", "properties": { "children": { "type": "array", "items": { "type": "object", "required": ["props"] } } } } } });
        let (v, _) = validator(&schema).unwrap();
        let input = json!({ "root": { "type": "Stack", "children": [{ "type": "Text", "props": {} }, { "type": "Accordion" }] } });
        let text = format_errors(&v, &input);
        assert!(text.starts_with("/root/children/1 (Accordion): "), "{text}");
        assert_eq!(text.lines().count(), 1);
        let many = json!({ "root": { "children": (0..8).map(|_| json!({})).collect::<Vec<_>>() } });
        let text = format_errors(&v, &many);
        assert!(text.starts_with("/root/children/0: "), "{text}");
        assert_eq!(text.lines().count(), 6);
        assert!(text.ends_with("(3 more)"), "{text}");
        assert_eq!(format_errors(&v, &json!({})), "");
    }

    #[test]
    fn copies_local_images_and_keeps_urls() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("shot.png"), b"png").unwrap();
        std::fs::write(dir.path().join("notes.txt"), b"x").unwrap();
        let schema = json!({ "type": "object", "properties": { "imgs": { "type": "array", "items": { "type": "string", "format": IMAGE_FORMAT } }, "label": { "type": "string" } } });
        let (v, seen) = validator(&schema).unwrap();
        let input = json!({ "imgs": ["shot.png", "https://x.test/a.png", "shot.png"], "label": "x" });
        assert!(v.is_valid(&input));
        let srcs = seen.lock().clone();
        let planned = plan(dir.path(), &srcs).unwrap();
        assert_eq!(planned.len(), 1);
        assert!(!planned[0].outside);
        let fe = dir.path().join("frontend");
        let files = store(&fe, planned).unwrap();
        assert_eq!(files.len(), 1);
        let rel = &files["shot.png"];
        assert!(rel.starts_with("files/") && rel.ends_with("-shot.png"), "{rel}");
        assert_eq!(std::fs::read(fe.join(rel)).unwrap(), b"png");

        assert!(plan(dir.path(), &["notes.txt".into()]).unwrap_err().to_string().contains("not an image"));
        assert!(plan(dir.path(), &["missing.png".into()]).is_err());
        assert!(plan(dir.path(), &["http://x.test/a.png".into()]).is_err());
    }

    #[test]
    fn sources_outside_the_folder_are_flagged_and_inside_ones_are_not() {
        let d = tempfile::tempdir().unwrap();
        let (folder, other) = (d.path().join("work"), d.path().join("other"));
        std::fs::create_dir_all(folder.join("pkg")).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(folder.join("pkg/in.png"), b"png").unwrap();
        std::fs::write(other.join("out.png"), b"png").unwrap();
        std::os::unix::fs::symlink(folder.join("pkg"), folder.join("inner")).unwrap();
        std::os::unix::fs::symlink(other.join("out.png"), folder.join("a_link_that_leaves.png")).unwrap();
        std::os::unix::fs::symlink(&other, folder.join("out")).unwrap();

        let abs_in = folder.join("pkg/in.png").display().to_string();
        for ok in ["inner/in.png", "pkg/in.png", abs_in.as_str()] {
            assert!(!plan(&folder, &[ok.to_owned()]).unwrap()[0].outside, "{ok}");
        }
        let abs_out = other.join("out.png").display().to_string();
        for bad in ["a_link_that_leaves.png", "out/out.png", "../other/out.png", abs_out.as_str()] {
            let p = plan(&folder, &[bad.to_owned()]).unwrap();
            assert!(p[0].outside, "{bad}");
            assert_eq!(p[0].path, other.canonicalize().unwrap().join("out.png"), "the resolved location is what is shown");
        }
    }

    #[test]
    fn the_copy_reads_the_file_that_was_checked() {
        let d = tempfile::tempdir().unwrap();
        let (folder, fe) = (d.path().join("work"), d.path().join("fe"));
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("shot.png"), b"checked").unwrap();
        std::fs::write(d.path().join("secret.png"), b"swapped").unwrap();
        let planned = plan(&folder, &["shot.png".into()]).unwrap();
        std::fs::remove_file(folder.join("shot.png")).unwrap();
        std::os::unix::fs::symlink(d.path().join("secret.png"), folder.join("shot.png")).unwrap();
        let files = store(&fe, planned).unwrap();
        assert_eq!(std::fs::read(fe.join(&files["shot.png"])).unwrap(), b"checked");
    }

    #[test]
    fn files_must_be_a_plain_directory_of_the_frontend_folder() {
        let d = tempfile::tempdir().unwrap();
        let (folder, fe, out) = (d.path().join("work"), d.path().join("fe"), d.path().join("out"));
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::create_dir_all(&fe).unwrap();
        std::fs::create_dir_all(&out).unwrap();
        std::fs::write(folder.join("shot.png"), b"png").unwrap();
        std::os::unix::fs::symlink(&out, fe.join("files")).unwrap();
        assert!(store(&fe, plan(&folder, &["shot.png".into()]).unwrap()).is_err());
        assert_eq!(std::fs::read_dir(&out).unwrap().count(), 0);
    }

    #[test]
    fn a_pipe_is_refused_without_blocking() {
        let d = tempfile::tempdir().unwrap();
        let fifo = d.path().join("pipe.png");
        assert!(std::process::Command::new("mkfifo").arg(&fifo).status().unwrap().success());
        let e = plan(d.path(), &["pipe.png".into()]).unwrap_err();
        assert!(e.to_string().contains("not a file"), "{e}");
    }
}
