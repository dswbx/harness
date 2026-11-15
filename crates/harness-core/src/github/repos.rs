//! The GitHub repos the Sessions work in: finding and ranking them, and repo name checks.

use std::path::{Path, PathBuf};

use super::refs::PrRefs;
use crate::api::{KnownRepo, RepoId};

impl PrRefs {
    /// Finds the GitHub repo of every folder, once (Host startup or the first `PrContext`, whichever comes first).
    pub async fn scan(&self, mut folders: Vec<PathBuf>) {
        self.scanned
            .get_or_init(|| async {
                folders.sort();
                folders.dedup();
                let found = futures_util::future::join_all(folders.into_iter().map(|f| async move {
                    let repo = origin_repo(&f).await;
                    (f, repo)
                }))
                .await;
                self.repos.lock().extend(found);
            })
            .await;
    }

    /// The GitHub repo of `folder`, cached.
    pub async fn repo_of(&self, folder: &Path) -> Option<RepoId> {
        let cached = self.repos.lock().get(folder).cloned();
        if let Some(repo) = cached {
            return repo;
        }
        let repo = origin_repo(folder).await;
        self.repos.lock().insert(folder.to_owned(), repo.clone());
        repo
    }

    /// Repos of the Sessions' folders (with their last activity) found so far, best first.
    pub fn known_repos(&self, folders: &[(PathBuf, i64)], now_ms: i64) -> Vec<KnownRepo> {
        let repos = self.repos.lock();
        rank(folders.iter().filter_map(|(f, t)| Some((repos.get(f)?.clone()?, *t))), now_ms)
    }
}

/// Each Session adds `exp(-age_days / 30)` to its repo's score.
fn rank(sessions: impl Iterator<Item = (RepoId, i64)>, now_ms: i64) -> Vec<KnownRepo> {
    let mut out: Vec<KnownRepo> = vec![];
    for (repo, t) in sessions {
        let weight = (-((now_ms - t).max(0) as f64 / 86_400_000.0) / 30.0).exp();
        match out.iter_mut().find(|k| repo_key(&k.repo) == repo_key(&repo)) {
            Some(k) => {
                k.sessions += 1;
                k.score += weight;
                k.last_ms = k.last_ms.max(t);
            }
            None => out.push(KnownRepo { repo, sessions: 1, score: weight, last_ms: t }),
        }
    }
    out.sort_by(|a, b| b.score.total_cmp(&a.score));
    out
}

pub(super) fn repo_key(r: &RepoId) -> String {
    format!("{}/{}", r.owner, r.name).to_ascii_lowercase()
}

/// Owner and name are GitHub names (also keeps them safe inside a query).
pub(crate) fn valid_repo(r: &RepoId) -> bool {
    let ok = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
    ok(&r.owner) && ok(&r.name)
}

/// GitHub repository of the `upstream` remote, else `origin`. None without one on github.com.
pub async fn origin_repo(dir: &Path) -> Option<RepoId> {
    for remote in ["upstream", "origin"] {
        if let Ok(url) = crate::git::git(dir, &["remote", "get-url", remote]).await
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
    Some(RepoId { owner: owner.to_owned(), name: name.to_owned() }).filter(valid_repo)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo(o: &str, n: &str) -> RepoId {
        RepoId { owner: o.into(), name: n.into() }
    }

    #[test]
    fn ranks_known_repos() {
        let day = 86_400_000;
        let now = 100 * day;
        let ranked = rank(
            [
                (repo("supabase", "spark"), now - 60 * day),
                (repo("supabase", "spark"), now - 60 * day),
                (repo("dswbx", "harness"), now),
                (repo("Supabase", "Spark"), now - 90 * day),
            ]
            .into_iter(),
            now,
        );
        assert_eq!(ranked.iter().map(|k| (k.repo.name.as_str(), k.sessions)).collect::<Vec<_>>(), [("harness", 1), ("spark", 3)]);
        assert!((ranked[0].score - 1.0).abs() < 1e-9);
        assert!((ranked[1].score - (2.0 * (-2.0f64).exp() + (-3.0f64).exp())).abs() < 1e-9);
        assert_eq!(ranked[1].last_ms, now - 60 * day);
    }

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
