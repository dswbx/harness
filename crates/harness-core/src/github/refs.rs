//! PR references (`#17`, `owner/repo#17`): PRs of any GitHub repository via the GitHub API, cached for all Sessions.

use parking_lot::Mutex;
use std::collections::HashMap;
use std::fmt::Write;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::future::{BoxFuture, FutureExt, Shared};
use serde_json::json;

use super::client::{graphql, graphql_data, graphql_raw, rest_get};
use super::pr::{PR_FRAGMENT, branch_prs, pr_info, search_prs};
use super::repos::{repo_key, valid_repo};
use crate::api::{PrInfo, PrRefKey, PrState, RepoId};

const OPEN_TTL: Duration = Duration::from_secs(60);
const DONE_TTL: Duration = Duration::from_secs(24 * 3600);
const NOT_FOUND_TTL: Duration = Duration::from_secs(10 * 60);

/// Lowercased `owner/name`: GitHub names ignore case.
type Key = (String, u32);
type Found = Arc<HashMap<Key, Option<PrInfo>>>;
/// A lookup in flight; later lookups of the same PRs wait for it.
type Batch = Shared<BoxFuture<'static, Result<Found, String>>>;
type Fetch = Arc<dyn Fn(Vec<PrRefKey>) -> BoxFuture<'static, anyhow::Result<Vec<Option<PrInfo>>>> + Send + Sync>;

#[derive(Default)]
struct Cache {
    entries: HashMap<Key, (Instant, Option<PrInfo>)>,
    inflight: HashMap<Key, Batch>,
}

pub struct PrRefs {
    cache: Arc<Mutex<Cache>>,
    fetch: Fetch,
    /// The GitHub user and when it was asked; a missing one is asked again after `NOT_FOUND_TTL`.
    me: Mutex<Option<(Instant, Option<String>)>>,
    /// GitHub repo per repository folder of a Session (a Worktree's main repo).
    pub(super) repos: Mutex<HashMap<PathBuf, Option<RepoId>>>,
    pub(super) scanned: tokio::sync::OnceCell<()>,
}

impl Default for PrRefs {
    fn default() -> Self {
        Self::with_fetch(Arc::new(|refs| fetch_lookup(refs).boxed()))
    }
}

impl PrRefs {
    fn with_fetch(fetch: Fetch) -> Self {
        Self { cache: Default::default(), fetch, me: Default::default(), repos: Default::default(), scanned: Default::default() }
    }

    /// Drops a cached PR so the next lookup fetches it again.
    pub fn forget(&self, repo: &RepoId, number: u32) {
        self.cache.lock().entries.remove(&(repo_key(repo), number));
    }

    /// PRs in the order of `refs`, from the cache or one GraphQL call for the rest.
    pub async fn lookup(&self, refs: Vec<PrRefKey>) -> anyhow::Result<Vec<Option<PrInfo>>> {
        let keys: Vec<Key> = refs.iter().map(key).collect();
        let mut out = vec![None; refs.len()];
        let mut batches = vec![];
        {
            let mut c = self.cache.lock();
            let mut missing: Vec<PrRefKey> = vec![];
            for (i, (r, k)) in refs.iter().zip(&keys).enumerate() {
                if let Some((at, pr)) = c.entries.get(k)
                    && at.elapsed() < ttl(pr.as_ref())
                {
                    out[i] = pr.clone();
                } else if let Some(b) = c.inflight.get(k) {
                    batches.push(b.clone());
                } else if !missing.iter().any(|m| key(m) == *k) {
                    missing.push(r.clone());
                }
            }
            if !missing.is_empty() {
                batches.push(self.start_fetch(missing, &mut c));
            }
        }
        for b in batches {
            let found = b.await.map_err(anyhow::Error::msg)?;
            for (i, k) in keys.iter().enumerate() {
                if let Some(pr) = found.get(k) {
                    out[i] = pr.clone();
                }
            }
        }
        Ok(out)
    }

    /// Runs the fetch as its own task, so it fills the cache even when the caller goes away.
    fn start_fetch(&self, refs: Vec<PrRefKey>, c: &mut Cache) -> Batch {
        let keys: Vec<Key> = refs.iter().map(key).collect();
        let fetch = (self.fetch)(refs);
        let cache = self.cache.clone();
        let task_keys = keys.clone();
        let task = tokio::spawn(async move {
            let result = fetch.await;
            let mut c = cache.lock();
            for k in &task_keys {
                c.inflight.remove(k);
            }
            let found: HashMap<Key, Option<PrInfo>> = task_keys.into_iter().zip(result.map_err(|e| format!("{e:#}"))?).collect();
            let now = Instant::now();
            c.entries.extend(found.iter().map(|(k, pr)| (k.clone(), (now, pr.clone()))));
            Ok(Arc::new(found))
        });
        let batch = async move { task.await.map_err(|e| e.to_string())? }.boxed().shared();
        for k in keys {
            c.inflight.insert(k, batch.clone());
        }
        batch
    }

    /// Up to 30 PRs of `repo` in any state, the user's own first; `query` matches titles. Fills the cache.
    pub async fn search(&self, repo: &RepoId, query: Option<&str>) -> anyhow::Result<Vec<PrInfo>> {
        anyhow::ensure!(valid_repo(repo), "invalid repository {}/{}", repo.owner, repo.name);
        let search = query.map(str::trim).filter(|q| !q.is_empty());
        let list = async {
            match search {
                Some(q) => search_prs(&format!("repo:{}/{} is:pr {q} in:title sort:updated-desc", repo.owner, repo.name), 30).await,
                None => {
                    let q = format!(
                        "query($owner: String!, $name: String!) {{ repository(owner: $owner, name: $name) {{ pullRequests(first: 30, \
                         orderBy: {{field: UPDATED_AT, direction: DESC}}) {{ nodes {{ ...pr }} }} }} }} {PR_FRAGMENT}"
                    );
                    Ok(graphql(&q, json!({ "owner": repo.owner, "name": repo.name })).await?["repository"]["pullRequests"]["nodes"].take())
                }
            }
        };
        let (out, me) = tokio::join!(list, self.me());
        let out = out?;
        let list = out.as_array().map_or(&[][..], Vec::as_slice);
        let mut prs: Vec<PrInfo> = list.iter().filter_map(|v| pr_info(repo, v)).collect();
        prs.sort_by_key(|p| me.as_deref() != Some(p.author.as_str()));
        let now = Instant::now();
        self.cache.lock().entries.extend(prs.iter().map(|p| ((repo_key(&p.repo), p.number), (now, Some(p.clone())))));
        Ok(prs)
    }

    /// The PR whose head is `branch` in `repo`: an open one first, else the most recently updated. Fills the cache.
    pub async fn for_branch(&self, repo: &RepoId, branch: &str) -> anyhow::Result<Option<PrInfo>> {
        anyhow::ensure!(valid_repo(repo), "invalid repository {}/{}", repo.owner, repo.name);
        let q = format!(
            "query($owner: String!, $name: String!, $branch: String!) {{ repository(owner: $owner, name: $name) {{ \
             pullRequests(headRefName: $branch, first: 10) {{ nodes {{ ...pr }} }} }} }} {PR_FRAGMENT}"
        );
        let mut data = graphql(&q, json!({ "owner": repo.owner, "name": repo.name, "branch": branch })).await?;
        let list = data["repository"]["pullRequests"]["nodes"].take();
        let mut prs = branch_prs(repo, list.as_array().map_or(&[][..], Vec::as_slice));
        let now = Instant::now();
        self.cache.lock().entries.extend(prs.iter().map(|p| ((repo_key(&p.repo), p.number), (now, Some(p.clone())))));
        prs.sort_by(|a, b| {
            let open = |p: &PrInfo| matches!(p.state, PrState::Open | PrState::Draft);
            open(b).cmp(&open(a)).then_with(|| b.updated_at.cmp(&a.updated_at))
        });
        Ok(prs.into_iter().next())
    }

    /// The GitHub user; None without a token or connection.
    pub async fn me(&self) -> Option<String> {
        let cached = self.me.lock().clone();
        if let Some((at, me)) = cached
            && (me.is_some() || at.elapsed() < NOT_FOUND_TTL)
        {
            return me;
        }
        let me = rest_get("/user").await.ok().and_then(|u| u["login"].as_str().map(str::to_owned)).filter(|s| !s.is_empty());
        *self.me.lock() = Some((Instant::now(), me.clone()));
        me
    }
}

/// How long a looked-up PR stays cached: an open one changes often, a merged or closed one hardly.
fn ttl(pr: Option<&PrInfo>) -> Duration {
    match pr.map(|p| p.state) {
        Some(PrState::Open | PrState::Draft) => OPEN_TTL,
        Some(PrState::Merged | PrState::Closed) => DONE_TTL,
        None => NOT_FOUND_TTL,
    }
}

fn key(r: &PrRefKey) -> Key {
    (repo_key(&r.repo), r.number)
}

async fn fetch_lookup(refs: Vec<PrRefKey>) -> anyhow::Result<Vec<Option<PrInfo>>> {
    let Some((query, repos)) = lookup_query(&refs) else { return Ok(vec![None; refs.len()]) };
    let body = graphql_raw(&query, json!({})).await?;
    parse_lookup(&refs, &repos, &body)
}

/// One query for all `refs`: an `rN: repository` block per repo with a `pN: pullRequest(number: N)` per PR. Returns
/// it with the repo keys in alias order; None when no ref has a valid repo.
fn lookup_query(refs: &[PrRefKey]) -> Option<(String, Vec<String>)> {
    let mut repos: Vec<(String, &RepoId, Vec<u32>)> = vec![];
    for r in refs.iter().filter(|r| valid_repo(&r.repo)) {
        let k = repo_key(&r.repo);
        match repos.iter_mut().find(|g| g.0 == k) {
            Some(g) if !g.2.contains(&r.number) => g.2.push(r.number),
            Some(_) => {}
            None => repos.push((k, &r.repo, vec![r.number])),
        }
    }
    if repos.is_empty() {
        return None;
    }
    let mut q = String::from("query {");
    for (i, (_, repo, numbers)) in repos.iter().enumerate() {
        let _ = write!(q, " r{i}: repository(owner: \"{}\", name: \"{}\") {{", repo.owner, repo.name);
        for n in numbers {
            let _ = write!(q, " p{n}: pullRequest(number: {n}) {{ ...pr }}");
        }
        q.push_str(" }");
    }
    q.push_str(" } ");
    q.push_str(PR_FRAGMENT);
    Some((q, repos.into_iter().map(|g| g.0).collect()))
}

/// Missing repos and PRs come back as `null` aliases (with NOT_FOUND errors): None. Fails only without `data`.
fn parse_lookup(refs: &[PrRefKey], repos: &[String], body: &str) -> anyhow::Result<Vec<Option<PrInfo>>> {
    let data = graphql_data(serde_json::from_str(body)?)?;
    Ok(refs
        .iter()
        .map(|r| {
            let i = repos.iter().position(|k| *k == repo_key(&r.repo))?;
            pr_info(&r.repo, &data[format!("r{i}").as_str()][format!("p{}", r.number).as_str()])
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::PrChecks;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn repo(o: &str, n: &str) -> RepoId {
        RepoId { owner: o.into(), name: n.into() }
    }

    fn pr_ref(o: &str, n: &str, number: u32) -> PrRefKey {
        PrRefKey { repo: repo(o, n), number }
    }

    fn info(r: &PrRefKey, state: PrState) -> PrInfo {
        PrInfo {
            repo: r.repo.clone(),
            number: r.number,
            title: format!("PR {}", r.number),
            author: "me".into(),
            state,
            checks: PrChecks::None,
            checks_passed: 0,
            checks_total: 0,
            additions: 0,
            deletions: 0,
            changed_files: 0,
            updated_at: String::new(),
            url: String::new(),
        }
    }

    #[test]
    fn builds_one_query_per_repo() {
        let refs = [
            pr_ref("dswbx", "harness", 17),
            pr_ref("supabase", "spark", 3),
            pr_ref("DSWBX", "Harness", 18),
            pr_ref("dswbx", "harness", 17),
            pr_ref("bad\"", "x", 1),
        ];
        let (q, repos) = lookup_query(&refs).unwrap();
        assert_eq!(repos, ["dswbx/harness", "supabase/spark"]);
        assert!(q.starts_with(
            "query { r0: repository(owner: \"dswbx\", name: \"harness\") { p17: pullRequest(number: 17) { ...pr } \
             p18: pullRequest(number: 18) { ...pr } } r1: repository(owner: \"supabase\", name: \"spark\") { \
             p3: pullRequest(number: 3) { ...pr } } } fragment pr on PullRequest {"
        ));
        assert_eq!(lookup_query(&[pr_ref("a b", "x", 1)]), None);
    }

    #[test]

    fn parses_lookup_with_missing_prs() {
        let refs = [pr_ref("dswbx", "harness", 17), pr_ref("dswbx", "harness", 99), pr_ref("nope", "gone", 1), pr_ref("x y", "z", 2)];
        let repos = vec!["dswbx/harness".to_owned(), "nope/gone".to_owned()];
        // GitHub answers this (status 200) when some aliases do not resolve.
        let body = json!({
            "data": {
                "r0": {
                    "p17": {
                        "number": 17, "title": "Chips", "url": "https://github.com/dswbx/harness/pull/17", "state": "OPEN",
                        "isDraft": false, "additions": 120, "deletions": 8, "changedFiles": 5, "updatedAt": "2026-11-01T10:00:00Z",
                        "author": {"login": "dswbx"},
                        "commits": {"nodes": [{"commit": {"statusCheckRollup": {"contexts": {"nodes": [
                            {"status": "COMPLETED", "conclusion": "SUCCESS"},
                            {"status": "COMPLETED", "conclusion": "FAILURE"},
                            {"state": "SUCCESS"}
                        ]}}}}]}
                    },
                    "p99": null
                },
                "r1": null
            },
            "errors": [
                {"type": "NOT_FOUND", "path": ["r0", "p99"], "message": "Could not resolve to a PullRequest with the number of 99."},
                {"type": "NOT_FOUND", "path": ["r1"], "message": "Could not resolve to a Repository with the name 'nope/gone'."}
            ]
        });
        let prs = parse_lookup(&refs, &repos, &body.to_string()).unwrap();
        let p = prs[0].as_ref().unwrap();
        assert_eq!((p.number, p.state, p.checks, p.checks_passed, p.checks_total), (17, PrState::Open, PrChecks::Failing, 2, 3));
        assert_eq!((p.additions, p.deletions, p.changed_files, p.author.as_str()), (120, 8, 5, "dswbx"));
        assert_eq!(prs[1..], [None, None, None]);

        let err = json!({"errors": [{"message": "Bad credentials"}]});
        assert!(parse_lookup(&refs, &repos, &err.to_string()).unwrap_err().to_string().contains("Bad credentials"));
    }

    #[test]
    fn ttl_by_state() {
        let r = pr_ref("a", "b", 1);
        assert_eq!(ttl(Some(&info(&r, PrState::Open))), OPEN_TTL);
        assert_eq!(ttl(Some(&info(&r, PrState::Draft))), OPEN_TTL);
        assert_eq!(ttl(Some(&info(&r, PrState::Merged))), DONE_TTL);
        assert_eq!(ttl(Some(&info(&r, PrState::Closed))), DONE_TTL);
        assert_eq!(ttl(None), NOT_FOUND_TTL);
    }

    #[tokio::test]
    async fn dedupes_and_caches_lookups() {
        let calls = Arc::new(Mutex::new(Vec::<Vec<u32>>::new()));
        let seen = calls.clone();
        let refs = PrRefs::with_fetch(Arc::new(move |refs: Vec<PrRefKey>| {
            seen.lock().push(refs.iter().map(|r| r.number).collect());
            async move {
                tokio::time::sleep(Duration::from_millis(20)).await;
                Ok(refs.iter().map(|r| (r.number != 3).then(|| info(r, PrState::Merged))).collect())
            }
            .boxed()
        }));
        let (a, b) = tokio::join!(refs.lookup(vec![pr_ref("o", "r", 1), pr_ref("o", "r", 2)]), refs.lookup(vec![pr_ref("o", "r", 2), pr_ref("O", "R", 3)]),);
        assert_eq!(a.unwrap().iter().map(|p| p.as_ref().map(|p| p.number)).collect::<Vec<_>>(), [Some(1), Some(2)]);
        assert_eq!(b.unwrap().iter().map(|p| p.as_ref().map(|p| p.number)).collect::<Vec<_>>(), [Some(2), None]);
        assert_eq!(*calls.lock(), [vec![1, 2], vec![3]]);

        let again = refs.lookup(vec![pr_ref("o", "r", 3), pr_ref("o", "r", 1)]).await.unwrap();
        assert_eq!(again.iter().map(|p| p.as_ref().map(|p| p.number)).collect::<Vec<_>>(), [None, Some(1)]);
        assert_eq!(calls.lock().len(), 2);
    }

    #[tokio::test]
    async fn forget_makes_the_next_lookup_fetch() {
        let n = Arc::new(AtomicUsize::new(0));
        let count = n.clone();
        let refs = PrRefs::with_fetch(Arc::new(move |refs: Vec<PrRefKey>| {
            count.fetch_add(1, Ordering::SeqCst);
            async move { Ok(refs.iter().map(|r| Some(info(r, PrState::Open))).collect()) }.boxed()
        }));
        let r = pr_ref("o", "r", 1);
        refs.lookup(vec![r.clone()]).await.unwrap();
        refs.lookup(vec![r.clone()]).await.unwrap();
        assert_eq!(n.load(Ordering::SeqCst), 1);
        refs.forget(&r.repo, 1);
        refs.lookup(vec![r]).await.unwrap();
        assert_eq!(n.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn failed_lookup_is_not_cached() {
        let n = Arc::new(AtomicUsize::new(0));
        let count = n.clone();
        let refs = PrRefs::with_fetch(Arc::new(move |_| {
            count.fetch_add(1, Ordering::SeqCst);
            async { Err(anyhow::anyhow!("GitHub 401 Unauthorized: Bad credentials")) }.boxed()
        }));
        assert!(refs.lookup(vec![pr_ref("o", "r", 1)]).await.is_err());
        assert!(refs.lookup(vec![pr_ref("o", "r", 1)]).await.is_err());
        assert_eq!(n.load(Ordering::SeqCst), 2);
    }
}
