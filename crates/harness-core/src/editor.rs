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
    if !p.starts_with(&root) {
        return Err(crate::error::policy_denied(format!("{} is outside the Session's folder", p.display())));
    }
    Ok(p)
}

/// Writes `markdown` to `<session_dir>/plans/<name>.md`, `name` cut to `[a-z0-9-]` (so no path tricks). Returns the absolute path.
pub fn export_plan(session_dir: &Path, name: &str, markdown: &str) -> anyhow::Result<PathBuf> {
    let name: String = name.to_lowercase().chars().filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '-').collect();
    anyhow::ensure!(!name.is_empty(), "invalid plan name");
    let dir = session_dir.join("plans");
    std::fs::create_dir_all(&dir)?;
    let file = dir.join(format!("{name}.md"));
    std::fs::write(&file, markdown)?;
    Ok(std::fs::canonicalize(file)?)
}

/// Largest file `read_lines` reads.
pub const MAX_READ: u64 = 2 * 1024 * 1024;

/// Lines `start..=end` (1-based, clipped to the file) of the UTF-8 text file `path` inside `folder`, as
/// (first line number, lines, total line count). Refuses paths outside `folder`, files over `MAX_READ`, binary files.
/// Also finds a relative `path` that does not start at the folder (`embed/src/a.rs` for `crates/embed/src/a.rs`) when
/// exactly one file ends with it (see `find_by_suffix`). Returns the file's path relative to `folder` too.
pub fn read_lines(folder: &Path, path: &str, start: Option<u32>, end: Option<u32>) -> anyhow::Result<(String, u32, Vec<String>, u32)> {
    anyhow::ensure!(!path.trim().is_empty(), "no path");
    let file = match resolve(folder, Some(path)) {
        Err(_) if Path::new(path).is_relative() && !path.starts_with("..") && !folder.join(path).exists() => {
            resolve(folder, Some(&find_by_suffix(folder, path)?))?
        }
        r => r?,
    };
    let root = std::fs::canonicalize(folder)?;
    let rel = file.strip_prefix(&root).unwrap_or(&file).to_string_lossy().replace('\\', "/");
    let meta = std::fs::metadata(&file)?;
    anyhow::ensure!(meta.is_file(), "{path} is not a file");
    anyhow::ensure!(meta.len() <= MAX_READ, "{path} is too large");
    let bytes = std::fs::read(&file)?;
    anyhow::ensure!(!bytes.contains(&0), "{path} is a binary file");
    let text = String::from_utf8(bytes).map_err(|_| anyhow::anyhow!("{path} is not UTF-8 text"))?;
    let all: Vec<&str> = text.lines().collect();
    let total = all.len() as u32;
    let start = start.unwrap_or(1).max(1);
    let end = end.unwrap_or(total).min(total);
    let lines = if start > end { vec![] } else { all[start as usize - 1..end as usize].iter().map(|l| l.to_string()).collect() };
    Ok((rel, start, lines, total))
}

/// Folders `walk_files` skips (besides hidden ones).
const SKIP_DIRS: &[&str] = &["node_modules", "target", "dist", "build", "out", "vendor"];
/// Entries `walk_files` looks at before it gives up; also the most files `list_files` returns.
const MAX_SCAN: usize = 50_000;

/// Calls `f` with the path (relative to `folder`, `/` separators) of each file under `folder`. Skips hidden and
/// build folders, follows no symlinks. Returns `false` when it stopped after `MAX_SCAN` entries.
fn walk_files(folder: &Path, mut f: impl FnMut(&str)) -> bool {
    let mut dirs = vec![PathBuf::new()];
    let mut seen = 0;
    while let Some(dir) = dirs.pop() {
        let Ok(entries) = std::fs::read_dir(folder.join(&dir)) else { continue };
        for e in entries.flatten() {
            seen += 1;
            if seen > MAX_SCAN {
                return false;
            }
            let Ok(kind) = e.file_type() else { continue };
            let name = e.file_name().to_string_lossy().into_owned();
            if kind.is_dir() {
                if !name.starts_with('.') && !SKIP_DIRS.contains(&name.as_str()) {
                    dirs.push(dir.join(&name));
                }
            } else if kind.is_file() {
                let rel = dir.join(&name);
                let parts: Vec<String> = rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
                f(&parts.join("/"));
            }
        }
    }
    true
}

/// The one file under `folder` (relative path) whose path ends with the components of `suffix`. Skips hidden and
/// build folders, follows no symlinks. Fails when no file or several files match.
pub fn find_by_suffix(folder: &Path, suffix: &str) -> anyhow::Result<String> {
    let want: Vec<&str> = suffix.trim_start_matches("./").split('/').filter(|c| !c.is_empty()).collect();
    anyhow::ensure!(!want.is_empty(), "no path");
    let mut found = Vec::new();
    let complete = walk_files(folder, |rel| {
        let parts: Vec<&str> = rel.split('/').collect();
        if parts.len() >= want.len() && parts[parts.len() - want.len()..] == want[..] {
            found.push(rel.to_owned());
        }
    });
    anyhow::ensure!(complete, "{suffix}: No such file (folder too large to search)");
    match found.len() {
        0 => anyhow::bail!("{suffix}: No such file"),
        1 => Ok(found.swap_remove(0)),
        n => anyhow::bail!("{suffix}: {n} files match"),
    }
}

/// Files in `folder` (relative, `/` separators, sorted, at most `MAX_SCAN`). In a git repository: tracked and
/// untracked files that `.gitignore` does not exclude and that exist on disk. Elsewhere: the files `walk_files` finds.
pub async fn list_files(folder: &Path) -> anyhow::Result<Vec<String>> {
    let tracked = crate::workspace::git(folder, &["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).await;
    let folder = folder.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let mut files = Vec::new();
        match tracked {
            // Run in `folder`, git prints paths relative to it.
            Ok(out) => files.extend(out.split('\0').filter(|p| !p.is_empty() && folder.join(p).is_file()).take(MAX_SCAN).map(str::to_owned)),
            Err(_) => {
                walk_files(&folder, |rel| files.push(rel.to_owned()));
            }
        }
        files.sort();
        files.dedup();
        files
    })
    .await
    .map_err(Into::into)
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
    fn export_plan_writes_and_sanitizes() {
        let dir = std::env::temp_dir().join(format!("harness-plan-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p = export_plan(&dir, "plan-v2", "# Hi").unwrap();
        assert_eq!(p, std::fs::canonicalize(dir.join("plans/plan-v2.md")).unwrap());
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "# Hi");
        let p = export_plan(&dir, "../../Evil/x.md", "x").unwrap();
        assert_eq!(p, std::fs::canonicalize(dir.join("plans/evilxmd.md")).unwrap());
        assert!(export_plan(&dir, "../..", "x").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

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

    #[test]
    fn reads_lines_only_inside_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("proj");
        std::fs::create_dir_all(folder.join("src")).unwrap();
        std::fs::write(folder.join("src/a.rs"), "one\ntwo\nthree\nfour\n").unwrap();
        std::fs::write(folder.join("bin.dat"), [0u8, 1, 2]).unwrap();
        std::fs::write(folder.join("latin1.txt"), [0xE9u8, b'a']).unwrap();
        std::fs::write(dir.path().join("secret.txt"), "s").unwrap();
        let (rel, start, lines, total) = read_lines(&folder, "src/a.rs", Some(2), Some(3)).unwrap();
        assert_eq!((rel.as_str(), start, lines, total), ("src/a.rs", 2, vec!["two".to_string(), "three".to_string()], 4));
        // Clipped to the file; absolute paths inside the folder are fine.
        let abs = std::fs::canonicalize(folder.join("src/a.rs")).unwrap();
        let (_, _, lines, _) = read_lines(&folder, abs.to_str().unwrap(), Some(3), Some(99)).unwrap();
        assert_eq!(lines, ["three", "four"]);
        let (_, _, lines, _) = read_lines(&folder, "src/a.rs", None, None).unwrap();
        assert_eq!(lines.len(), 4);
        // Escapes: `..`, an absolute path outside, a symlink out.
        assert!(read_lines(&folder, "../secret.txt", None, None).unwrap_err().to_string().contains("outside"));
        assert!(read_lines(&folder, "src/../../secret.txt", None, None).is_err());
        let outside = std::fs::canonicalize(dir.path().join("secret.txt")).unwrap();
        assert!(read_lines(&folder, outside.to_str().unwrap(), None, None).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(dir.path().join("secret.txt"), folder.join("link.txt")).unwrap();
            assert!(read_lines(&folder, "link.txt", None, None).is_err());
        }
        assert!(read_lines(&folder, "missing.rs", None, None).is_err());
        assert!(read_lines(&folder, "src", None, None).is_err());
        // A path that does not start at the folder: found when one file ends with it.
        assert_eq!(read_lines(&folder, "a.rs", None, None).unwrap().0, "src/a.rs");
        assert!(read_lines(&folder, "", None, None).is_err());
        assert!(read_lines(&folder, "bin.dat", None, None).unwrap_err().to_string().contains("binary"));
        assert!(read_lines(&folder, "latin1.txt", None, None).unwrap_err().to_string().contains("UTF-8"));
    }

    #[test]
    fn finds_a_file_by_the_end_of_its_path() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path();
        for p in ["crates/embed/src/tenants.rs", "crates/server/src/tenants.rs", "crates/server/src/system.rs", "node_modules/x/system.rs", ".git/system.rs"] {
            std::fs::create_dir_all(f.join(p).parent().unwrap()).unwrap();
            std::fs::write(f.join(p), "").unwrap();
        }
        assert_eq!(find_by_suffix(f, "embed/src/tenants.rs").unwrap(), "crates/embed/src/tenants.rs");
        assert_eq!(find_by_suffix(f, "system.rs").unwrap(), "crates/server/src/system.rs");
        assert!(find_by_suffix(f, "tenants.rs").unwrap_err().to_string().contains("2 files"));
        assert!(find_by_suffix(f, "bed/src/tenants.rs").is_err());
        assert!(find_by_suffix(f, "missing.rs").is_err());
    }

    fn sh(dir: &Path, args: &[&str]) {
        let out = std::process::Command::new("git").args(args).current_dir(dir).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    fn write(root: &Path, files: &[&str]) {
        for p in files {
            std::fs::create_dir_all(root.join(p).parent().unwrap()).unwrap();
            std::fs::write(root.join(p), "").unwrap();
        }
    }

    #[tokio::test]
    async fn lists_files_in_a_git_repo() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();
        sh(repo, &["init", "-q", "-b", "main"]);
        write(repo, &[".gitignore", "src/a.rs", "gone.rs", "app/x.ts", "app/new.ts", "app/debug.log", "outside.rs"]);
        std::fs::write(repo.join(".gitignore"), "*.log\n").unwrap();
        sh(repo, &["add", ".gitignore", "src/a.rs", "gone.rs", "app/x.ts"]);
        std::fs::remove_file(repo.join("gone.rs")).unwrap();
        assert_eq!(list_files(repo).await.unwrap(), [".gitignore", "app/new.ts", "app/x.ts", "outside.rs", "src/a.rs"]);
        // A subfolder: paths relative to it.
        assert_eq!(list_files(&repo.join("app")).await.unwrap(), ["new.ts", "x.ts"]);
        // Its prefix maps repo-relative paths (git status) to these.
        assert_eq!(crate::workspace::folder_prefix(&repo.join("app")).await, "app/");
        assert_eq!(crate::workspace::folder_prefix(repo).await, "");
    }

    #[tokio::test]
    async fn lists_files_without_git() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("proj");
        write(&f, &["b.txt", "src/a.rs", ".hidden/x", "node_modules/y/z.js", ".env"]);
        assert_eq!(list_files(&f).await.unwrap(), [".env", "b.txt", "src/a.rs"]);
        assert_eq!(crate::workspace::folder_prefix(&f).await, "");
    }
}
