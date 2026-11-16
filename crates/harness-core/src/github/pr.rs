//! PR queries, the PR fragment, and the parsers from GraphQL nodes to `PullRequest` and `PrInfo`.

use std::path::Path;

use serde_json::{Value, json};

use super::client::{gh, graphql};
use crate::api::{PrChecks, PrFilter, PrInfo, PrState, PullRequest, RepoId};

/// The PR fields both `PullRequest` and `PrInfo` read.
pub(crate) const PR_FRAGMENT: &str = "fragment pr on PullRequest { number title url state isDraft isCrossRepository headRefName \
baseRefName additions deletions changedFiles updatedAt author { login } commits(last: 1) { nodes { commit { statusCheckRollup { \
contexts(first: 100) { nodes { ... on CheckRun { name status conclusion startedAt checkSuite { workflowRun { workflow { name } } } } \
... on StatusContext { context state createdAt } } } } } } } }";

/// The check runs and statuses of a PR from `PR_FRAGMENT`.
fn rollup(pr: &Value) -> &[Value] {
    pr["commits"]["nodes"][0]["commit"]["statusCheckRollup"]["contexts"]["nodes"].as_array().map_or(&[][..], Vec::as_slice)
}

/// A deleted account shows as null.
pub(crate) fn author(pr: &Value) -> String {
    pr["author"]["login"].as_str().unwrap_or("ghost").to_owned()
}

async fn folder_repo(folder: &Path) -> anyhow::Result<RepoId> {
    super::repos::origin_repo(folder).await.ok_or_else(|| crate::error::invalid(format!("{} has no GitHub remote", folder.display())))
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
    let rollup = latest_runs(rollup);
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
fn check_counts(rollup: &[serde_json::Value]) -> (u32, u32) {
    let rollup = latest_runs(rollup);
    (rollup.iter().filter(|c| check_passed(c) == Some(true)).count() as u32, rollup.len() as u32)
}

/// The newest run of each check, as GitHub shows them. A commit keeps the runs a re-run or a newer
/// push replaced (often `CANCELLED`); they must not count. Key: workflow + check name (`context` for
/// a commit status). Newest: latest `startedAt`/`createdAt`; no time yet (queued) is newest. Entries
/// without a name stay.
fn latest_runs(rollup: &[serde_json::Value]) -> Vec<&serde_json::Value> {
    let text = |c: &serde_json::Value, k: &str| c[k].as_str().filter(|s| !s.is_empty()).map(str::to_owned);
    let key = |c: &serde_json::Value| {
        let name = text(c, "name").or_else(|| text(c, "context"))?;
        let workflow = text(c, "workflowName").or_else(|| text(&c["checkSuite"]["workflowRun"]["workflow"], "name"));
        Some((workflow.unwrap_or_default(), name))
    };
    let time = |c: &serde_json::Value| text(c, "startedAt").or_else(|| text(c, "createdAt"));
    let newer = |a: &serde_json::Value, b: &serde_json::Value| match (time(a), time(b)) {
        (None, _) => true,
        (Some(_), None) => false,
        (Some(a), Some(b)) => a >= b,
    };
    let mut out: Vec<&serde_json::Value> = vec![];
    let mut keys: Vec<Option<(String, String)>> = vec![];
    for c in rollup {
        let k = key(c);
        match k.as_ref().and_then(|k| keys.iter().position(|o| o.as_ref() == Some(k))) {
            Some(i) if newer(c, out[i]) => out[i] = c,
            Some(_) => {}
            None => {
                out.push(c);
                keys.push(k);
            }
        }
    }
    out
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
    pull_request(&data["repository"]["pullRequest"]).ok_or_else(|| crate::error::not_found(format!("PR #{number} not found in {}/{}", repo.owner, repo.name)))
}

/// Checks the PR out in `dir` (a fresh detached Worktree, or a clean folder): on its head branch
/// name when that is free, else on `fallback`. Returns the branch.
pub async fn checkout_pr(dir: &Path, number: u32, fallback: &str) -> anyhow::Result<String> {
    let n = number.to_string();
    if gh(dir, &["pr", "checkout", &n]).await.is_err() {
        gh(dir, &["pr", "checkout", &n, "--branch", fallback]).await?;
    }
    crate::git::current_branch(dir).await?.ok_or_else(|| anyhow::anyhow!("PR #{number} checkout left HEAD detached"))
}

/// A PR just opened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreatedPr {
    pub number: u32,
    pub url: String,
}

/// Opens a PR in `repo` from the branch checked out in `folder`. `head` is `branch`, or `owner:branch` when the branch
/// was pushed to a fork.
pub async fn create_pr(folder: &Path, repo: &RepoId, head: &str, base: &str, title: &str, body: &str, draft: bool) -> anyhow::Result<CreatedPr> {
    let slug = format!("{}/{}", repo.owner, repo.name);
    let mut args = vec!["pr", "create", "--repo", &slug, "--head", head, "--base", base, "--title", title, "--body", body];
    if draft {
        args.push("--draft");
    }
    let out = gh(folder, &args).await?;
    parse_created(&out).ok_or_else(|| anyhow::anyhow!("gh pr create: no PR URL in its output: {}", out.trim()))
}

/// The PR URL `gh pr create` prints (its last line, `.../pull/<n>`).
fn parse_created(out: &str) -> Option<CreatedPr> {
    let url = out.lines().rev().map(str::trim).find(|l| l.starts_with("http") && l.contains("/pull/"))?;
    let number = url.rsplit('/').next()?.parse().ok()?;
    Some(CreatedPr { number, url: url.to_owned() })
}

/// PRs of a `headRefName` result, minus fork PRs: `headRefName` matches the branch name in any fork (a fork's `main` too).
pub(super) fn branch_prs(repo: &RepoId, list: &[Value]) -> Vec<PrInfo> {
    list.iter().filter(|v| v["isCrossRepository"] != true).filter_map(|v| pr_info(repo, v)).collect()
}

/// A PR from `PR_FRAGMENT`.
pub(super) fn pr_info(repo: &RepoId, v: &Value) -> Option<PrInfo> {
    let rollup = rollup(v);
    let (checks_passed, checks_total) = check_counts(rollup);
    let num = |k: &str| v[k].as_u64().unwrap_or(0) as u32;
    let text = |k: &str| v[k].as_str().unwrap_or_default().to_owned();
    let state = match (v["state"].as_str()?, v["isDraft"].as_bool().unwrap_or(false)) {
        ("MERGED", _) => PrState::Merged,
        ("CLOSED", _) => PrState::Closed,
        (_, true) => PrState::Draft,
        _ => PrState::Open,
    };
    Some(PrInfo {
        repo: repo.clone(),
        number: v["number"].as_u64()? as u32,
        title: text("title"),
        author: author(v),
        state,
        checks: checks(rollup),
        checks_passed,
        checks_total,
        additions: num("additions"),
        deletions: num("deletions"),
        changed_files: num("changedFiles"),
        updated_at: text("updatedAt"),
        url: text("url"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn repo(o: &str, n: &str) -> RepoId {
        RepoId { owner: o.into(), name: n.into() }
    }

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

    #[test]
    fn ignores_replaced_runs() {
        // Flat shape (`workflowName`): a cancelled first run, then the re-run of the same check.
        let rollup = [
            json!({"name": "test", "workflowName": "CI", "conclusion": "CANCELLED", "startedAt": "2026-11-13T08:50:15Z"}),
            json!({"name": "lint", "workflowName": "CI", "conclusion": "CANCELLED", "startedAt": "2026-11-13T08:50:15Z"}),
            json!({"name": "test", "workflowName": "CI", "conclusion": "SUCCESS", "startedAt": "2026-11-13T08:50:22Z"}),
            json!({"name": "lint", "workflowName": "CI", "status": "QUEUED", "conclusion": ""}),
            json!({"name": "test", "workflowName": "Other", "conclusion": "SUCCESS", "startedAt": "2026-11-13T08:40:00Z"}),
        ];
        assert_eq!(checks(&rollup), PrChecks::Pending);
        assert_eq!(check_counts(&rollup), (2, 3));
        // GraphQL shape: the workflow name sits under checkSuite. Order does not matter.
        let wf = json!({"workflowRun": {"workflow": {"name": "CI"}}});
        let rollup = [
            json!({"name": "test", "checkSuite": wf, "conclusion": "SUCCESS", "startedAt": "2026-11-13T08:50:22Z"}),
            json!({"name": "test", "checkSuite": wf, "conclusion": "CANCELLED", "startedAt": "2026-11-13T08:50:15Z"}),
            json!({"context": "ci/x", "state": "FAILURE", "createdAt": "2026-11-13T08:00:00Z"}),
            json!({"context": "ci/x", "state": "SUCCESS", "createdAt": "2026-11-13T09:00:00Z"}),
        ];
        assert_eq!(checks(&rollup), PrChecks::Passing);
        assert_eq!(check_counts(&rollup), (2, 2));
    }

    #[test]
    fn reads_states_and_checks() {
        let r = repo("supabase", "spark");
        let state = |s: &str, draft: bool| pr_info(&r, &json!({"number": 1, "state": s, "isDraft": draft})).unwrap().state;
        assert_eq!(state("OPEN", false), PrState::Open);
        assert_eq!(state("OPEN", true), PrState::Draft);
        assert_eq!(state("MERGED", false), PrState::Merged);
        assert_eq!(state("CLOSED", true), PrState::Closed);
        let p = pr_info(
            &r,
            &json!({"number": 4, "state": "OPEN", "isDraft": false, "author": null, "commits": {"nodes": [{"commit": {"statusCheckRollup":
            {"contexts": {"nodes": [{"conclusion": "SUCCESS"}, {"status": "IN_PROGRESS", "conclusion": null}]}}}}]}}),
        )
        .unwrap();
        assert_eq!((p.author.as_str(), p.checks, p.checks_passed, p.checks_total), ("ghost", PrChecks::Pending, 1, 2));
        assert_eq!(pr_info(&r, &Value::Null), None);
    }

    #[test]
    fn reads_the_created_pr() {
        let got = parse_created("Warning: 1 uncommitted change\n\nhttps://github.com/o/r/pull/176\n").unwrap();
        assert_eq!((got.number, got.url.as_str()), (176, "https://github.com/o/r/pull/176"));
        assert_eq!(parse_created("nothing"), None);
    }

    #[test]
    fn branch_prs_skip_forks() {
        let r = repo("tursodatabase", "turso");
        let list = [json!({"number": 11497, "state": "CLOSED", "isCrossRepository": true}), json!({"number": 12, "state": "OPEN", "isCrossRepository": false})];
        assert_eq!(branch_prs(&r, &list).iter().map(|p| p.number).collect::<Vec<_>>(), [12]);
    }
}
