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

/// The user's home folders, for `~/` paths and `sensitive`: `$HOME` first, then the account's home folder (from the
/// system user record) when it is a different folder. `$HOME` can be set to another folder than the account's. Missing
/// ones are skipped; two that are the same real folder count once.
pub fn homes() -> Vec<PathBuf> {
    let env = std::env::var_os("HOME").filter(|h| !h.is_empty()).map(PathBuf::from);
    let mut out: Vec<PathBuf> = Vec::new();
    let mut seen: Vec<PathBuf> = Vec::new();
    for h in env.into_iter().chain(account_home()) {
        if let Ok(real) = h.canonicalize()
            && !seen.contains(&real)
        {
            seen.push(real);
            out.push(h);
        }
    }
    out
}

/// The home folder of the user this process runs as, from the system user record (not `$HOME`).
#[cfg(unix)]
fn account_home() -> Option<PathBuf> {
    let user = nix::unistd::User::from_uid(nix::unistd::getuid()).ok()??;
    (!user.dir.as_os_str().is_empty()).then_some(user.dir)
}

#[cfg(not(unix))]
fn account_home() -> Option<PathBuf> {
    None
}

/// `path` with a leading `~/` (or a bare `~`) put under a home folder (`homes`, `$HOME` first): the first one where
/// that path exists, else the first one. Other paths as they are.
pub fn expand_home(path: &str, homes: &[PathBuf]) -> anyhow::Result<PathBuf> {
    match path.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => {
            let rest = rest.trim_start_matches('/');
            let first = homes.first().ok_or_else(|| crate::error::invalid(format!("{path}: no home folder")))?;
            let found = homes.iter().map(|h| h.join(rest)).find(|p| std::fs::symlink_metadata(p).is_ok());
            Ok(found.unwrap_or_else(|| first.join(rest)))
        }
        _ => Ok(PathBuf::from(path)),
    }
}

/// Key and keystore files, by extension (lower case).
const KEY_EXTENSIONS: &[&str] = &["pem", "key", "p12", "pfx", "ppk", "jks", "keystore", "kdbx", "asc", "gpg"];
/// Files that hold credentials, by name (lower case).
const CREDENTIAL_NAMES: &[&str] = &["credentials", "credentials.json", ".netrc", ".npmrc", ".pypirc"];

/// Why the file at `real` (a real path outside the Session's folder) can hold secrets, or `None`. `homes`: the real
/// home folders, the first one is `~`. Sensitive:
/// - `.env` and `.env.*` files; key files (`id_*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.ppk`, `*.jks`, `*.keystore`,
///   `*.kdbx`, `*.asc`, `*.gpg`); credential files (`credentials`, `credentials.json`, `.netrc`, `.npmrc`, `.pypirc`);
///   secret files (`secrets.*`, `*.secret`, `*.tfvars`). Names and extensions in any case, `.env` aside.
/// - anything outside all home folders, and anything under `Library` in a home folder (app data and settings).
/// - anything in a home folder with a part that starts with `.` (`~/.ssh/config`, `~/.zshrc`), except inside the
///   Agents' own folders (`agent_quirks::agent_home_folders`). There only Markdown files (`*.md`) are open; other files
///   and deeper hidden parts are sensitive.
///
/// When one home folder is inside another, each judges the parts up to the next deeper one, and the deepest judges
/// the rest. Any rule that matches locks the file.
pub fn sensitive(real: &Path, homes: &[PathBuf]) -> Option<String> {
    let name = real.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if name == ".env" || name.starts_with(".env.") {
        return Some("an .env file".into());
    }
    let lower = name.to_lowercase();
    let ext = real.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if name.starts_with("id_") || KEY_EXTENSIONS.contains(&ext.as_str()) {
        return Some("a key file".into());
    }
    if CREDENTIAL_NAMES.contains(&lower.as_str()) {
        return Some("a credentials file".into());
    }
    if lower.starts_with("secrets.") || ext == "secret" || ext == "tfvars" {
        return Some("a secrets file".into());
    }
    // Home folders that hold `real`, deepest first.
    let mut matching: Vec<(usize, &PathBuf)> = homes.iter().enumerate().filter(|(_, h)| real.starts_with(h)).collect();
    if matching.is_empty() {
        return Some("outside your home folder".into());
    }
    matching.sort_by_key(|(_, h)| std::cmp::Reverse(h.components().count()));
    let parts_of = |p: &Path| -> Vec<String> { p.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect() };
    let mut deeper: Option<&PathBuf> = None;
    for (i, home) in matching {
        let label = if i == 0 { "~".to_string() } else { home.to_string_lossy().replace('\\', "/") };
        let all = parts_of(real.strip_prefix(home).unwrap_or(real));
        // Parts up to the next deeper home folder: only folders, judged as such.
        let whole = deeper.is_none();
        let parts = match deeper.and_then(|d| d.strip_prefix(home).ok()) {
            Some(rel) => parts_of(rel),
            None => all,
        };
        deeper = Some(home);
        if parts.first().is_some_and(|p| p.eq_ignore_ascii_case("Library")) {
            return Some(format!("in {label}/Library (app data and settings)"));
        }
        let agent_folder = whole && parts.len() > 1 && crate::agent_quirks::agent_home_folders().contains(&parts[0].as_str());
        for (j, part) in parts.iter().enumerate() {
            let last = whole && j + 1 == parts.len();
            if !part.starts_with('.') || (j == 0 && agent_folder) {
                continue;
            }
            return Some(if last { "a hidden file".into() } else { format!("in the hidden folder {label}/{}", parts[..=j].join("/")) });
        }
        if agent_folder && ext != "md" {
            return Some(format!("a settings or data file in {label}/{}", parts[0]));
        }
    }
    None
}

/// Where `real` is for a Session whose real folder is `root`; `Err(reason)`: outside, can hold secrets
/// (`sensitive`) and not in `allowed` (the Session's approved real paths).
pub fn scope_of(root: &Path, real: &Path, homes: &[PathBuf], allowed: &[String]) -> Result<FileScope, String> {
    if real.starts_with(root) {
        return Ok(FileScope::Inside);
    }
    if allowed.iter().any(|a| Path::new(a) == real) {
        return Ok(FileScope::Allowed);
    }
    sensitive(real, homes).map_or(Ok(FileScope::Outside), Err)
}

/// The real path (symlinks followed) of `path`: relative to `root`, absolute, or `~/…`. A relative path that does not
/// exist may be the end of one in the folder (`find_by_suffix`).
fn real_path(root: &Path, path: &str, homes: &[PathBuf]) -> anyhow::Result<PathBuf> {
    let p = expand_home(path, homes)?;
    let full = root.join(&p);
    match full.canonicalize() {
        Ok(real) => Ok(real),
        Err(_) if p.is_relative() && !path.starts_with("..") && std::fs::symlink_metadata(&full).is_err() => {
            Ok(root.join(find_by_suffix(root, path)?).canonicalize()?)
        }
        Err(e) => Err(anyhow::anyhow!("{path}: {e}")),
    }
}

/// How a file is shown: relative to `root` inside it, `~/…` in the first home folder (`homes`: the real ones; `~` is
/// `$HOME` to Agents too), else absolute. `expand_home` reads a shown path back as the same file.
fn shown(root: &Path, real: &Path, homes: &[PathBuf]) -> String {
    let slash = |p: &Path| p.to_string_lossy().replace('\\', "/");
    if let Ok(rel) = real.strip_prefix(root) {
        return slash(rel);
    }
    match homes.first().and_then(|h| real.strip_prefix(h).ok()) {
        Some(rel) => format!("~/{}", slash(rel)),
        None => slash(real),
    }
}

/// The real paths of `homes` (in order; missing ones skipped, each once), for comparing with real paths.
fn real_homes(homes: &[PathBuf]) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for real in homes.iter().filter_map(|h| h.canonicalize().ok()) {
        if !out.contains(&real) {
            out.push(real);
        }
    }
    out
}

/// `path` (relative to `folder`, absolute or `~/…`) for "Open in editor"; `None` is the folder. A path outside the folder
/// that can hold secrets and is not in `allowed` fails with `NeedsApproval` (with the real path, `shown`).
pub fn resolve(folder: &Path, path: Option<&str>, homes: &[PathBuf], allowed: &[String]) -> anyhow::Result<PathBuf> {
    let root = std::fs::canonicalize(folder)?;
    let Some(p) = path.filter(|p| !p.trim().is_empty()) else { return Ok(root) };
    let real = real_path(&root, p, homes)?;
    let homes = real_homes(homes);
    scope_of(&root, &real, &homes, allowed).map_err(|r| crate::error::needs_approval(r, shown(&root, &real, &homes)))?;
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
pub fn approvable(folder: &Path, path: &str, homes: &[PathBuf]) -> anyhow::Result<String> {
    let root = std::fs::canonicalize(folder)?;
    let real = real_path(&root, path, homes)?;
    read_text(&real, path)?;
    if real.starts_with(&root) {
        return Err(crate::error::invalid(format!("{path} is in the Session's folder")));
    }
    Ok(real.to_string_lossy().into_owned())
}

/// The entries of `allowed` that are `path` (`RevokeSessionFile`): by its real path, or as written when it is gone
/// (`~/` under each real home folder, and with its parent folder's real path when that still exists).
pub fn revoked(folder: &Path, path: &str, homes: &[PathBuf], allowed: &[String]) -> Vec<String> {
    let root = std::fs::canonicalize(folder).unwrap_or_else(|_| folder.to_path_buf());
    let mut want = Vec::new();
    if let Ok(real) = real_path(&root, path, homes) {
        want.push(real);
    }
    let each: Vec<PathBuf> = homes.iter().map(|h| h.canonicalize().unwrap_or_else(|_| h.clone())).collect();
    let lists: Vec<&[PathBuf]> = if each.is_empty() { vec![&[]] } else { each.iter().map(std::slice::from_ref).collect() };
    for list in lists {
        let Ok(p) = expand_home(path, list) else { continue };
        let full = root.join(p);
        if let (Some(parent), Some(name)) = (full.parent(), full.file_name())
            && let Ok(dir) = parent.canonicalize()
        {
            want.push(dir.join(name));
        }
        want.push(full);
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
/// or `~/…` under a home folder, `expand_home`). Refuses files over `MAX_READ` and binary files. Also finds a relative `path` that does not
/// start at the folder (`embed/src/a.rs` for `crates/embed/src/a.rs`) when exactly one file ends with it (see
/// `find_by_suffix`). A readable file outside the folder that can hold secrets (`sensitive`) and is not in `allowed`
/// fails with `NeedsApproval`: the reason and the real path (`shown`) only, no lines, no line count.
pub fn read_lines(folder: &Path, path: &str, start: Option<u32>, end: Option<u32>, homes: &[PathBuf], allowed: &[String]) -> anyhow::Result<FileLines> {
    anyhow::ensure!(!path.trim().is_empty(), "no path");
    let root = std::fs::canonicalize(folder)?;
    let file = real_path(&root, path, homes)?;
    // Every check that can fail runs first: approval is only asked for a file that can be shown.
    let text = read_text(&file, path)?;
    let homes = real_homes(homes);
    let scope = scope_of(&root, &file, &homes, allowed).map_err(|r| crate::error::needs_approval(r, shown(&root, &file, &homes)))?;
    let all: Vec<&str> = text.lines().collect();
    let total = all.len() as u32;
    let start = start.unwrap_or(1).max(1);
    let end = end.unwrap_or(total).min(total);
    let lines = if start > end { vec![] } else { all[start as usize - 1..end as usize].iter().map(|l| l.to_string()).collect() };
    Ok(FileLines { path: shown(&root, &file, &homes), start, lines, total, scope })
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
        let home = [PathBuf::from("/h")];
        let s = |p: &str| sensitive(Path::new(p), &home);
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
            assert_eq!(sensitive(Path::new(key), &home).as_deref(), Some("a key file"), "{key}");
        }
        assert_eq!(s("/etc/hosts").as_deref(), Some("outside your home folder"));
        assert_eq!(s("/h/.claude/.env").as_deref(), Some("an .env file"));
    }

    #[test]
    fn locks_more_key_credential_and_secret_files() {
        let home = [PathBuf::from("/h")];
        let s = |p: &str| sensitive(Path::new(p), &home);
        for key in ["/h/code/a.ppk", "/h/code/app.jks", "/h/code/release.keystore", "/h/vault.KDBX", "/h/code/pub.asc", "/h/notes.gpg"] {
            assert_eq!(s(key).as_deref(), Some("a key file"), "{key}");
        }
        for f in ["/h/code/credentials", "/h/code/Credentials.json", "/h/code/.netrc", "/h/code/.npmrc", "/h/code/.pypirc"] {
            assert_eq!(s(f).as_deref(), Some("a credentials file"), "{f}");
        }
        for f in ["/h/code/secrets.yaml", "/h/code/Secrets.json", "/h/code/db.secret", "/h/code/prod.tfvars"] {
            assert_eq!(s(f).as_deref(), Some("a secrets file"), "{f}");
        }
        for f in ["/h/code/credentials.md", "/h/code/my-secrets.md", "/h/code/keys.md", "/h/code/secret.txt"] {
            assert_eq!(s(f), None, "{f}");
        }
    }

    #[test]
    fn locks_the_library_folder() {
        let home = [PathBuf::from("/h")];
        let s = |p: &str| sensitive(Path::new(p), &home);
        for f in ["/h/Library/Application Support/App/state.md", "/h/Library/Preferences/app.plist", "/h/library/notes.md"] {
            assert_eq!(s(f).as_deref(), Some("in ~/Library (app data and settings)"), "{f}");
        }
        assert_eq!(s("/h/code/Library/notes.md"), None);
        assert_eq!(s("/h/LibraryNotes/a.md"), None);
    }

    #[test]
    fn opens_only_markdown_in_the_agent_folders() {
        let home = [PathBuf::from("/h")];
        let s = |p: &str| sensitive(Path::new(p), &home);
        for f in ["/h/.agents/AGENTS.md", "/h/.agents/plans/a.md", "/h/.agents/notes/B.MD"] {
            assert_eq!(s(f), None, "{f}");
        }
        assert_eq!(s("/h/.agents/settings.json").as_deref(), Some("a settings or data file in ~/.agents"));
        assert_eq!(s("/h/.agents/history.jsonl").as_deref(), Some("a settings or data file in ~/.agents"));
        assert_eq!(s("/h/.agents/plans/notes").as_deref(), Some("a settings or data file in ~/.agents"));
        // Deeper hidden parts stay locked, also for Markdown.
        assert_eq!(s("/h/.agents/.cache/a.md").as_deref(), Some("in the hidden folder ~/.agents/.cache"));
        assert_eq!(s("/h/.agents/.hidden.md").as_deref(), Some("a hidden file"));
        // Other hidden folders: everything, Markdown too.
        assert_eq!(s("/h/.aws/notes.md").as_deref(), Some("in the hidden folder ~/.aws"));
        assert_eq!(s("/home2/x.md").as_deref(), Some("outside your home folder"));
        assert_eq!(sensitive(Path::new("/h/code/a.md"), &[]).as_deref(), Some("outside your home folder"));
    }

    #[test]
    fn expands_a_leading_tilde() {
        let home = [PathBuf::from("/h")];
        assert_eq!(expand_home("~/a/b.md", &home).unwrap(), Path::new("/h/a/b.md"));
        assert_eq!(expand_home("~", &home).unwrap(), Path::new("/h"));
        assert_eq!(expand_home("~x/a.md", &home).unwrap(), Path::new("~x/a.md"));
        assert_eq!(expand_home("src/~/a.md", &home).unwrap(), Path::new("src/~/a.md"));
        assert!(expand_home("~/a.md", &[]).is_err());
    }

    #[test]
    fn opens_paths_inside_and_outside_but_not_locked_ones() {
        let t = tree();
        put(&t.folder.join("src/a.rs"), b"");
        put(&t.home.join("notes/todo.md"), b"x");
        put(&t.top.join("secret.txt"), b"s");
        let home = std::slice::from_ref(&t.home);
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
        let read = |p: &str, s: Option<u32>, e: Option<u32>| read_lines(folder, p, s, e, std::slice::from_ref(&t.home), &[]);
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
        put(&t.home.join(".aws/config"), b"[default]\n");
        put(&t.home.join(".aws/blob.bin"), &[0u8, 1]);
        put(&t.top.join("secret.txt"), b"made-up secret\n");
        let read = |p: &str, allowed: &[String]| read_lines(folder, p, None, None, std::slice::from_ref(&t.home), allowed);

        // Outside, nothing secret: readable without approval, shown under `~/`.
        let f = read("~/notes/todo.md", &[]).unwrap();
        assert_eq!((f.path.as_str(), f.lines.len(), f.scope), ("~/notes/todo.md", 2, FileScope::Outside));
        assert_eq!(read("../notes/todo.md", &[]).unwrap().path, "~/notes/todo.md");
        let abs = t.home.join("notes/todo.md");
        assert_eq!(read(abs.to_str().unwrap(), &[]).unwrap().scope, FileScope::Outside);

        // Outside and secret: the reason only, no lines and no line count.
        let e = read("~/.aws/credentials", &[]).unwrap_err();
        let h = crate::api::HarnessError::from(e);
        assert_eq!((h.code, h.message.as_str()), (ErrorCode::NeedsApproval, "a credentials file"));
        let e = read("~/.aws/config", &[]).unwrap_err();
        assert_eq!(crate::api::HarnessError::from(e).message, "in the hidden folder ~/.aws");
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
        // The error names the real file an approval unlocks: `~/…` in the home folder, else absolute.
        let h = crate::api::HarnessError::from(read("~/.aws/credentials", &[]).unwrap_err());
        assert_eq!(h.path.as_deref(), Some("~/.aws/credentials"));
        let h = crate::api::HarnessError::from(read("../../secret.txt", &[]).unwrap_err());
        assert_eq!(h.path, Some(t.top.join("secret.txt").to_string_lossy().into_owned()));

        // Missing or binary: an ordinary error, never `NeedsApproval`.
        assert_ne!(code(read("~/.aws/missing", &[]).unwrap_err()), ErrorCode::NeedsApproval);
        assert_ne!(code(read("~/.aws/blob.bin", &[]).unwrap_err()), ErrorCode::NeedsApproval);
        assert_ne!(code(read("~/.aws", &[]).unwrap_err()), ErrorCode::NeedsApproval);

        // Approved: readable, by any path that leads to it; revoked: locked again.
        let real = approvable(folder, "~/.aws/credentials", std::slice::from_ref(&t.home)).unwrap();
        assert_eq!(real, t.home.join(".aws/credentials").to_string_lossy());
        let allowed = vec![real];
        let f = read("~/.aws/credentials", &allowed).unwrap();
        assert_eq!((f.path.as_str(), f.lines, f.scope), ("~/.aws/credentials", vec!["key = made-up-value".to_string()], FileScope::Allowed));
        #[cfg(unix)]
        assert_eq!(read("link.txt", &allowed).unwrap().scope, FileScope::Allowed);
        assert_eq!(revoked(folder, "~/.aws/credentials", std::slice::from_ref(&t.home), &allowed), allowed);
        assert!(revoked(folder, "~/notes/todo.md", std::slice::from_ref(&t.home), &allowed).is_empty());
        let left: Vec<String> =
            allowed.iter().filter(|a| !revoked(folder, "~/.aws/credentials", std::slice::from_ref(&t.home), &allowed).contains(a)).cloned().collect();
        assert_eq!(code(read("~/.aws/credentials", &left).unwrap_err()), ErrorCode::NeedsApproval);
        // A file that is gone can still be revoked by its path.
        std::fs::remove_file(t.home.join(".aws/credentials")).unwrap();
        assert_eq!(revoked(folder, "~/.aws/credentials", std::slice::from_ref(&t.home), &allowed), allowed);

        // Only readable files outside the folder can be approved.
        assert!(approvable(folder, "~/.aws/blob.bin", std::slice::from_ref(&t.home)).is_err());
        assert!(approvable(folder, "~/.aws/missing", std::slice::from_ref(&t.home)).is_err());
        put(&folder.join("src/a.rs"), b"x");
        assert!(approvable(folder, "src/a.rs", std::slice::from_ref(&t.home)).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_in_the_folder_needs_approval_of_the_file_it_leads_to() {
        use crate::api::{ErrorCode, HarnessError};
        let t = tree();
        put(&t.home.join(".zshrc"), b"export MADE_UP=1\n");
        std::fs::create_dir_all(t.folder.join("docs")).unwrap();
        std::os::unix::fs::symlink(t.home.join(".zshrc"), t.folder.join("docs/notes.md")).unwrap();
        let home = std::slice::from_ref(&t.home);
        for e in [read_lines(&t.folder, "docs/notes.md", None, None, home, &[]).unwrap_err(), resolve(&t.folder, Some("docs/notes.md"), home, &[]).unwrap_err()]
        {
            let h = HarnessError::from(e);
            assert_eq!((h.code, h.message.as_str(), h.path.as_deref()), (ErrorCode::NeedsApproval, "a hidden file", Some("~/.zshrc")));
        }
        // Approving the path the error names unlocks the link too.
        let allowed = vec![approvable(&t.folder, "~/.zshrc", home).unwrap()];
        assert_eq!(read_lines(&t.folder, "docs/notes.md", None, None, home, &allowed).unwrap().scope, FileScope::Allowed);
    }

    #[cfg(unix)]
    #[test]
    fn revokes_a_gone_file_under_a_symlinked_home() {
        let t = tree();
        // `$HOME` is a symlink to the real home folder; `~/.aws` a symlink to `~/dotfiles/aws`.
        let link_home = t.top.join("home-link");
        std::os::unix::fs::symlink(&t.home, &link_home).unwrap();
        put(&t.home.join(".ssh/key.txt"), b"made-up\n");
        put(&t.home.join("dotfiles/aws/credentials"), b"made-up\n");
        std::os::unix::fs::symlink(t.home.join("dotfiles/aws"), t.home.join(".aws")).unwrap();
        let home = std::slice::from_ref(&link_home);
        let allowed = vec![approvable(&t.folder, "~/.ssh/key.txt", home).unwrap(), approvable(&t.folder, "~/.aws/credentials", home).unwrap()];
        assert_eq!(allowed, [t.home.join(".ssh/key.txt").to_string_lossy(), t.home.join("dotfiles/aws/credentials").to_string_lossy()]);
        std::fs::remove_file(t.home.join(".ssh/key.txt")).unwrap();
        std::fs::remove_file(t.home.join("dotfiles/aws/credentials")).unwrap();
        assert_eq!(revoked(&t.folder, "~/.ssh/key.txt", home, &allowed), [allowed[0].clone()]);
        assert_eq!(revoked(&t.folder, "~/.aws/credentials", home, &allowed), [allowed[1].clone()]);
    }

    #[test]
    fn judges_files_under_two_home_folders() {
        // `$HOME` (first) set to a folder inside the account's home folder.
        let homes = [PathBuf::from("/u/personal"), PathBuf::from("/u")];
        let s = |p: &str| sensitive(Path::new(p), &homes);
        for f in ["/u/personal/notes.md", "/u/code/AGENTS.md", "/u/personal/.claude/CLAUDE.md", "/u/.agents/plans/a.md"] {
            assert_eq!(s(f), None, "{f}");
        }
        assert_eq!(s("/u/personal/.ssh/key.txt").as_deref(), Some("in the hidden folder ~/.ssh"));
        assert_eq!(s("/u/.ssh/key.txt").as_deref(), Some("in the hidden folder /u/.ssh"));
        assert_eq!(s("/u/personal/.zshrc").as_deref(), Some("a hidden file"));
        assert_eq!(s("/u/.zshrc").as_deref(), Some("a hidden file"));
        assert_eq!(s("/u/personal/Library/a.md").as_deref(), Some("in ~/Library (app data and settings)"));
        assert_eq!(s("/u/Library/a.md").as_deref(), Some("in /u/Library (app data and settings)"));
        assert_eq!(s("/u/personal/.claude/settings.json").as_deref(), Some("a settings or data file in ~/.claude"));
        assert_eq!(s("/etc/hosts").as_deref(), Some("outside your home folder"));
        // The outer home folder still judges the parts up to the inner one.
        let hidden = [PathBuf::from("/u/.home"), PathBuf::from("/u")];
        assert_eq!(sensitive(Path::new("/u/.home/notes.md"), &hidden).as_deref(), Some("in the hidden folder /u/.home"));
        // Order does not change the outcome, only which home folder is `~`.
        let swapped = [PathBuf::from("/u"), PathBuf::from("/u/personal")];
        assert_eq!(sensitive(Path::new("/u/personal/.ssh/key.txt"), &swapped).as_deref(), Some("in the hidden folder /u/personal/.ssh"));
        assert_eq!(sensitive(Path::new("/u/personal/notes.md"), &swapped), None);
    }

    #[test]
    fn reads_files_under_the_account_home_folder_when_home_is_set_elsewhere() {
        use crate::api::{ErrorCode, HarnessError};
        let t = tree();
        // `t.home` is the account's home folder; `$HOME` is `t.home/personal`, the Session folder is in it.
        let env_home = t.home.join("personal");
        let folder = env_home.join("proj");
        std::fs::create_dir_all(&folder).unwrap();
        let homes = [env_home.clone(), t.home.clone()];
        put(&t.home.join("code/app/AGENTS.md"), b"made-up\n");
        put(&env_home.join("notes/todo.md"), b"made-up\n");
        put(&t.home.join(".ssh/key.txt"), b"made-up\n");
        put(&env_home.join(".ssh/key.txt"), b"made-up\n");
        put(&t.top.join("secret.txt"), b"made-up\n");
        let read = |p: &str, allowed: &[String]| read_lines(&folder, p, None, None, &homes, allowed);

        // `~/x` falls back to the account's home folder when `$HOME` has no `x`; shown absolute, so it reads back.
        let account_file = t.home.join("code/app/AGENTS.md");
        assert_eq!(expand_home("~/code/app/AGENTS.md", &homes).unwrap(), account_file);
        assert_eq!(expand_home("~/missing.md", &homes).unwrap(), env_home.join("missing.md"));
        let f = read("~/code/app/AGENTS.md", &[]).unwrap();
        assert_eq!((f.path.as_str(), f.scope), (account_file.to_str().unwrap(), FileScope::Outside));
        assert_eq!(read(account_file.to_str().unwrap(), &[]).unwrap().scope, FileScope::Outside);
        // Under `$HOME`: `~/…`.
        assert_eq!(read("~/notes/todo.md", &[]).unwrap().path, "~/notes/todo.md");

        // Hidden folders under either home folder are locked; outside both too.
        let h = HarnessError::from(read("~/.ssh/key.txt", &[]).unwrap_err());
        assert_eq!((h.code, h.message.as_str(), h.path.as_deref()), (ErrorCode::NeedsApproval, "in the hidden folder ~/.ssh", Some("~/.ssh/key.txt")));
        let outer = t.home.join(".ssh/key.txt");
        let h = HarnessError::from(read(outer.to_str().unwrap(), &[]).unwrap_err());
        let want = format!("in the hidden folder {}/.ssh", t.home.display());
        assert_eq!((h.code, h.message.as_str(), h.path.as_deref()), (ErrorCode::NeedsApproval, want.as_str(), outer.to_str()));
        let h = HarnessError::from(read(t.top.join("secret.txt").to_str().unwrap(), &[]).unwrap_err());
        assert_eq!((h.code, h.message.as_str()), (ErrorCode::NeedsApproval, "outside your home folder"));

        // A file found under the account's home folder can be approved and, once gone, revoked by the same path.
        put(&t.home.join("code/prod.tfvars"), b"made-up\n");
        let allowed = vec![approvable(&folder, "~/code/prod.tfvars", &homes).unwrap()];
        assert_eq!(allowed, [t.home.join("code/prod.tfvars").to_string_lossy()]);
        assert_eq!(read("~/code/prod.tfvars", &allowed).unwrap().scope, FileScope::Allowed);
        std::fs::remove_file(t.home.join("code/prod.tfvars")).unwrap();
        assert_eq!(revoked(&folder, "~/code/prod.tfvars", &homes, &allowed), allowed);
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
