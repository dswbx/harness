//! Pull requests via the GitHub CLI (`gh`): listing them, and checking one out in a Worktree.

use std::path::Path;

use serde::Deserialize;

use crate::api::{PrChecks, PrFilter, PullRequest};

async fn gh(dir: &Path, args: &[&str]) -> anyhow::Result<String> {
    gh_in(Some(dir), args).await
}

/// `gh` in `dir`, or anywhere (for `--repo` and `gh api` calls).
pub(crate) async fn gh_in(dir: Option<&Path>, args: &[&str]) -> anyhow::Result<String> {
    let out = gh_output(dir, args).await?;
    if !out.status.success() {
        anyhow::bail!("gh {}: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Like `gh_in` without a folder, but keeps the output of a failed call when there is any: `gh api graphql` exits 1
/// when some fields could not be resolved (a missing PR) and still prints the `data` it has.
pub(crate) async fn gh_lenient(args: &[&str]) -> anyhow::Result<String> {
    let out = gh_output(None, args).await?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    if !out.status.success() && stdout.trim().is_empty() {
        anyhow::bail!("gh {}: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(stdout.into_owned())
}

async fn gh_output(dir: Option<&Path>, args: &[&str]) -> anyhow::Result<std::process::Output> {
    let mut cmd = tokio::process::Command::new("gh");
    if let Some(dir) = dir {
        cmd.current_dir(dir);
    }
    cmd.args(args)
        .env("PATH", crate::env::login_path())
        .env("GH_PROMPT_DISABLED", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .map_err(|e| anyhow::anyhow!("gh: {e} (is the GitHub CLI installed?)"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhPr {
    number: u32,
    title: String,
    author: GhAuthor,
    head_ref_name: String,
    base_ref_name: String,
    is_draft: bool,
    is_cross_repository: bool,
    #[serde(default)]
    status_check_rollup: Vec<serde_json::Value>,
    updated_at: String,
}

#[derive(Deserialize)]
struct GhAuthor {
    login: String,
}

const FIELDS: &str = "number,title,author,headRefName,baseRefName,isDraft,isCrossRepository,statusCheckRollup,updatedAt";

pub async fn list_prs(folder: &Path, filter: PrFilter) -> anyhow::Result<Vec<PullRequest>> {
    let mut args = vec!["pr", "list", "--limit", "50", "--json", FIELDS];
    match filter {
        PrFilter::Open => {}
        PrFilter::Mine => args.extend(["--author", "@me"]),
        PrFilter::ReviewRequested => args.extend(["--search", "review-requested:@me"]),
    }
    let prs: Vec<GhPr> = serde_json::from_str(&gh(folder, &args).await?)?;
    Ok(prs.into_iter().map(into_pr).collect())
}

fn into_pr(p: GhPr) -> PullRequest {
    PullRequest {
        checks: checks(&p.status_check_rollup),
        number: p.number,
        title: p.title,
        author: p.author.login,
        head: p.head_ref_name,
        base: p.base_ref_name,
        draft: p.is_draft,
        fork: p.is_cross_repository,
        updated_at: p.updated_at,
    }
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
    let n = number.to_string();
    Ok(into_pr(serde_json::from_str(&gh(folder, &["pr", "view", &n, "--json", FIELDS]).await?)?))
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
