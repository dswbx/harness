//! The GitHub CLI helper, the token, and the HTTP and GraphQL calls.

use std::path::Path;
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde_json::{Value, json};

pub(super) async fn gh(dir: &Path, args: &[&str]) -> anyhow::Result<String> {
    gh_in(Some(dir), args).await
}

/// `gh` in `dir`, or anywhere. Bounded: a hang (a prompt, the network) fails with a timeout error.
pub(crate) async fn gh_in(dir: Option<&Path>, args: &[&str]) -> anyhow::Result<String> {
    let mut opts = crate::proc::Opts::new(timeout_for(args))
        .args(args)
        .env("PATH", crate::env::login_path())
        .env("GH_PROMPT_DISABLED", "1")
        .env("GIT_TERMINAL_PROMPT", "0");
    if let Some(dir) = dir {
        opts = opts.cwd(dir);
    }
    let out = crate::proc::run("gh", opts).await.map_err(|e| match e {
        crate::proc::ProcError::Spawn { source, .. } => anyhow::anyhow!("gh: {source} (is the GitHub CLI installed?)"),
        e => anyhow::anyhow!("gh {}: {e}", args.join(" ")),
    })?;
    if !out.success() {
        anyhow::bail!("gh {}: {}", args.join(" "), out.stderr_lossy().trim());
    }
    Ok(out.stdout_lossy())
}

/// Queries keep the short limit; `pr create`/`merge`/`checkout` and anything not listed push or wait.
const GH_READ_ONLY: &[(&str, &str)] = &[
    ("auth", "token"),
    ("api", ""),
    ("pr", "view"),
    ("pr", "list"),
    ("pr", "status"),
    ("pr", "diff"),
    ("pr", "checks"),
    ("repo", "view"),
    ("issue", "view"),
    ("issue", "list"),
];

fn timeout_for(args: &[&str]) -> Duration {
    let (a, b) = (args.first().copied().unwrap_or(""), args.get(1).copied().unwrap_or(""));
    if GH_READ_ONLY.iter().any(|(x, y)| *x == a && (y.is_empty() || *y == b)) { crate::proc::NETWORK } else { crate::proc::GH_LONG }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gh_timeouts_by_subcommand() {
        for a in [&["pr", "view", "1"][..], &["auth", "token"], &["api", "graphql"], &["pr", "list"]] {
            assert_eq!(timeout_for(a), crate::proc::NETWORK, "{a:?}");
        }
        for a in [&["pr", "create"][..], &["pr", "merge", "1"], &["pr", "checkout", "1"], &["repo", "clone", "x"], &["unknown"]] {
            assert_eq!(timeout_for(a), crate::proc::GH_LONG, "{a:?}");
        }
    }
}
