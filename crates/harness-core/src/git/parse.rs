//! Pure parsers for git output (no processes, no async).

use std::path::Path;

use crate::api::{BranchInfo, Commit, FileChange, GitStatus};

pub(super) fn parse_gitdir(content: &str) -> Option<&str> {
    content.trim().strip_prefix("gitdir:").map(str::trim).filter(|s| !s.is_empty())
}

pub(super) fn parse_head(content: &str) -> Option<String> {
    content.trim().strip_prefix("ref:")?.trim().strip_prefix("refs/heads/").filter(|s| !s.is_empty()).map(str::to_owned)
}

/// One `for-each-ref` line: name, commit time, upstream track ("ahead 3, behind 1"), worktree path.
pub(super) fn parse_branch(line: &str, root: &Path) -> Option<BranchInfo> {
    let mut f = line.split('\0');
    let name = f.next().filter(|n| !n.is_empty())?.to_owned();
    let time = f.next().and_then(|t| t.parse().ok()).unwrap_or(0);
    let (mut ahead, mut behind) = (0, 0);
    for part in f.next().unwrap_or("").split(", ") {
        match part.split_once(' ') {
            Some(("ahead", n)) => ahead = n.parse().unwrap_or(0),
            Some(("behind", n)) => behind = n.parse().unwrap_or(0),
            _ => {}
        }
    }
    let wt = f.next().unwrap_or("");
    let worktree = !wt.is_empty() && Path::new(wt) != root;
    Some(BranchInfo { name, time, ahead, behind, worktree, archived: false })
}

/// `git status --porcelain=v2 --branch` output as a `GitStatus`.
pub(super) fn parse_status(out: &str) -> GitStatus {
    let mut st = GitStatus { branch: None, upstream: None, ahead: 0, behind: 0, files: vec![] };
    for line in out.lines() {
        if let Some(h) = line.strip_prefix("# branch.head ") {
            st.branch = Some(h.to_owned()).filter(|h| h != "(detached)");
        } else if let Some(u) = line.strip_prefix("# branch.upstream ") {
            st.upstream = Some(u.to_owned());
        } else if let Some(ab) = line.strip_prefix("# branch.ab ") {
            let mut it = ab.split(' ');
            st.ahead = it.next().and_then(|a| a.trim_start_matches('+').parse().ok()).unwrap_or(0);
            st.behind = it.next().and_then(|b| b.trim_start_matches('-').parse().ok()).unwrap_or(0);
        } else if let Some(p) = line.strip_prefix("? ") {
            st.files.push(FileChange { path: p.to_owned(), status: "?".into(), additions: None, deletions: None });
        } else if line.starts_with("u ") {
            // "u XY sub m1 m2 m3 mW h1 h2 h3 path": the path is the rest of the line.
            if let Some(path) = line.splitn(11, ' ').nth(10) {
                st.files.push(FileChange { path: path.to_owned(), status: "U".into(), additions: None, deletions: None });
            }
        } else if line.starts_with("1 ") || line.starts_with("2 ") {
            // "1 XY sub mH mI mW hH hI path" / "2 XY ... Xscore path\torig"
            let fields: Vec<&str> = line.splitn(if line.starts_with('1') { 9 } else { 10 }, ' ').collect();
            let xy = fields[1];
            let path = fields.last().and_then(|f| f.split('\t').next()).unwrap_or_default();
            let code = xy.strip_prefix('.').unwrap_or(&xy[..1]);
            st.files.push(FileChange { path: path.to_owned(), status: code.into(), additions: None, deletions: None });
        }
    }
    st
}

/// `--name-status` and `--numstat` output merged into one file list.
pub(super) fn parse_diff_files(names: &str, nums: &str) -> Vec<FileChange> {
    let mut files: Vec<FileChange> = names
        .lines()
        .filter_map(|l| l.split_once('\t'))
        .map(|(s, p)| FileChange { path: p.to_owned(), status: s.to_owned(), additions: None, deletions: None })
        .collect();
    for l in nums.lines() {
        let mut it = l.splitn(3, '\t');
        let (Some(a), Some(d), Some(p)) = (it.next(), it.next(), it.next()) else { continue };
        if let Some(f) = files.iter_mut().find(|f| f.path == p) {
            f.additions = a.parse().ok();
            f.deletions = d.parse().ok();
        }
    }
    files
}

/// `git log` output in the record format of `diff::log`: records end with \x1e, fields with \x1f.
pub(super) fn parse_log(out: &str) -> Vec<Commit> {
    out.split('\x1e')
        .filter_map(|r| {
            let mut p = r.trim_start_matches('\n').split('\x1f');
            Some(Commit {
                sha: p.next().filter(|s| !s.is_empty())?.to_owned(),
                short: p.next()?.to_owned(),
                subject: p.next()?.to_owned(),
                author: p.next()?.to_owned(),
                author_email: p.next()?.to_owned(),
                committer: p.next()?.to_owned(),
                time: p.next()?.parse().ok()?,
                body: p.next()?.trim_end().to_owned(),
            })
        })
        .collect()
}

/// Lowercase, dash-separated, at most 24 chars; safe inside a branch name.
pub fn slug(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out: String = out.trim_end_matches('-').chars().take(24).collect();
    let out = out.trim_end_matches('-').to_owned();
    if out.is_empty() { "session".into() } else { out }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain_v2_status() {
        let head = "# branch.oid abc\n# branch.head main\n";
        let one = |xy: &str, path: &str| format!("1 {xy} N... 100644 100644 100644 aaa bbb {path}\n");
        // (name, text, branch, upstream, (ahead, behind), files)
        #[allow(clippy::type_complexity)]
        let table: Vec<(&str, String, Option<&str>, Option<&str>, (u32, u32), Vec<(&str, &str)>)> = vec![
            (
                "ordinary",
                format!("{head}{}{}{}", one(".M", "src/a.rs"), one("M.", "b.rs"), one(".D", "d.rs")),
                Some("main"),
                None,
                (0, 0),
                vec![("src/a.rs", "M"), ("b.rs", "M"), ("d.rs", "D")],
            ),
            ("rename", format!("{head}2 R. N... 100644 100644 100644 aaa bbb R100 new.rs\told.rs\n"), Some("main"), None, (0, 0), vec![("new.rs", "R")]),
            ("untracked", format!("{head}? notes/todo.txt\n"), Some("main"), None, (0, 0), vec![("notes/todo.txt", "?")]),
            (
                "unmerged",
                format!(
                    "{head}u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.rs\nu AA N... 000000 100644 100644 100644 000 bbb ccc dir/both added.rs\n"
                ),
                Some("main"),
                None,
                (0, 0),
                vec![("conflict.rs", "U"), ("dir/both added.rs", "U")],
            ),
            ("detached", format!("# branch.oid abc\n# branch.head (detached)\n{}", one(".M", "a.rs")), None, None, (0, 0), vec![("a.rs", "M")]),
            (
                "spaces",
                format!("{head}{}2 R. N... 100644 100644 100644 aaa bbb R90 new name.rs\told name.rs\n? un tracked.txt\n", one(".M", "my dir/a b.rs")),
                Some("main"),
                None,
                (0, 0),
                vec![("my dir/a b.rs", "M"), ("new name.rs", "R"), ("un tracked.txt", "?")],
            ),
            (
                "ahead and behind",
                "# branch.oid abc\n# branch.head feat/x\n# branch.upstream origin/feat/x\n# branch.ab +3 -2\n".into(),
                Some("feat/x"),
                Some("origin/feat/x"),
                (3, 2),
                vec![],
            ),
        ];
        for (name, text, branch, upstream, (ahead, behind), want) in table {
            let st = parse_status(&text);
            assert_eq!(st.branch.as_deref(), branch, "{name}");
            assert_eq!(st.upstream.as_deref(), upstream, "{name}");
            assert_eq!((st.ahead, st.behind), (ahead, behind), "{name}");
            let got: Vec<(&str, &str)> = st.files.iter().map(|f| (f.path.as_str(), f.status.as_str())).collect();
            assert_eq!(got, want, "{name}");
        }
    }

    #[test]
    fn parses_head_and_gitdir() {
        assert_eq!(parse_head("ref: refs/heads/main\n").as_deref(), Some("main"));
        assert_eq!(parse_head("ref: refs/heads/harness/pr-12-abc\n").as_deref(), Some("harness/pr-12-abc"));
        assert_eq!(parse_head("3f2a9c0e1b4d5a6f7e8d9c0b1a2f3e4d5c6b7a8f\n"), None);
        assert_eq!(parse_gitdir("gitdir: /repo/.git/worktrees/x\n"), Some("/repo/.git/worktrees/x"));
        assert_eq!(parse_gitdir("nonsense"), None);
    }

    #[test]
    fn parses_branch_lines() {
        let root = Path::new("/r/proj");
        let b = parse_branch("feat/x\x001700000000\0ahead 3, behind 1\0/r/wt", root).unwrap();
        assert_eq!((b.name.as_str(), b.time, b.ahead, b.behind, b.worktree), ("feat/x", 1700000000, 3, 1, true));
        let b = parse_branch("main\x001\0\0/r/proj", root).unwrap();
        assert_eq!((b.ahead, b.behind, b.worktree), (0, 0, false));
        assert!(parse_branch("\0\0\0", root).is_none());
    }

    #[test]
    fn parses_log_records() {
        let rec = |sha: &str, body: &str| format!("{sha}\x1f{}\x1fsubj\x1fAnn\x1fa@x\x1fBob\x1f1700000000\x1f{body}\x1e\n", &sha[..3]);
        let out = format!("{}{}", rec("abcdef", "line one\nline two\n"), rec("123456", ""));
        let got = parse_log(&out);
        assert_eq!(got.len(), 2);
        assert_eq!((got[0].sha.as_str(), got[0].short.as_str(), got[0].body.as_str()), ("abcdef", "abc", "line one\nline two"));
        assert_eq!((got[1].author.as_str(), got[1].committer.as_str(), got[1].time, got[1].body.as_str()), ("Ann", "Bob", 1700000000, ""));
    }

    #[test]
    fn merges_name_status_and_numstat() {
        let files = parse_diff_files("M\ta.rs\nA\tb c.rs\n", "3\t1\ta.rs\n-\t-\tb c.rs\n");
        let got: Vec<_> = files.iter().map(|f| (f.path.as_str(), f.status.as_str(), f.additions, f.deletions)).collect();
        assert_eq!(got, vec![("a.rs", "M", Some(3), Some(1)), ("b c.rs", "A", None, None)]);
    }
}
