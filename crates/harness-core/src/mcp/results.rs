//! The text the Harness MCP tools answer with, and `HarnessResult`, the same facts typed.
//!
//! Tool output is text for the Agent. Views need what it says (the commit's hash, the branch
//! pushed, the Sub Session's id), so the core reads its own text back here when the call's output
//! arrives and puts the result on the Event. A string that is reworded must be reworded in its
//! reader too: the tests pin both against `tests/cases/harness_result.json`, which `@harness/api`
//! (`harnessResult`, the reader for logs recorded before the typed field) runs as well.

use serde_json::Value;

use crate::api::{HarnessResult, ListedSubSession, SubSessionState};

/// The `git_commit` answer.
pub(super) fn committed_text(hash: &str) -> String {
    format!("Committed {hash}")
}

/// The `git_push` answer.
pub(super) fn pushed_text(branch: &str) -> String {
    format!("Pushed {branch}.")
}

/// The typed result of Harness tool `tool`, out of the call as tracked (`content`, `rawOutput`).
/// None while there is no output, for a failure (the Harness wraps its text in a code fence) and
/// for a tool whose answer carries nothing a View shows.
pub(crate) fn result_of(tool: &str, call: &Value) -> Option<HarnessResult> {
    let texts: Vec<String> = [text_of(call.get("content")), text_of(call.get("rawOutput"))].into_iter().flatten().collect();
    let text = texts.iter().find(|t| !fenced(t))?;
    match tool {
        "git_commit" => committed(text).map(|hash| HarnessResult::GitCommit { hash }),
        "git_push" => pushed(text).map(|branch| HarnessResult::GitPush { branch }),
        "git_status" => {
            let v: Value = serde_json::from_str(text).ok().filter(|v: &Value| v.is_object() || v.is_array())?;
            let branch = v.get("branch").and_then(Value::as_str).filter(|b| !b.is_empty()).map(str::to_owned);
            let changed = v.get("files").and_then(Value::as_array).map(|f| f.len() as u32);
            Some(HarnessResult::GitStatus { branch, changed })
        }
        "git_diff" if !text.is_empty() => {
            let (mut additions, mut deletions) = (0, 0);
            for l in text.split('\n') {
                if l.starts_with('+') && !l.starts_with("+++") {
                    additions += 1;
                } else if l.starts_with('-') && !l.starts_with("---") {
                    deletions += 1;
                }
            }
            Some(HarnessResult::GitDiff { additions, deletions })
        }
        "list_branches" => {
            let v: Value = serde_json::from_str(text).ok()?;
            v.as_array().map(|b| HarnessResult::ListBranches { count: b.len() as u32 })
        }
        "session_start" | "session_send" | "session_wait" => {
            let v: Value = serde_json::from_str(text).ok().filter(Value::is_object)?;
            let s = |k: &str| str_of(&v[k]);
            Some(HarnessResult::SubSession {
                session_id: s("session_id"),
                title: s("title"),
                repo: s("repo").or_else(|| s("folder")),
                branch: s("branch"),
                model: s("model"),
                effort: s("effort"),
                reply: v["reply"].as_str().filter(|r| !r.trim().is_empty()).map(str::to_owned),
                duration_ms: v["duration_ms"].as_f64().map(|n| n as i64),
                stop_reason: s("stop_reason"),
                status: state_of(&v["status"]),
            })
        }
        "session_list" => {
            let v: Value = serde_json::from_str(text).ok().filter(Value::is_object)?;
            let rows = v.get("sub_sessions")?.as_array()?;
            let sessions = rows
                .iter()
                .filter_map(|row| {
                    Some(ListedSubSession {
                        session_id: str_of(&row["session_id"])?,
                        title: str_of(&row["title"]),
                        repo: str_of(&row["repo"]).or_else(|| str_of(&row["folder"])),
                        status: state_of(&row["status"]),
                        archived: row["archived"] == Value::Bool(true),
                    })
                })
                .collect();
            Some(HarnessResult::SubSessionList { sessions })
        }
        _ => None,
    }
}

fn str_of(v: &Value) -> Option<String> {
    v.as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned)
}

fn state_of(v: &Value) -> Option<SubSessionState> {
    match v.as_str()? {
        "idle" => Some(SubSessionState::Idle),
        "needs_attention" => Some(SubSessionState::NeedsAttention),
        "working" => Some(SubSessionState::Working),
        _ => None,
    }
}

/// The text of a `rawOutput` (a string, or text blocks) or of ACP `content` blocks, joined.
fn text_of(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::String(s) => Some(s.clone()),
        Value::Array(blocks) => {
            let parts: Vec<&str> = blocks
                .iter()
                .filter_map(|b| {
                    let inner = if b["type"] == "content" { &b["content"] } else { b };
                    if inner["type"] == "text" { inner["text"].as_str() } else { None }
                })
                .collect();
            (!parts.is_empty()).then(|| parts.join("\n"))
        }
        _ => None,
    }
}

/// A text that is one code fence: the Harness wraps a failure's text in it.
fn fenced(t: &str) -> bool {
    let t = t.trim();
    let ticks = t.len() - t.trim_start_matches('`').len();
    if ticks < 3 {
        return false;
    }
    let (fence, rest) = t.split_at(ticks);
    rest.split_once('\n').is_some_and(|(lang, body)| lang.chars().all(|c| c.is_ascii_alphanumeric() || "_+#.-".contains(c)) && body.ends_with(fence))
}

/// `Committed <hash>`: the hash (7 to 40 hex digits).
fn committed(text: &str) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    lower.match_indices("committed").find_map(|(at, word)| {
        let rest = &text[at + word.len()..];
        let hash = rest.trim_start();
        (hash.len() < rest.len()).then_some(())?;
        let hex: String = hash.chars().take_while(char::is_ascii_hexdigit).take(40).collect();
        (hex.len() >= 7).then_some(hex)
    })
}

/// A line `Pushed <branch>.`: the branch.
fn pushed(text: &str) -> Option<String> {
    text.split('\n').find_map(|line| {
        let rest = line.strip_prefix("Pushed")?;
        rest.starts_with(char::is_whitespace).then_some(())?;
        let rest = rest.trim();
        let branch = rest.strip_suffix('.').filter(|b| !b.is_empty()).unwrap_or(rest);
        (!branch.is_empty()).then(|| branch.to_owned())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The table `@harness/api` runs too: tool, output as the Agent sent it, typed result.
    #[test]
    fn harness_result_cases() {
        let cases: Vec<Value> = serde_json::from_str(include_str!("../../tests/cases/harness_result.json")).unwrap();
        assert!(cases.len() > 10);
        for c in cases {
            let got = result_of(c["tool"].as_str().unwrap(), &c["call"]).map(|r| serde_json::to_value(r).unwrap());
            assert_eq!(got.unwrap_or(Value::Null), c["result"], "{}", c["name"]);
        }
    }

    /// The strings the tools answer with are read back: rewording one without its reader fails here.
    #[test]
    fn the_texts_the_tools_write_are_read_back() {
        let out = |text: String| json!({ "content": [{ "type": "content", "content": { "type": "text", "text": text } }] });
        let hash = "0123456789abcdef0123456789abcdef01234567";
        assert_eq!(result_of("git_commit", &out(committed_text(hash))), Some(HarnessResult::GitCommit { hash: hash.into() }));
        for branch in ["main", "harness/fix-it-1", "release/1.2.x"] {
            assert_eq!(result_of("git_push", &out(pushed_text(branch))), Some(HarnessResult::GitPush { branch: branch.into() }), "{branch}");
        }
    }
}
