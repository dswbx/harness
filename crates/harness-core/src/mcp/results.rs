//! The text the Harness MCP tools answer with, and `HarnessResult`, the same facts typed.
//!
//! Tool output is text for the Agent. Views need what it says (the commit's hash, the branch
//! pushed, the Sub Session's id), so the core reads its own text back here when the call's output
//! arrives and puts the result on the Event. A string that is reworded must be reworded in its
//! reader too: commit and push share `committed_text` / `pushed_text` with their parsers, the others
//! are serde types that the tools serialize and `result_of` deserializes (`SubSession*`, and
//! `GitStatus`), so renaming a key changes both. The tests also pin both against `tests/cases/harness_result.json`, which `@harness/api`
//! (`harnessResult`, the reader for logs recorded before the typed field) runs as well.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::api::{HarnessResult, ListedSubSession, SubSessionState};

/// The part of the `git_status` answer (the API's `GitStatus`, serialized) a result reads.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct GitStatusAnswer {
    branch: Option<String>,
    files: Option<Vec<serde::de::IgnoredAny>>,
}

/// The `session_start` answer. Every field is optional on reading: a log's answer may lack any.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct SubSessionStarted {
    pub session_id: Option<String>,
    pub title: Option<String>,
    pub folder: Option<String>,
    pub repo: Option<String>,
    pub branch: Option<String>,
    /// The Agent's name.
    pub agent: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
}

/// The `session_send` answer.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct SubSessionSent {
    pub session_id: Option<String>,
    pub title: Option<String>,
}

/// The `session_wait` answer.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct SubSessionWaited {
    pub session_id: Option<String>,
    pub title: Option<String>,
    pub status: Option<String>,
    pub duration_ms: Option<i64>,
    pub reply: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
}

/// The `session_list` answer.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct SubSessionListing {
    pub sub_sessions: Vec<SubSessionEntry>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct SubSessionEntry {
    pub session_id: Option<String>,
    pub title: Option<String>,
    pub folder: Option<String>,
    pub repo: Option<String>,
    pub branch: Option<String>,
    pub status: Option<String>,
    pub archived: bool,
}

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
            let v: GitStatusAnswer = object(text)?;
            let branch = v.branch.filter(|b| !b.is_empty());
            Some(HarnessResult::GitStatus { branch, changed: v.files.map(|f| f.len() as u32) })
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
            let v: Vec<serde::de::IgnoredAny> = serde_json::from_str(text).ok()?;
            Some(HarnessResult::ListBranches { count: v.len() as u32 })
        }
        "session_start" => {
            let v: SubSessionStarted = object(text)?;
            let s = |v: Option<String>| v.and_then(clean);
            Some(HarnessResult::SubSession {
                session_id: s(v.session_id),
                title: s(v.title),
                repo: s(v.repo).or_else(|| s(v.folder)),
                branch: s(v.branch),
                model: s(v.model),
                effort: s(v.effort),
                reply: None,
                duration_ms: None,
                stop_reason: None,
                status: None,
            })
        }
        "session_send" => {
            let v: SubSessionSent = object(text)?;
            Some(HarnessResult::SubSession {
                session_id: v.session_id.and_then(clean),
                title: v.title.and_then(clean),
                repo: None,
                branch: None,
                model: None,
                effort: None,
                reply: None,
                duration_ms: None,
                stop_reason: None,
                status: None,
            })
        }
        "session_wait" => {
            let v: SubSessionWaited = object(text)?;
            Some(HarnessResult::SubSession {
                session_id: v.session_id.and_then(clean),
                title: v.title.and_then(clean),
                repo: None,
                branch: None,
                model: None,
                effort: None,
                reply: v.reply.filter(|r| !r.trim().is_empty()),
                duration_ms: v.duration_ms,
                stop_reason: v.stop_reason.and_then(clean),
                status: v.status.as_deref().and_then(state_of),
            })
        }
        "session_list" => {
            let v: SubSessionListing = object(text)?;
            let sessions = v
                .sub_sessions
                .into_iter()
                .filter_map(|row| {
                    Some(ListedSubSession {
                        session_id: row.session_id.and_then(clean)?,
                        title: row.title.and_then(clean),
                        repo: row.repo.and_then(clean).or_else(|| row.folder.and_then(clean)),
                        status: row.status.as_deref().and_then(state_of),
                        archived: row.archived,
                    })
                })
                .collect();
            Some(HarnessResult::SubSessionList { sessions })
        }
        _ => None,
    }
}

/// `text` as a JSON object of type `T` (a derived reader would also take an array as a struct).
fn object<T: serde::de::DeserializeOwned>(text: &str) -> Option<T> {
    let v: Value = serde_json::from_str(text).ok().filter(Value::is_object)?;
    serde_json::from_value(v).ok()
}

fn clean(s: String) -> Option<String> {
    let t = s.trim();
    (!t.is_empty()).then(|| t.to_owned())
}

fn state_of(v: &str) -> Option<SubSessionState> {
    match v {
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

    /// The answers are the serde types, and their text is what the tools always wrote.
    #[test]
    fn the_answers_keep_their_wire_text() {
        let text = |v: Value| serde_json::to_string_pretty(&v).unwrap();
        let s = |v: &str| Some(v.to_owned());
        let started = SubSessionStarted {
            session_id: s("s2"),
            title: s("T"),
            folder: s("/w/t"),
            repo: None,
            branch: s("b"),
            agent: s("Codex"),
            model: None,
            effort: s("high"),
        };
        assert_eq!(
            text(serde_json::to_value(started).unwrap()),
            text(json!({ "session_id": "s2", "title": "T", "folder": "/w/t", "repo": null, "branch": "b", "agent": "Codex", "model": null, "effort": "high" }))
        );
        let sent = SubSessionSent { session_id: s("s2"), title: s("T") };
        assert_eq!(text(serde_json::to_value(sent).unwrap()), text(json!({ "session_id": "s2", "title": "T" })));
        let waited =
            |stop_reason| SubSessionWaited { session_id: s("s2"), title: s("T"), status: s("idle"), duration_ms: Some(5), reply: s("ok"), stop_reason };
        assert_eq!(
            text(serde_json::to_value(waited(s("end_turn"))).unwrap()),
            text(json!({ "session_id": "s2", "title": "T", "status": "idle", "duration_ms": 5, "reply": "ok", "stop_reason": "end_turn" }))
        );
        assert_eq!(
            text(serde_json::to_value(waited(None)).unwrap()),
            text(json!({ "session_id": "s2", "title": "T", "status": "idle", "duration_ms": 5, "reply": "ok" }))
        );
        let entry = SubSessionEntry { session_id: s("s2"), title: s("T"), folder: s("/w"), repo: None, branch: None, status: s("idle"), archived: true };
        assert_eq!(
            text(serde_json::to_value(SubSessionListing { sub_sessions: vec![entry] }).unwrap()),
            text(
                json!({ "sub_sessions": [{ "session_id": "s2", "title": "T", "folder": "/w", "repo": null, "branch": null, "status": "idle", "archived": true }] })
            )
        );
    }

    #[test]
    fn git_status_is_read_from_the_api_type() {
        let status = crate::api::GitStatus {
            branch: Some("main".into()),
            upstream: None,
            ahead: 1,
            behind: 0,
            files: vec![crate::api::FileChange { path: "a".into(), status: "M".into(), additions: Some(1), deletions: None }],
        };
        let call = json!({ "rawOutput": serde_json::to_string_pretty(&status).unwrap() });
        assert_eq!(result_of("git_status", &call), Some(HarnessResult::GitStatus { branch: Some("main".into()), changed: Some(1) }));
    }
}
