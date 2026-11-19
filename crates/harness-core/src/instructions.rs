//! Custom Instructions: text the user writes for every Session (Global) or for the Sessions of
//! one repository, added to the `<harness_context>` (ADR 0014 addendum). Kept in
//! `<data dir>/instructions/`: `global.md` and `repos/<encoded folder>.md`, never in the
//! repository. A repository is its main checkout's folder, so all its Worktrees share one file
//! and its git remote does not matter; a folder outside git is its own key.

use std::path::{Path, PathBuf};

use crate::api::{InstructionsEntry, InstructionsScope};

pub const DIR: &str = "instructions";

/// Longest file name we write (most file systems allow 255 bytes).
const MAX_NAME: usize = 250;

pub struct Instructions {
    dir: PathBuf,
    /// `<data dir>/quick`: Quick Session folders, scratch space with no instructions of their own.
    quick: PathBuf,
}

impl Instructions {
    pub fn new(data_dir: &Path) -> Self {
        Self { dir: data_dir.join(DIR), quick: data_dir.join("quick") }
    }

    /// Whose Custom Instructions a Session gets (`SessionMeta::instructions_folder`). None in a
    /// Quick Session's folder, also for the Sub Sessions its Agent starts there.
    pub fn folder_of(&self, meta: &crate::session::SessionMeta) -> Option<PathBuf> {
        // Quick folders are canonical (`create_quick`); the data dir may not be.
        let canonical = std::fs::canonicalize(&self.quick).unwrap_or_else(|_| self.quick.clone());
        meta.instructions_folder().filter(|f| !f.starts_with(&self.quick) && !f.starts_with(&canonical))
    }

    fn repos(&self) -> PathBuf {
        self.dir.join("repos")
    }

    fn file(&self, scope: &InstructionsScope) -> anyhow::Result<PathBuf> {
        match scope {
            InstructionsScope::Global => Ok(self.dir.join("global.md")),
            InstructionsScope::Repo { path } => {
                anyhow::ensure!(Path::new(path).is_absolute(), crate::error::invalid(format!("{path}: not an absolute path")));
                let name = format!("{}.md", encode(path));
                anyhow::ensure!(name.len() <= MAX_NAME, crate::error::invalid(format!("{path}: path too long")));
                Ok(self.repos().join(name))
            }
        }
    }

    /// The saved text, trimmed; `None` when there is none.
    pub fn get(&self, scope: &InstructionsScope) -> Option<String> {
        let text = std::fs::read_to_string(self.file(scope).ok()?).ok()?;
        Some(text.trim().to_owned()).filter(|t| !t.is_empty())
    }

    /// Saves `text`; empty (or only whitespace) deletes the file.
    pub fn set(&self, scope: &InstructionsScope, text: &str) -> anyhow::Result<()> {
        let file = self.file(scope)?;
        if text.trim().is_empty() {
            match std::fs::remove_file(&file) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
                _ => return Ok(()),
            }
        }
        std::fs::create_dir_all(crate::fsutil::parent_of(&file)?)?;
        crate::fsutil::write_atomic(&file, text.as_bytes())
    }

    /// Moves a repository's instructions to another folder (the repository was moved).
    pub fn rename(&self, from: &str, to: &str) -> anyhow::Result<()> {
        let src = self.file(&InstructionsScope::Repo { path: from.to_owned() })?;
        let dest = self.file(&InstructionsScope::Repo { path: to.to_owned() })?;
        anyhow::ensure!(src.exists(), crate::error::not_found(format!("no instructions for {from}")));
        anyhow::ensure!(!dest.exists(), crate::error::conflict(format!("{to} already has instructions")));
        std::fs::rename(&src, &dest)?;
        crate::fsutil::sync_dir(&self.repos())
    }

    /// The repository folders that have a saved file.
    fn saved_repos(&self) -> Vec<String> {
        let Ok(entries) = std::fs::read_dir(self.repos()) else { return vec![] };
        entries.filter_map(|e| e.ok()?.file_name().to_str()?.strip_suffix(".md").and_then(decode)).collect()
    }

    /// Global, then every repository in `known` or with saved instructions, by name.
    pub fn list(&self, known: impl IntoIterator<Item = PathBuf>) -> Vec<InstructionsEntry> {
        let mut paths: Vec<String> = known.into_iter().map(|p| p.display().to_string()).chain(self.saved_repos()).collect();
        paths.sort();
        paths.dedup();
        let entry = |scope: InstructionsScope, name: String, folder_exists: bool| {
            let lines = self.get(&scope).map_or(0, |t| t.lines().count() as u32);
            InstructionsEntry { scope, name, lines, folder_exists }
        };
        let mut repos: Vec<InstructionsEntry> = paths
            .into_iter()
            .map(|path| entry(InstructionsScope::Repo { path: path.clone() }, folder_name(Path::new(&path)), Path::new(&path).is_dir()))
            .collect();
        repos.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then_with(|| a.scope_path().cmp(b.scope_path())));
        std::iter::once(entry(InstructionsScope::Global, "Global".to_owned(), true)).chain(repos).collect()
    }
}

impl InstructionsEntry {
    fn scope_path(&self) -> &str {
        match &self.scope {
            InstructionsScope::Global => "",
            InstructionsScope::Repo { path } => path,
        }
    }
}

/// The folder's last part, or the whole path.
pub fn folder_name(path: &Path) -> String {
    path.file_name().map_or_else(|| path.display().to_string(), |n| n.to_string_lossy().into_owned())
}

/// The key of a repository folder: its main checkout. A linked worktree's `.git` is a file
/// (`gitdir: <main>/.git/worktrees/<name>`) whose `commondir` leads to `<main>/.git`. Read from
/// disk without git; anything unexpected keeps `root`.
pub fn main_checkout(root: &Path) -> PathBuf {
    let main = || -> Option<PathBuf> {
        let dot_git = std::fs::read_to_string(root.join(".git")).ok()?;
        let gitdir = root.join(dot_git.trim().strip_prefix("gitdir:")?.trim());
        let common = gitdir.join(std::fs::read_to_string(gitdir.join("commondir")).ok()?.trim());
        let common = crate::fsutil::normalize_lexical(&common);
        (common.file_name()? == ".git").then(|| common.parent().map(Path::to_owned))?
    };
    main().unwrap_or_else(|| root.to_owned())
}

/// A folder path as a file name: `%`, `/`, `\` and `:` become `%25`, `%2F`, `%5C`, `%3A`, so it
/// stays readable and `decode` gets the path back.
fn encode(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for c in path.chars() {
        match c {
            '%' => out.push_str("%25"),
            '/' => out.push_str("%2F"),
            '\\' => out.push_str("%5C"),
            ':' => out.push_str("%3A"),
            c => out.push(c),
        }
    }
    out
}

fn decode(name: &str) -> Option<String> {
    let mut out = String::with_capacity(name.len());
    let mut rest = name;
    while let Some(i) = rest.find('%') {
        out.push_str(&rest[..i]);
        let c = match rest.get(i + 1..i + 3)? {
            "25" => '%',
            "2F" => '/',
            "5C" => '\\',
            "3A" => ':',
            _ => return None,
        };
        out.push(c);
        rest = &rest[i + 3..];
    }
    out.push_str(rest);
    Some(out)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "tests fail loudly")]
mod tests {
    use super::*;

    #[test]
    fn names_round_trip() {
        for p in ["/home/sam/code/my_app", "/tmp/a%2Fb", "C:\\work\\demo", "/x/100%/y"] {
            let name = encode(p);
            assert!(!name.contains('/') && !name.contains('\\') && !name.contains(':'), "{name}");
            assert_eq!(decode(&name).as_deref(), Some(p));
        }
        assert_eq!(encode("/home/sam/app"), "%2Fhome%2Fsam%2Fapp");
        assert_eq!(decode("bad%zz"), None);
    }

    #[test]
    fn save_get_list_and_move() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("demo-app");
        std::fs::create_dir_all(&repo).unwrap();
        let repo = repo.display().to_string();
        let i = Instructions::new(dir.path());
        let global = InstructionsScope::Global;
        let scope = InstructionsScope::Repo { path: repo.clone() };

        assert_eq!(i.get(&global), None);
        i.set(&global, "Answer briefly.\n").unwrap();
        i.set(&scope, "Use tabs.\nRun the tests.").unwrap();
        assert_eq!(i.get(&global).as_deref(), Some("Answer briefly."));
        assert!(i.set(&InstructionsScope::Repo { path: "relative/path".into() }, "x").is_err());

        let gone = "/nowhere/old-app".to_owned();
        let list = i.list([PathBuf::from(&gone)]);
        assert_eq!(list.len(), 3);
        assert_eq!((list[0].name.as_str(), list[0].lines, list[0].folder_exists), ("Global", 1, true));
        assert_eq!((list[1].name.as_str(), list[1].lines, list[1].folder_exists), ("demo-app", 2, true));
        assert_eq!((list[2].name.as_str(), list[2].lines, list[2].folder_exists), ("old-app", 0, false));

        let moved = dir.path().join("moved").display().to_string();
        i.rename(&repo, &moved).unwrap();
        assert_eq!(i.get(&scope), None);
        assert_eq!(i.get(&InstructionsScope::Repo { path: moved.clone() }).as_deref(), Some("Use tabs.\nRun the tests."));

        i.set(&InstructionsScope::Repo { path: moved.clone() }, "  ").unwrap();
        assert_eq!(i.list([]).len(), 1, "empty text deletes the file");
    }

    #[test]
    fn worktrees_share_the_main_checkout() {
        let dir = tempfile::tempdir().unwrap();
        let main = dir.path().join("main");
        let wt = dir.path().join("wt");
        std::fs::create_dir_all(main.join(".git/worktrees/wt")).unwrap();
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(main.join(".git/worktrees/wt/commondir"), "../..\n").unwrap();
        std::fs::write(wt.join(".git"), format!("gitdir: {}\n", main.join(".git/worktrees/wt").display())).unwrap();
        assert_eq!(main_checkout(&wt), main);
        assert_eq!(main_checkout(&main), main);
    }
}
