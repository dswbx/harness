//! GitHub: API calls over HTTP with the token of the GitHub CLI (`gh auth token`), and PR checkout via `gh`.

use std::path::Path;
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde_json::{Value, json};

use crate::api::{PrChecks, PrFilter, PullRequest, RepoId};

async fn gh(dir: &Path, args: &[&str]) -> anyhow::Result<String> {
    gh_in(Some(dir), args).await
}

/// `gh` in `dir`, or anywhere.
pub(crate) async fn gh_in(dir: Option<&Path>, args: &[&str]) -> anyhow::Result<String> {
    let mut cmd = tokio::process::Command::new("gh");
    if let Some(dir) = dir {
        cmd.current_dir(dir);
    }
    let out = cmd
        .args(args)
        .env("PATH", crate::env::login_path())
        .env("GH_PROMPT_DISABLED", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .map_err(|e| anyhow::anyhow!("gh: {e} (is the GitHub CLI installed?)"))?;
    if !out.status.success() {
        anyhow::bail!("gh {}: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

const API: &str = "https://api.github.com";
/// How long a token is used before `gh` is asked again (the user may switch accounts).
const TOKEN_TTL: Duration = Duration::from_secs(10 * 60);

static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| crate::http::builder().timeout(Duration::from_secs(30)).build().expect("GitHub HTTP client"));
static TOKEN: Mutex<Option<(Instant, String)>> = Mutex::new(None);

/// `GH_TOKEN`/`GITHUB_TOKEN` (as `gh` reads them), else the token `gh` stores. Cached for `TOKEN_TTL`.
async fn token() -> anyhow::Result<String> {
    if let Some((at, t)) = TOKEN.lock().clone()
        && at.elapsed() < TOKEN_TTL
    {
        return Ok(t);
    }
    let env = ["GH_TOKEN", "GITHUB_TOKEN"].into_iter().find_map(|k| std::env::var(k).ok().filter(|t| !t.trim().is_empty()));
    let t = match env {
        Some(t) => t,
        None => gh_in(None, &["auth", "token"]).await?,
    };
    let t = t.trim().to_owned();
    anyhow::ensure!(!t.is_empty(), "gh: not signed in (run `gh auth login`)");
    *TOKEN.lock() = Some((Instant::now(), t.clone()));
    Ok(t)
}

/// Sends a request with the token and returns the body of a 2xx response. On 401 it gets the token again and retries once.
async fn send(req: impl Fn() -> reqwest::RequestBuilder) -> anyhow::Result<String> {
    let mut retried = false;
    loop {
        let token = token().await?;
        let resp = req()
            .bearer_auth(&token)
            .header("accept", "application/vnd.github+json")
            .header("x-github-api-version", "2022-11-28")
            .send()
            .await
            .map_err(|e| anyhow::anyhow!("GitHub: {e}"))?;
        let status = resp.status();
        let body = resp.text().await?;
        if status.is_success() {
            return Ok(body);
        }
        if status == reqwest::StatusCode::UNAUTHORIZED && !retried {
            retried = true;
            *TOKEN.lock() = None;
            continue;
        }
        let msg = serde_json::from_str::<Value>(&body).ok().and_then(|v| v["message"].as_str().map(str::to_owned)).unwrap_or(body);
        anyhow::bail!("GitHub {status}: {}", msg.trim());
    }
}

/// `GET {API}{path}` as JSON.
pub(crate) async fn rest_get(path: &str) -> anyhow::Result<Value> {
    let url = format!("{API}{path}");
    Ok(serde_json::from_str(&send(|| CLIENT.get(&url)).await?)?)
}

/// The whole GraphQL response: `data` can come with `errors` (a PR that does not exist is `null` plus an error).
pub(crate) async fn graphql_raw(query: &str, variables: Value) -> anyhow::Result<String> {
    let body = json!({ "query": query, "variables": variables });
    send(|| CLIENT.post(format!("{API}/graphql")).json(&body)).await
}

/// The `data` of a GraphQL response; fails when there is none.
pub(crate) async fn graphql(query: &str, variables: Value) -> anyhow::Result<Value> {
    graphql_data(serde_json::from_str(&graphql_raw(query, variables).await?)?)
}

pub(crate) fn graphql_data(mut v: Value) -> anyhow::Result<Value> {
    if !v["data"].is_object() {
        anyhow::bail!("GitHub: {}", v["errors"][0]["message"].as_str().unwrap_or("no data"));
    }
    Ok(v["data"].take())
}

/// The PR fields both `PullRequest` and `PrInfo` read.
pub(crate) const PR_FRAGMENT: &str = "fragment pr on PullRequest { number title url state isDraft isCrossRepository headRefName \
baseRefName additions deletions changedFiles updatedAt author { login } commits(last: 1) { nodes { commit { statusCheckRollup { \
contexts(first: 100) { nodes { ... on CheckRun { status conclusion } ... on StatusContext { state } } } } } } } }";

/// The check runs and statuses of a PR from `PR_FRAGMENT`.
pub(crate) fn rollup(pr: &Value) -> &[Value] {
    pr["commits"]["nodes"][0]["commit"]["statusCheckRollup"]["contexts"]["nodes"].as_array().map_or(&[][..], Vec::as_slice)
}

/// A deleted account shows as null.
pub(crate) fn author(pr: &Value) -> String {
    pr["author"]["login"].as_str().unwrap_or("ghost").to_owned()
}

async fn folder_repo(folder: &Path) -> anyhow::Result<RepoId> {
    crate::workspace::origin_repo(folder).await.ok_or_else(|| anyhow::anyhow!("{} has no GitHub remote", folder.display()))
}

pub async fn list_prs(folder: &Path, filter: PrFilter) -> anyhow::Result<Vec<PullRequest>> {
    let repo = folder_repo(folder).await?;
    let search = |who: &str| format!("repo:{}/{} is:pr is:open {who} sort:created-desc", repo.owner, repo.name);
    let nodes = match filter {
        PrFilter::Open => {
            let q = format!(
                "query($owner: String!, $name: String!) {{ repository(owner: $owner, name: $name) {{ pullRequests(first: 50, \
                 states: OPEN, orderBy: {{field: CREATED_AT, direction: DESC}}) {{ nodes {{ ...pr }} }} }} }} {PR_FRAGMENT}"
            );
            graphql(&q, json!({ "owner": repo.owner, "name": repo.name })).await?["repository"]["pullRequests"]["nodes"].take()
        }
        PrFilter::Mine => search_prs(&search("author:@me"), 50).await?,
        PrFilter::ReviewRequested => search_prs(&search("review-requested:@me"), 50).await?,
    };
    Ok(nodes.as_array().map_or(&[][..], Vec::as_slice).iter().filter_map(pull_request).collect())
}

/// PR nodes of an issue search (`query` is GitHub search syntax).
pub(crate) async fn search_prs(query: &str, first: u32) -> anyhow::Result<Value> {
    let q = format!("query($q: String!, $first: Int!) {{ search(query: $q, type: ISSUE, first: $first) {{ nodes {{ ...pr }} }} }} {PR_FRAGMENT}");
    Ok(graphql(&q, json!({ "q": query, "first": first })).await?["search"]["nodes"].take())
}

fn pull_request(v: &Value) -> Option<PullRequest> {
    let text = |k: &str| v[k].as_str().unwrap_or_default().to_owned();
    Some(PullRequest {
        checks: checks(rollup(v)),
        number: v["number"].as_u64()? as u32,
        title: text("title"),
        author: author(v),
        head: text("headRefName"),
        base: text("baseRefName"),
        draft: v["isDraft"].as_bool().unwrap_or(false),
        fork: v["isCrossRepository"].as_bool().unwrap_or(false),
        updated_at: text("updatedAt"),
    })
}

/// Rolls check runs (`conclusion`/`status`) and commit statuses (`state`) up into one state.
pub(crate) fn checks(rollup: &[serde_json::Value]) -> PrChecks {
    if rollup.is_empty() {
        return PrChecks::None;
    }
    let mut pending = false;
    for c in rollup {
        match check_passed(c) {
            Some(false) => return PrChecks::Failing,
            Some(true) => {}
            None => pending = true,
        }
    }
    if pending { PrChecks::Pending } else { PrChecks::Passing }
}

/// Checks that passed, and all checks.
pub(crate) fn check_counts(rollup: &[serde_json::Value]) -> (u32, u32) {
    (rollup.iter().filter(|c| check_passed(c) == Some(true)).count() as u32, rollup.len() as u32)
}

/// One check: passed, failed, or `None` while it runs.
fn check_passed(c: &serde_json::Value) -> Option<bool> {
    let s = c["conclusion"].as_str().filter(|s| !s.is_empty()).or(c["state"].as_str()).unwrap_or("");
    match s.to_ascii_uppercase().as_str() {
        "FAILURE" | "ERROR" | "TIMED_OUT" | "CANCELLED" | "ACTION_REQUIRED" | "STARTUP_FAILURE" => Some(false),
        "SUCCESS" | "NEUTRAL" | "SKIPPED" => Some(true),
        _ => None,
    }
}

pub async fn view_pr(folder: &Path, number: u32) -> anyhow::Result<PullRequest> {
    let repo = folder_repo(folder).await?;
    let q = format!(
        "query($owner: String!, $name: String!, $number: Int!) {{ repository(owner: $owner, name: $name) {{ \
         pullRequest(number: $number) {{ ...pr }} }} }} {PR_FRAGMENT}"
    );
    let data = graphql(&q, json!({ "owner": repo.owner, "name": repo.name, "number": number })).await?;
    pull_request(&data["repository"]["pullRequest"]).ok_or_else(|| anyhow::anyhow!("PR #{number} not found in {}/{}", repo.owner, repo.name))
}

/// Checks the PR out in `dir` (a fresh detached Worktree, or a clean folder): on its head branch
/// name when that is free, else on `fallback`. Returns the branch.
pub async fn checkout_pr(dir: &Path, number: u32, fallback: &str) -> anyhow::Result<String> {
    let n = number.to_string();
    if gh(dir, &["pr", "checkout", &n]).await.is_err() {
        gh(dir, &["pr", "checkout", &n, "--branch", fallback]).await?;
    }
    crate::workspace::current_branch(dir).await?.ok_or_else(|| anyhow::anyhow!("PR #{number} checkout left HEAD detached"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rolls_up_checks() {
        assert_eq!(checks(&[]), PrChecks::None);
        assert_eq!(checks(&[json!({"conclusion": "SUCCESS"}), json!({"state": "SUCCESS"})]), PrChecks::Passing);
        assert_eq!(checks(&[json!({"conclusion": "SUCCESS"}), json!({"status": "IN_PROGRESS", "conclusion": ""})]), PrChecks::Pending);
        assert_eq!(checks(&[json!({"status": "IN_PROGRESS"}), json!({"conclusion": "FAILURE"})]), PrChecks::Failing);
        assert_eq!(checks(&[json!({"state": "PENDING"})]), PrChecks::Pending);
    }

    #[test]
    fn counts_checks() {
        assert_eq!(check_counts(&[]), (0, 0));
        let rollup = [
            json!({"conclusion": "SUCCESS"}),
            json!({"conclusion": "SKIPPED"}),
            json!({"state": "SUCCESS"}),
            json!({"status": "IN_PROGRESS", "conclusion": null}),
            json!({"conclusion": "FAILURE"}),
        ];
        assert_eq!(check_counts(&rollup), (3, 5));
    }
}
