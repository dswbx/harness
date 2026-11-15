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
        crate::proc::ProcError::Spawn { source, .. } => crate::error::unavailable(format!("gh: {source} (is the GitHub CLI installed?)")),
        e => crate::error::from_proc(&e, format!("gh {}: {e}", args.join(" "))),
    })?;
    if !out.success() {
        let message = format!("gh {}: {}", args.join(" "), out.stderr_lossy().trim());
        // `gh auth token` fails only when there is no token to give: any failure of it is "sign in".
        let sign_in = args == ["auth", "token"] || signed_out(&out.stderr_lossy());
        return Err(if sign_in { crate::error::auth_required(message) } else { anyhow::anyhow!(message) });
    }
    Ok(out.stdout_lossy())
}

/// Whether `gh` failed because the user is not signed in.
fn signed_out(stderr: &str) -> bool {
    stderr.contains("gh auth login") || stderr.contains("not logged in") || stderr.contains("HTTP 401")
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
    if t.is_empty() {
        return Err(crate::error::auth_required("gh: not signed in (run `gh auth login`)"));
    }
    *TOKEN.lock() = Some((Instant::now(), t.clone()));
    Ok(t)
}

/// The error for a failed response: signing in again or a missing thing is something the caller can act on.
fn status_error(status: reqwest::StatusCode, message: String) -> anyhow::Error {
    match status {
        reqwest::StatusCode::UNAUTHORIZED => crate::error::auth_required(message),
        reqwest::StatusCode::NOT_FOUND => crate::error::not_found(message),
        _ => anyhow::anyhow!(message),
    }
}

/// Sends a request with the token and returns the body of a 2xx response. On 401 it gets the token again and retries once.
async fn send(req: impl Fn() -> reqwest::RequestBuilder) -> anyhow::Result<String> {
    let mut retried = false;
    loop {
        let token = token().await?;
        let resp =
            req().bearer_auth(&token).header("accept", "application/vnd.github+json").header("x-github-api-version", "2022-11-28").send().await.map_err(
                |e| {
                    let message = format!("GitHub: {e}");
                    if e.is_timeout() {
                        crate::error::timeout(message)
                    } else if e.is_connect() {
                        crate::error::unavailable(message)
                    } else {
                        anyhow::anyhow!(message)
                    }
                },
            )?;
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
        return Err(status_error(status, format!("GitHub {status}: {}", msg.trim())));
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

    fn code(e: anyhow::Error) -> crate::api::ErrorCode {
        crate::api::HarnessError::from(e).code
    }

    #[test]
    fn a_signed_out_gh_and_a_rejected_token_ask_for_sign_in() {
        use crate::api::ErrorCode;
        assert!(signed_out("To get started with GitHub CLI, please run:  gh auth login"));
        assert!(signed_out("You are not logged in to any GitHub hosts."));
        assert!(!signed_out("GraphQL: Could not resolve to a Repository"));
        let status = |s: u16| code(status_error(reqwest::StatusCode::from_u16(s).unwrap(), "m".into()));
        assert_eq!(
            [status(401), status(404), status(403), status(500)],
            [ErrorCode::AuthRequired, ErrorCode::NotFound, ErrorCode::Internal, ErrorCode::Internal]
        );
    }

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
