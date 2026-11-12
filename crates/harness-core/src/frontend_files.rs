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
        std::fs::create_dir_all(crate::env::parent_of(&dest)?)?;
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
