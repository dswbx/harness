//! Images in Frontend Tool input. A Frontend marks a string with `"format": "harness-image"`.
//! The core copies each local image there into the Session's `frontend/files/` and records
//! `src -> copy` (relative to `frontend/`) on the event, so a View shows it after the Workspace is
//! gone. The input stays as the Agent sent it. `https:` and `data:image/` URLs are not copied.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

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
            s.lock().unwrap().push(src.to_owned());
            true
        })
        .should_validate_formats(true)
        .build(schema)
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok((v, seen))
}

/// Local images to copy: `(src as given, file)`. Checks them all before anything is written.
/// Relative paths are relative to the Workspace Folder.
pub fn plan(folder: &Path, srcs: &[String]) -> anyhow::Result<Vec<(String, PathBuf)>> {
    let mut out: Vec<(String, PathBuf)> = Vec::new();
    for src in srcs {
        if src.starts_with("https://") || src.starts_with("data:image/") || out.iter().any(|(s, _)| s == src) {
            continue;
        }
        anyhow::ensure!(!src.contains("://"), "{src}: only https URLs or local image files");
        let p = std::fs::canonicalize(folder.join(src)).map_err(|e| anyhow::anyhow!("{src}: {e}"))?;
        anyhow::ensure!(p.is_file(), "{src} is not a file");
        anyhow::ensure!(is_image(guess_mime(&p)), "{src} is not an image (png, jpg, gif, webp)");
        anyhow::ensure!(std::fs::metadata(&p)?.len() <= MAX_IMAGE, "{src} is larger than 20 MB");
        out.push((src.clone(), p));
    }
    Ok(out)
}

/// Copies the planned images into `frontend_dir/files/`: `src -> path relative to frontend_dir`.
pub fn store(frontend_dir: &Path, planned: Vec<(String, PathBuf)>) -> anyhow::Result<BTreeMap<String, String>> {
    let mut files = BTreeMap::new();
    for (src, file) in planned {
        let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let rel = format!("{DIR}/{}", stored_name(&name));
        let dest = frontend_dir.join(&rel);
        std::fs::create_dir_all(dest.parent().unwrap())?;
        std::fs::copy(&file, &dest)?;
        files.insert(src, rel);
    }
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn copies_local_images_and_keeps_urls() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("shot.png"), b"png").unwrap();
        std::fs::write(dir.path().join("notes.txt"), b"x").unwrap();
        let schema = json!({ "type": "object", "properties": { "imgs": { "type": "array", "items": { "type": "string", "format": IMAGE_FORMAT } }, "label": { "type": "string" } } });
        let (v, seen) = validator(&schema).unwrap();
        let input = json!({ "imgs": ["shot.png", "https://x.test/a.png", "shot.png"], "label": "x" });
        assert!(v.is_valid(&input));
        let srcs = seen.lock().unwrap().clone();
        let planned = plan(dir.path(), &srcs).unwrap();
        assert_eq!(planned.len(), 1);
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
}
