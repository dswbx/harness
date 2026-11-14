//! Git Primitives (ADR 0009) live in `crate::git`; this module keeps their old paths and the
//! GitHub remote lookup.

use std::path::Path;

use crate::api::RepoId;

pub use crate::git::*;

/// GitHub repository of the `upstream` remote, else `origin`. None without one on github.com.
pub async fn origin_repo(dir: &Path) -> Option<RepoId> {
    for remote in ["upstream", "origin"] {
        if let Ok(url) = git(dir, &["remote", "get-url", remote]).await
            && let Some(repo) = parse_github_remote(url.trim())
        {
            return Some(repo);
        }
    }
    None
}

/// `git@github.com:o/r.git`, `ssh://git@github.com/o/r`, `https://github.com/o/r.git`, ...
fn parse_github_remote(url: &str) -> Option<RepoId> {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let rest = rest.split_once('@').filter(|(user, _)| !user.contains('/')).map_or(rest, |(_, r)| r);
    let path = rest.strip_prefix("github.com")?;
    let path = path.strip_prefix(':').or_else(|| path.strip_prefix('/'))?.trim_end_matches('/');
    let (owner, name) = path.strip_suffix(".git").unwrap_or(path).split_once('/')?;
    Some(RepoId { owner: owner.to_owned(), name: name.to_owned() }).filter(crate::github_refs::valid_repo)
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
    fn parses_github_remotes() {
        let r = |o: &str, n: &str| Some(RepoId { owner: o.into(), name: n.into() });
        assert_eq!(parse_github_remote("git@github.com:dswbx/harness.git"), r("dswbx", "harness"));
        assert_eq!(parse_github_remote("git@github.com:dswbx/harness"), r("dswbx", "harness"));
        assert_eq!(parse_github_remote("ssh://git@github.com/supabase/spark.git"), r("supabase", "spark"));
        assert_eq!(parse_github_remote("https://github.com/supabase/spark"), r("supabase", "spark"));
        assert_eq!(parse_github_remote("https://github.com/supabase/spark.git/"), r("supabase", "spark"));
        assert_eq!(parse_github_remote("https://user@github.com/supabase/my.repo.git"), r("supabase", "my.repo"));
        assert_eq!(parse_github_remote("git@gitlab.com:dswbx/harness.git"), None);
        assert_eq!(parse_github_remote("https://github.com.evil.dev/a/b"), None);
        assert_eq!(parse_github_remote("https://github.com/only-owner"), None);
        assert_eq!(parse_github_remote("https://github.com/a/b/tree/main"), None);
        assert_eq!(parse_github_remote("/local/path/repo.git"), None);
    }
}
