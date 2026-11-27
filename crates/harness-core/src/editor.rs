//! "Open in editor": the user's editor (kept in `<data dir>/editor.json`) opens a Session's folder,
//! or a file at a line, through the editor's URL scheme. Also reads lines of files for file refs. Files outside the
//! folder that can hold secrets (`sensitive`) need the user's approval per Session first.

use std::path::{Path, PathBuf};

use crate::api::{Editor, FileScope};

pub fn load(data_dir: &Path) -> Option<Editor> {
    file(data_dir).load_logged()
}

fn file(data_dir: &Path) -> crate::persist::JsonFile<Editor> {
    crate::persist::JsonFile::in_dir(data_dir, "editor.json")
}

pub fn save(data_dir: &Path, editor: Option<&Editor>) -> anyhow::Result<()> {
    match editor {
        Some(e) => file(data_dir).save(e)?,
        None => file(data_dir).remove(),
    }
    Ok(())
}

/// The user's home folder (`$HOME`), for `~/` paths and `sensitive`.
pub fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").filter(|h| !h.is_empty()).map(PathBuf::from)
}

/// `path` with a leading `~/` (or a bare `~`) put under `home`; other paths as they are.
pub fn expand_home(path: &str, home: Option<&Path>) -> anyhow::Result<PathBuf> {
    match path.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => {
            let home = home.ok_or_else(|| crate::error::invalid(format!("{path}: no home folder")))?;
            Ok(home.join(rest.trim_start_matches('/')))
        }
        _ => Ok(PathBuf::from(path)),
    }
}

/// Why the file at `real` (a real path outside the Session's folder) can hold secrets, or `None`. `home`: the real
/// home folder. Sensitive: `.env` and `.env.*` files, key files (`id_*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`), anything
/// outside the home folder, and anything in the home folder with a part that starts with `.` (`~/.ssh/config`,
/// `~/.zshrc`), except inside the Agents' own folders (`agent_quirks::agent_home_folders`; there, only deeper hidden parts
/// count).
pub fn sensitive(real: &Path, home: Option<&Path>) -> Option<String> {
    let name = real.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if name == ".env" || name.starts_with(".env.") {
        return Some("an .env file".into());
    }
    let ext = real.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if name.starts_with("id_") || ["pem", "key", "p12", "pfx"].contains(&ext.as_str()) {
        return Some("a key file".into());
    }
    let Some(rel) = home.and_then(|h| real.strip_prefix(h).ok()) else {
        return Some("outside your home folder".into());
    };
    let parts: Vec<String> = rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
    for (i, part) in parts.iter().enumerate() {
        let last = i + 1 == parts.len();
        if !part.starts_with('.') || (i == 0 && !last && crate::agent_quirks::agent_home_folders().contains(&part.as_str())) {
            continue;
        }
        return Some(if last { "a hidden file".into() } else { format!("in the hidden folder ~/{}", parts[..=i].join("/")) });
    }
    None
}

/// Where `real` is for a Session whose real folder is `root`; `Err(reason)`: outside, can hold secrets
/// (`sensitive`) and not in `allowed` (the Session's approved real paths).
pub fn scope_of(root: &Path, real: &Path, home: Option<&Path>, allowed: &[String]) -> Result<FileScope, String> {
    if real.starts_with(root) {
        return Ok(FileScope::Inside);
    }
    if allowed.iter().any(|a| Path::new(a) == real) {
        return Ok(FileScope::Allowed);
    }
    sensitive(real, home).map_or(Ok(FileScope::Outside), Err)
}

/// The real path (symlinks followed) of `path`: relative to `root`, absolute, or `~/…`. A relative path that does not
/// exist may be the end of one in the folder (`find_by_suffix`).
fn real_path(root: &Path, path: &str, home: Option<&Path>) -> anyhow::Result<PathBuf> {
    let p = expand_home(path, home)?;
    let full = root.join(&p);
    match full.canonicalize() {
        Ok(real) => Ok(real),
        Err(_) if p.is_relative() && !path.starts_with("..") && std::fs::symlink_metadata(&full).is_err() => {
            Ok(root.join(find_by_suffix(root, path)?).canonicalize()?)
        }
        Err(e) => Err(anyhow::anyhow!("{path}: {e}")),
    }
}

/// How a file is shown: relative to `root` inside it, `~/…` in the home folder, else absolute.
fn shown(root: &Path, real: &Path, home: Option<&Path>) -> String {
    let slash = |p: &Path| p.to_string_lossy().replace('\\', "/");
    if let Ok(rel) = real.strip_prefix(root) {
        return slash(rel);
    }
    match home.and_then(|h| real.strip_prefix(h).ok()) {
        Some(rel) => format!("~/{}", slash(rel)),
        None => slash(real),
    }
}

/// The real home folder, for comparing with real paths.
fn real_home(home: Option<&Path>) -> Option<PathBuf> {
    home.and_then(|h| h.canonicalize().ok())
}

/// `path` (relative to `folder`, absolute or `~/…`) for "Open in editor"; `None` is the folder. A path outside the folder
/// that can hold secrets and is not in `allowed` fails with `NeedsApproval`.
pub fn resolve(folder: &Path, path: Option<&str>, home: Option<&Path>, allowed: &[String]) -> anyhow::Result<PathBuf> {
    let root = std::fs::canonicalize(folder)?;
    let Some(p) = path.filter(|p| !p.trim().is_empty()) else { return Ok(root) };
    let real = real_path(&root, p, home)?;
    scope_of(&root, &real, real_home(home).as_deref(), allowed).map_err(crate::error::needs_approval)?;
    Ok(real)
}

/// The text of `file`: a file up to `MAX_READ`, not binary, UTF-8. `path` names it in errors.
fn read_text(file: &Path, path: &str) -> anyhow::Result<String> {
    let meta = std::fs::metadata(file)?;
    anyhow::ensure!(meta.is_file(), "{path} is not a file");
    anyhow::ensure!(meta.len() <= MAX_READ, "{path} is too large");
    let bytes = std::fs::read(file)?;
    anyhow::ensure!(!bytes.contains(&0), "{path} is a binary file");
    String::from_utf8(bytes).map_err(|_| anyhow::anyhow!("{path} is not UTF-8 text"))
}

/// The real path of a text file outside `folder` to put on the Session's allow list (`ApproveSessionFile`).
pub fn approvable(folder: &Path, path: &str, home: Option<&Path>) -> anyhow::Result<String> {
    let root = std::fs::canonicalize(folder)?;
    let real = real_path(&root, path, home)?;
    read_text(&real, path)?;
    if real.starts_with(&root) {
        return Err(crate::error::invalid(format!("{path} is in the Session's folder")));
    }
    Ok(real.to_string_lossy().into_owned())
}

/// The entries of `allowed` that are `path` (`RevokeSessionFile`): by its real path, or as written when it is gone.
pub fn revoked(folder: &Path, path: &str, home: Option<&Path>, allowed: &[String]) -> Vec<String> {
    let root = std::fs::canonicalize(folder).unwrap_or_else(|_| folder.to_path_buf());
    let mut want = Vec::new();
    if let Ok(real) = real_path(&root, path, home) {
        want.push(real);
    }
    if let Ok(p) = expand_home(path, home) {
        want.push(root.join(p));
    }
    allowed.iter().filter(|a| want.iter().any(|w| w == Path::new(a))).cloned().collect()
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

/// Lines of a file read for a Session (`read_lines`).
#[derive(Debug, PartialEq)]
pub struct FileLines {
    /// Relative to the folder when `scope` is `Inside`, else `~/…` in the home folder, else absolute.
    pub path: String,
    /// First line's number (1-based).
    pub start: u32,
    pub lines: Vec<String>,
    /// The file's line count.
    pub total: u32,
    pub scope: FileScope,
}

/// Lines `start..=end` (1-based, clipped to the file) of the UTF-8 text file `path` (relative to `folder`, absolute,
/// or `~/…` under `home`). Refuses files over `MAX_READ` and binary files. Also finds a relative `path` that does not
/// start at the folder (`embed/src/a.rs` for `crates/embed/src/a.rs`) when exactly one file ends with it (see
/// `find_by_suffix`). A readable file outside the folder that can hold secrets (`sensitive`) and is not in `allowed`
/// fails with `NeedsApproval` and the reason only: no lines, no line count.
pub fn read_lines(folder: &Path, path: &str, start: Option<u32>, end: Option<u32>, home: Option<&Path>, allowed: &[String]) -> anyhow::Result<FileLines> {
    anyhow::ensure!(!path.trim().is_empty(), "no path");
    let root = std::fs::canonicalize(folder)?;
    let file = real_path(&root, path, home)?;
    // Every check that can fail runs first: approval is only asked for a file that can be shown.
    let text = read_text(&file, path)?;
    let home = real_home(home);
    let scope = scope_of(&root, &file, home.as_deref(), allowed).map_err(crate::error::needs_approval)?;
    let all: Vec<&str> = text.lines().collect();
    let total = all.len() as u32;
    let start = start.unwrap_or(1).max(1);
    let end = end.unwrap_or(total).min(total);
    let lines = if start > end { vec![] } else { all[start as usize - 1..end as usize].iter().map(|l| l.to_string()).collect() };
    Ok(FileLines { path: shown(&root, &file, home.as_deref()), start, lines, total, scope })
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
    if !complete {
        return Err(crate::error::not_found(format!("{suffix}: No such file (folder too large to search)")));
    }
    match found.len() {
        0 => Err(crate::error::not_found(format!("{suffix}: No such file"))),
        1 => Ok(found.swap_remove(0)),
        n => anyhow::bail!("{suffix}: {n} files match"),
    }
}

/// Files in `folder` (relative, `/` separators, sorted, at most `MAX_SCAN`). In a git repository: tracked and
/// untracked files that `.gitignore` does not exclude and that exist on disk. Elsewhere: the files `walk_files` finds.
pub async fn list_files(folder: &Path) -> anyhow::Result<Vec<String>> {
    let tracked = crate::git::git(folder, &["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).await;
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
pub async fn open(target: &str) -> anyhow::Result<()> {
    let opts = crate::proc::Opts::new(crate::proc::LOCAL);
    let (program, opts) = if cfg!(target_os = "macos") {
        ("open", opts.arg(target))
    } else if cfg!(windows) {
        ("cmd", opts.args(["/C", "start", "", target]))
    } else {
        ("xdg-open", opts.arg(target))
    };
    let out = crate::proc::run(program, opts).await.map_err(|e| anyhow::anyhow!("could not open {target}: {e}"))?;
    anyhow::ensure!(out.success(), "could not open {target}: is the editor installed?");
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

    #[test]
    fn editor_file_round_trips_and_a_corrupt_one_reads_as_unset() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("editor.json"), r#"{"type":"custom","template":"x://{path}"}"#).unwrap();
        assert_eq!(load(d.path()), Some(Editor::Custom { template: "x://{path}".into() }));
        save(d.path(), Some(&Editor::Zed)).unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&std::fs::read(d.path().join("editor.json")).unwrap()).unwrap(),
            serde_json::json!({"type": "zed"})
        );
        std::fs::write(d.path().join("editor.json"), b"{oops").unwrap();
        assert_eq!(load(d.path()), None);
        assert!(std::fs::read_dir(d.path()).unwrap().flatten().any(|e| e.file_name().to_string_lossy().starts_with("editor.json.corrupt-")));
        save(d.path(), None).unwrap();
    }
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

    /// A temp dir with `home/proj` (the Session folder) and `home` as the home folder. Real paths.
    struct Tree {
        _dir: tempfile::TempDir,
        top: PathBuf,
        home: PathBuf,
        folder: PathBuf,
    }

    fn tree() -> Tree {
        let dir = tempfile::tempdir().unwrap();
        let top = std::fs::canonicalize(dir.path()).unwrap();
        let home = top.join("home");
        let folder = home.join("proj");
        std::fs::create_dir_all(folder.join("src")).unwrap();
        Tree { _dir: dir, top, home, folder }
    }

    fn put(path: &Path, text: &[u8]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn code(e: anyhow::Error) -> crate::api::ErrorCode {
        crate::api::HarnessError::from(e).code
    }

    #[test]
    fn classifies_files_that_can_hold_secrets() {
        let home = Path::new("/h");
        let s = |p: &str| sensitive(Path::new(p), Some(home));
        assert_eq!(s("/h/code/notes.md"), None);
        assert_eq!(s("/h/.claude/CLAUDE.md"), None);
        assert_eq!(s("/h/.agents/plans/a.md"), None);
        assert_eq!(s("/h/.aws/config").as_deref(), Some("in the hidden folder ~/.aws"));
        assert_eq!(s("/h/.config/app/settings.json").as_deref(), Some("in the hidden folder ~/.config"));
        assert_eq!(s("/h/code/.secret/a.txt").as_deref(), Some("in the hidden folder ~/code/.secret"));
        assert_eq!(s("/h/.claude/.credentials.json").as_deref(), Some("a hidden file"));
        assert_eq!(s("/h/.zshrc").as_deref(), Some("a hidden file"));
        assert_eq!(s("/h/.claude").as_deref(), Some("a hidden file"));
        assert_eq!(s("/h/code/.env").as_deref(), Some("an .env file"));
        assert_eq!(s("/h/.claude/.env.local").as_deref(), Some("an .env file"));
        assert_eq!(s("/h/code/.envrc").as_deref(), Some("a hidden file"));
        for key in ["/h/code/id_ed25519", "/h/code/id_rsa.pub", "/h/code/server.pem", "/h/code/tls.KEY", "/h/a.p12", "/h/a.pfx"] {
            assert_eq!(sensitive(Path::new(key), Some(home)).as_deref(), Some("a key file"), "{key}");
        }
        assert_eq!(s("/etc/hosts").as_deref(), Some("outside your home folder"));
        assert_eq!(s("/home2/x.md").as_deref(), Some("outside your home folder"));
        assert_eq!(sensitive(Path::new("/h/code/a.md"), None).as_deref(), Some("outside your home folder"));
    }

    #[test]
    fn expands_a_leading_tilde() {
        let home = Path::new("/h");
        assert_eq!(expand_home("~/a/b.md", Some(home)).unwrap(), Path::new("/h/a/b.md"));
        assert_eq!(expand_home("~", Some(home)).unwrap(), Path::new("/h"));
        assert_eq!(expand_home("~x/a.md", Some(home)).unwrap(), Path::new("~x/a.md"));
        assert_eq!(expand_home("src/~/a.md", Some(home)).unwrap(), Path::new("src/~/a.md"));
        assert!(expand_home("~/a.md", None).is_err());
    }

    #[test]
    fn opens_paths_inside_and_outside_but_not_locked_ones() {
        let t = tree();
        put(&t.folder.join("src/a.rs"), b"");
        put(&t.home.join("notes/todo.md"), b"x");
        put(&t.top.join("secret.txt"), b"s");
        let home = Some(t.home.as_path());
        assert_eq!(resolve(&t.folder, None, home, &[]).unwrap(), t.folder);
        assert_eq!(resolve(&t.folder, Some("src/a.rs"), home, &[]).unwrap(), t.folder.join("src/a.rs"));
        assert_eq!(resolve(&t.folder, Some("~/notes/todo.md"), home, &[]).unwrap(), t.home.join("notes/todo.md"));
        let e = resolve(&t.folder, Some("../../secret.txt"), home, &[]).unwrap_err();
        assert_eq!(code(e), crate::api::ErrorCode::NeedsApproval);
        let allowed = [t.top.join("secret.txt").to_string_lossy().into_owned()];
        assert_eq!(resolve(&t.folder, Some("../../secret.txt"), home, &allowed).unwrap(), t.top.join("secret.txt"));
        assert!(resolve(&t.folder, Some("missing.rs"), home, &[]).is_err());
    }

    #[test]
    fn reads_lines_inside_the_folder() {
        let t = tree();
        let folder = &t.folder;
        put(&folder.join("src/a.rs"), b"one\ntwo\nthree\nfour\n");
        put(&folder.join("bin.dat"), &[0u8, 1, 2]);
        put(&folder.join("latin1.txt"), &[0xE9u8, b'a']);
        let read = |p: &str, s: Option<u32>, e: Option<u32>| read_lines(folder, p, s, e, Some(&t.home), &[]);
        let f = read("src/a.rs", Some(2), Some(3)).unwrap();
        assert_eq!(f, FileLines { path: "src/a.rs".into(), start: 2, lines: vec!["two".into(), "three".into()], total: 4, scope: FileScope::Inside });
        // Clipped to the file; absolute paths inside the folder are fine.
        let abs = folder.join("src/a.rs");
        assert_eq!(read(abs.to_str().unwrap(), Some(3), Some(99)).unwrap().lines, ["three", "four"]);
        assert_eq!(read("src/a.rs", None, None).unwrap().lines.len(), 4);
        assert_eq!(read("~/proj/src/a.rs", None, None).unwrap().path, "src/a.rs");
        assert!(read("missing.rs", None, None).is_err());
        assert!(read("src", None, None).is_err());
        // A path that does not start at the folder: found when one file ends with it.
        assert_eq!(read("a.rs", None, None).unwrap().path, "src/a.rs");
        assert!(read("", None, None).is_err());
        assert!(read("bin.dat", None, None).unwrap_err().to_string().contains("binary"));
        assert!(read("latin1.txt", None, None).unwrap_err().to_string().contains("UTF-8"));
    }

    #[test]
    fn reads_outside_files_only_when_they_hold_no_secrets_or_are_allowed() {
        use crate::api::ErrorCode;
        let t = tree();
        let folder = &t.folder;
        put(&t.home.join("notes/todo.md"), b"a\nb\n");
        put(&t.home.join(".aws/credentials"), b"key = made-up-value\n");
        put(&t.home.join(".aws/blob.bin"), &[0u8, 1]);
        put(&t.top.join("secret.txt"), b"made-up secret\n");
        let read = |p: &str, allowed: &[String]| read_lines(folder, p, None, None, Some(&t.home), allowed);

        // Outside, nothing secret: readable without approval, shown under `~/`.
        let f = read("~/notes/todo.md", &[]).unwrap();
        assert_eq!((f.path.as_str(), f.lines.len(), f.scope), ("~/notes/todo.md", 2, FileScope::Outside));
        assert_eq!(read("../notes/todo.md", &[]).unwrap().path, "~/notes/todo.md");
        let abs = t.home.join("notes/todo.md");
        assert_eq!(read(abs.to_str().unwrap(), &[]).unwrap().scope, FileScope::Outside);

        // Outside and secret: the reason only, no lines and no line count.
        let e = read("~/.aws/credentials", &[]).unwrap_err();
        let h = crate::api::HarnessError::from(e);
        assert_eq!((h.code, h.message.as_str()), (ErrorCode::NeedsApproval, "in the hidden folder ~/.aws"));
        // Escapes out of the home folder: `..`, an absolute path, a symlink in the folder (judged by its real path).
        for p in ["../../secret.txt", "src/../../../secret.txt", t.top.join("secret.txt").to_str().unwrap()] {
            let h = crate::api::HarnessError::from(read(p, &[]).unwrap_err());
            assert_eq!((h.code, h.message.as_str()), (ErrorCode::NeedsApproval, "outside your home folder"), "{p}");
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(t.home.join(".aws/credentials"), folder.join("link.txt")).unwrap();
            assert_eq!(code(read("link.txt", &[]).unwrap_err()), ErrorCode::NeedsApproval);
        }

        // Missing or binary: an ordinary error, never `NeedsApproval`.
        assert_ne!(code(read("~/.aws/missing", &[]).unwrap_err()), ErrorCode::NeedsApproval);
        assert_ne!(code(read("~/.aws/blob.bin", &[]).unwrap_err()), ErrorCode::NeedsApproval);
        assert_ne!(code(read("~/.aws", &[]).unwrap_err()), ErrorCode::NeedsApproval);

        // Approved: readable, by any path that leads to it; revoked: locked again.
        let real = approvable(folder, "~/.aws/credentials", Some(&t.home)).unwrap();
        assert_eq!(real, t.home.join(".aws/credentials").to_string_lossy());
        let allowed = vec![real];
        let f = read("~/.aws/credentials", &allowed).unwrap();
        assert_eq!((f.path.as_str(), f.lines, f.scope), ("~/.aws/credentials", vec!["key = made-up-value".to_string()], FileScope::Allowed));
        #[cfg(unix)]
        assert_eq!(read("link.txt", &allowed).unwrap().scope, FileScope::Allowed);
        assert_eq!(revoked(folder, "~/.aws/credentials", Some(&t.home), &allowed), allowed);
        assert!(revoked(folder, "~/notes/todo.md", Some(&t.home), &allowed).is_empty());
        let left: Vec<String> = allowed.iter().filter(|a| !revoked(folder, "~/.aws/credentials", Some(&t.home), &allowed).contains(a)).cloned().collect();
        assert_eq!(code(read("~/.aws/credentials", &left).unwrap_err()), ErrorCode::NeedsApproval);
        // A file that is gone can still be revoked by its path.
        std::fs::remove_file(t.home.join(".aws/credentials")).unwrap();
        assert_eq!(revoked(folder, "~/.aws/credentials", Some(&t.home), &allowed), allowed);

        // Only readable files outside the folder can be approved.
        assert!(approvable(folder, "~/.aws/blob.bin", Some(&t.home)).is_err());
        assert!(approvable(folder, "~/.aws/missing", Some(&t.home)).is_err());
        put(&folder.join("src/a.rs"), b"x");
        assert!(approvable(folder, "src/a.rs", Some(&t.home)).is_err());
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
        assert_eq!(crate::git::folder_prefix(&repo.join("app")).await, "app/");
        assert_eq!(crate::git::folder_prefix(repo).await, "");
    }

    #[tokio::test]
    async fn lists_files_without_git() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("proj");
        write(&f, &["b.txt", "src/a.rs", ".hidden/x", "node_modules/y/z.js", ".env"]);
        assert_eq!(list_files(&f).await.unwrap(), [".env", "b.txt", "src/a.rs"]);
        assert_eq!(crate::git::folder_prefix(&f).await, "");
    }
}
