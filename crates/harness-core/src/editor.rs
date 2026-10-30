//! "Open in editor": the user's editor (kept in `<data dir>/editor.json`) opens a Session's folder,
//! or a file in it at a line, through the editor's URL scheme. Only paths inside the folder open.

use std::path::{Path, PathBuf};

use crate::api::Editor;

pub fn load(data_dir: &Path) -> Option<Editor> {
    serde_json::from_slice(&std::fs::read(data_dir.join("editor.json")).ok()?).ok()
}

pub fn save(data_dir: &Path, editor: Option<&Editor>) -> anyhow::Result<()> {
    let path = data_dir.join("editor.json");
    match editor {
        Some(e) => std::fs::write(path, serde_json::to_vec_pretty(e)?)?,
        None => {
            let _ = std::fs::remove_file(path);
        }
    }
    Ok(())
}

/// `path` (relative to `folder`, or absolute) when it exists inside `folder`; `None` is the folder.
pub fn resolve(folder: &Path, path: Option<&str>) -> anyhow::Result<PathBuf> {
    let root = std::fs::canonicalize(folder)?;
    let Some(p) = path.filter(|p| !p.trim().is_empty()) else { return Ok(root) };
    let p = std::fs::canonicalize(root.join(p)).map_err(|e| anyhow::anyhow!("{p}: {e}"))?;
    anyhow::ensure!(p.starts_with(&root), "{} is outside the Session's folder", p.display());
    Ok(p)
}

/// What to open: an editor URL, or the path itself for the system default app.
pub fn target(editor: &Editor, path: &Path, line: Option<u32>) -> String {
    let file = encode(&path.to_string_lossy());
    let at = |sep: &str| line.map(|l| format!("{sep}{l}")).unwrap_or_default();
    match editor {
        Editor::System => path.to_string_lossy().into_owned(),
        Editor::Vscode => format!("vscode://file{file}{}", at(":")),
        Editor::Cursor => format!("cursor://file{file}{}", at(":")),
        Editor::Windsurf => format!("windsurf://file{file}{}", at(":")),
        Editor::Zed => format!("zed://file{file}{}", at(":")),
        Editor::Custom { template } => template.replace("{path}", &file).replace("{line}", &line.unwrap_or(1).to_string()),
    }
}

/// Opens `target` with the OS (`open`, `xdg-open`, `start`).
pub fn open(target: &str) -> anyhow::Result<()> {
    let mut cmd = if cfg!(target_os = "macos") {
        let mut c = std::process::Command::new("open");
        c.arg(target);
        c
    } else if cfg!(windows) {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "start", "", target]);
        c
    } else {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(target);
        c
    };
    let status = cmd.status().map_err(|e| anyhow::anyhow!("could not open {target}: {e}"))?;
    anyhow::ensure!(status.success(), "could not open {target}: is the editor installed?");
    Ok(())
}

/// Percent-encodes a path for a URL, keeping `/`.
fn encode(path: &str) -> String {
    let mut out = String::new();
    for b in path.bytes() {
        if b.is_ascii_alphanumeric() || b"/-._~:".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn editor_urls() {
        let p = Path::new("/w/my app/src/main.rs");
        assert_eq!(target(&Editor::Vscode, p, Some(12)), "vscode://file/w/my%20app/src/main.rs:12");
        assert_eq!(target(&Editor::Zed, p, None), "zed://file/w/my%20app/src/main.rs");
        assert_eq!(target(&Editor::System, p, Some(3)), "/w/my app/src/main.rs");
        let custom = Editor::Custom { template: "idea://open?file={path}&line={line}".into() };
        assert_eq!(target(&custom, p, None), "idea://open?file=/w/my%20app/src/main.rs&line=1");
    }

    #[test]
    fn only_paths_inside_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("proj");
        std::fs::create_dir_all(folder.join("src")).unwrap();
        std::fs::write(folder.join("src/a.rs"), "").unwrap();
        std::fs::write(dir.path().join("secret.txt"), "").unwrap();
        let root = std::fs::canonicalize(&folder).unwrap();
        assert_eq!(resolve(&folder, None).unwrap(), root);
        assert_eq!(resolve(&folder, Some("src/a.rs")).unwrap(), root.join("src/a.rs"));
        assert!(resolve(&folder, Some("../secret.txt")).unwrap_err().to_string().contains("outside"));
        assert!(resolve(&folder, Some("missing.rs")).is_err());
    }
}
