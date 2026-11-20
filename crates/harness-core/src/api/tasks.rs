//! Task types (ADR 0028): the user's own work items, kept across Sessions in `<data dir>/tasks/`.
//! Not the Agent's Task List.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;

use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Backlog,
    #[default]
    Todo,
    InProgress,
    InReview,
    Done,
    Blocked,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum TaskPriority {
    #[default]
    None,
    Low,
    Medium,
    High,
    Urgent,
}

/// The task's item in another tracker (Linear, GitHub, ...).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct TaskUpstream {
    pub url: String,
    #[serde(default)]
    pub label: Option<String>,
}

/// A file in the task's `files/` folder; `name` is its file name there.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct TaskAsset {
    pub name: String,
    pub mime: String,
    #[specta(type = specta_typescript::Number)]
    pub size: u64,
}

/// A Session started from the task. `title` is cached for when the Session is gone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct TaskSessionLink {
    pub session_id: SessionId,
    pub title: String,
    #[specta(type = specta_typescript::Number)]
    pub started_ms: i64,
}

/// How a task depends on another (ADR 0029).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum TaskDepKind {
    /// This task cannot be done before the other one.
    Blocks,
    /// This task comes after the other one, but does not wait on it.
    FollowUp,
}

/// A Dependency, stored only on the task that waits (ADR 0029).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct TaskDep {
    /// The other task.
    pub id: String,
    pub kind: TaskDepKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TaskActivityKind {
    Created,
    /// The parent changed (`None`: no parent).
    Moved {
        from: Option<String>,
        to: Option<String>,
    },
    StatusChanged {
        from: TaskStatus,
        to: TaskStatus,
    },
    SessionStarted {
        session_id: SessionId,
    },
    /// A Dependency on `id` was added, or its kind changed.
    DepAdded {
        id: String,
        kind: TaskDepKind,
    },
    DepRemoved {
        id: String,
    },
    PropsChanged,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct TaskActivity {
    #[specta(type = specta_typescript::Number)]
    pub at_ms: i64,
    pub by: StateWriter,
    /// The Session it happened in, if any.
    pub session_id: Option<SessionId>,
    pub kind: TaskActivityKind,
}

/// `tasks/<id>/task.json` (`v: 1`). Fields added later take `serde(default)`; there are no migrations.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct Task {
    pub v: u32,
    /// `t<n>`; never changes.
    pub id: String,
    /// One line of Markdown.
    pub title: String,
    /// Markdown.
    pub body: String,
    pub status: TaskStatus,
    pub priority: TaskPriority,
    /// `YYYY-MM-DD`, a local date.
    pub due: Option<String>,
    pub upstream: Option<TaskUpstream>,
    pub parent_id: Option<String>,
    /// Position among its siblings (ascending).
    #[specta(type = specta_typescript::Number)]
    pub order: f64,
    /// The Session it was created in; kept after that Session is deleted.
    pub origin_session_id: Option<SessionId>,
    /// The origin Session's title when the task was created.
    pub origin_title: Option<String>,
    pub sessions: Vec<TaskSessionLink>,
    pub assets: Vec<TaskAsset>,
    #[specta(type = specta_typescript::Number)]
    pub created_ms: i64,
    /// Last change of any field.
    #[specta(type = specta_typescript::Number)]
    pub updated_ms: i64,
    /// Last change of `body`: `UpdateTask` checks `base_updated_ms` against it.
    #[specta(type = specta_typescript::Number)]
    pub body_updated_ms: i64,
    /// The last 100 entries, oldest first.
    pub activity: Vec<TaskActivity>,
    /// The tasks this task waits on or follows, in the order given (ADR 0029).
    #[serde(default)]
    pub deps: Vec<TaskDep>,
    /// Properties: free key-value pairs (ADR 0029).
    #[serde(default)]
    pub props: BTreeMap<String, String>,
}

/// One row of `ListTasks`: a `Task` without `body` and `activity`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct TaskSummary {
    pub id: String,
    pub title: String,
    pub has_body: bool,
    /// The start of the body as plain text, at most 160 characters; empty for an empty body.
    pub excerpt: String,
    pub status: TaskStatus,
    pub priority: TaskPriority,
    pub due: Option<String>,
    pub upstream: Option<TaskUpstream>,
    pub parent_id: Option<String>,
    #[specta(type = specta_typescript::Number)]
    pub order: f64,
    pub origin_session_id: Option<SessionId>,
    pub origin_title: Option<String>,
    pub sessions: Vec<TaskSessionLink>,
    pub assets: Vec<TaskAsset>,
    #[specta(type = specta_typescript::Number)]
    pub created_ms: i64,
    #[specta(type = specta_typescript::Number)]
    pub updated_ms: i64,
    pub deps: Vec<TaskDep>,
    pub props: BTreeMap<String, String>,
}

impl From<&Task> for TaskSummary {
    fn from(t: &Task) -> Self {
        Self {
            id: t.id.clone(),
            title: t.title.clone(),
            has_body: !t.body.trim().is_empty(),
            excerpt: excerpt(&t.body),
            status: t.status,
            priority: t.priority,
            due: t.due.clone(),
            upstream: t.upstream.clone(),
            parent_id: t.parent_id.clone(),
            order: t.order,
            origin_session_id: t.origin_session_id.clone(),
            origin_title: t.origin_title.clone(),
            sessions: t.sessions.clone(),
            assets: t.assets.clone(),
            created_ms: t.created_ms,
            updated_ms: t.updated_ms,
            deps: t.deps.clone(),
            props: t.props.clone(),
        }
    }
}

/// Most characters of `TaskSummary::excerpt`, with the "…".
const EXCERPT_MAX: usize = 160;

/// The start of a Markdown body as plain text: marks removed, code blocks and images skipped,
/// white space joined, cut at a word to at most `EXCERPT_MAX` characters with "…".
fn excerpt(body: &str) -> String {
    let mut text = String::new();
    let mut fence: Option<&str> = None;
    for line in body.lines() {
        let line = line.trim();
        if let Some(f) = fence {
            if line.starts_with(f) {
                fence = None;
            }
            continue;
        }
        if let Some(f) = ["```", "~~~"].into_iter().find(|f| line.starts_with(f)) {
            fence = Some(f);
            continue;
        }
        let rule = line.len() >= 3 && line.chars().all(|c| matches!(c, '-' | '*' | '_' | '=' | ' '));
        if rule {
            continue;
        }
        inline_text(&block_text(line).chars().collect::<Vec<_>>(), &mut text);
        text.push(' ');
        // Enough text for the cut.
        if text.chars().count() > 2 * EXCERPT_MAX {
            break;
        }
    }
    let mut out = String::new();
    let mut len = 0;
    let words: Vec<&str> = text.split_whitespace().collect();
    if words.iter().map(|w| w.chars().count() + 1).sum::<usize>() <= EXCERPT_MAX + 1 {
        return words.join(" ");
    }
    for w in words {
        let n = w.chars().count() + usize::from(len > 0);
        if len + n + 1 > EXCERPT_MAX {
            if len == 0 {
                // One long word: cut inside it.
                out.extend(w.chars().take(EXCERPT_MAX - 1));
            }
            break;
        }
        if len > 0 {
            out.push(' ');
        }
        out.push_str(w);
        len += n;
    }
    out.push('…');
    out
}

/// A line without its block marks: blockquote `>`, heading `#`, list bullet or number, checkbox.
fn block_text(mut line: &str) -> &str {
    loop {
        let before = line;
        line = line.trim_start();
        if let Some(rest) = line.strip_prefix('>') {
            line = rest;
        } else if line.starts_with('#') {
            let rest = line.trim_start_matches('#');
            if line.len() - rest.len() <= 6 && (rest.is_empty() || rest.starts_with(' ')) {
                line = rest;
            }
        } else if let Some(rest) = ["- ", "* ", "+ "].into_iter().find_map(|b| line.strip_prefix(b)) {
            line = rest;
        } else if let Some(rest) = ["[ ] ", "[x] ", "[X] "].into_iter().find_map(|b| line.strip_prefix(b)) {
            line = rest;
        } else {
            let digits = line.len() - line.trim_start_matches(|c: char| c.is_ascii_digit()).len();
            if (1..=9).contains(&digits) && (line[digits..].starts_with(". ") || line[digits..].starts_with(") ")) {
                line = &line[digits + 2..];
            }
        }
        if line == before {
            return line;
        }
    }
}

/// Appends the text of one line: emphasis marks and code ticks removed, link text kept, images
/// skipped, backslash escapes undone.
fn inline_text(c: &[char], out: &mut String) {
    let run = |i: usize| c[i..].iter().take_while(|&&x| x == c[i]).count();
    let mut i = 0;
    while i < c.len() {
        match c[i] {
            '\\' if c.get(i + 1).is_some_and(char::is_ascii_punctuation) => {
                out.push(c[i + 1]);
                i += 2;
            }
            '`' => {
                let n = run(i);
                let start = i + n;
                // The closing run of the same length.
                let end = (start..c.len()).find(|&j| c[j] == '`' && run(j) == n && (j == 0 || c[j - 1] != '`'));
                match end {
                    Some(end) => {
                        out.extend(&c[start..end]);
                        i = end + n;
                    }
                    None => i = start,
                }
            }
            '!' if c.get(i + 1) == Some(&'[') => match link(c, i + 1) {
                Some((_, end)) => i = end,
                None => {
                    out.push('!');
                    i += 1;
                }
            },
            '[' => match link(c, i) {
                Some((text, end)) => {
                    inline_text(text, out);
                    i = end;
                }
                None => {
                    out.push('[');
                    i += 1;
                }
            },
            '*' | '_' | '~' => {
                let n = run(i);
                let (prev, next) = (i.checked_sub(1).map(|p| c[p]), c.get(i + n).copied());
                let word = |x: Option<char>| x.is_some_and(char::is_alphanumeric);
                let space = |x: Option<char>| x.is_none_or(char::is_whitespace);
                // A mark touches a word on one side only; `snake_case` and a lone ` * ` stay.
                if (word(prev) && word(next)) || (space(prev) && space(next)) {
                    out.extend(&c[i..i + n]);
                }
                i += n;
            }
            ch => {
                out.push(ch);
                i += 1;
            }
        }
    }
}

/// A link at `c[at] == '['`: `[text](url)` or `[text][ref]`. Returns its text and the index after it.
fn link(c: &[char], at: usize) -> Option<(&[char], usize)> {
    let close = |open: char, shut: char, from: usize| {
        let mut depth = 0;
        for (j, &x) in c.iter().enumerate().skip(from) {
            if x == open {
                depth += 1;
            } else if x == shut {
                depth -= 1;
                if depth == 0 {
                    return Some(j);
                }
            }
        }
        None
    };
    let text_end = close('[', ']', at)?;
    let end = match c.get(text_end + 1)? {
        '(' => close('(', ')', text_end + 1)?,
        '[' => close('[', ']', text_end + 1)?,
        _ => return None,
    };
    Some((&c[at + 1..text_end], end + 1))
}

/// A field `TaskPatch::clear` sets to none.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum TaskField {
    Due,
    Upstream,
}

/// The fields `UpdateTask` changes; a missing field stays. The parent changes with `MoveTask`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
pub struct TaskPatch {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub status: Option<TaskStatus>,
    #[serde(default)]
    pub priority: Option<TaskPriority>,
    /// `YYYY-MM-DD`.
    #[serde(default)]
    pub due: Option<String>,
    #[serde(default)]
    pub upstream: Option<TaskUpstream>,
    /// Fields set to none (applied before the values above).
    #[serde(default)]
    pub clear: Vec<TaskField>,
    /// Replaces all Dependencies.
    #[serde(default)]
    pub deps: Option<Vec<TaskDep>>,
    /// Replaces all Properties.
    #[serde(default)]
    pub props: Option<BTreeMap<String, String>>,
}

/// "Start Session from a task": the Session is linked to the task, and the chosen parts of the
/// task go into its first prompt as context (ADR 0028).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct TaskStart {
    pub id: String,
    #[serde(default)]
    pub include: TaskContextParts,
    /// Set once when the Session starts; never set back.
    #[serde(default)]
    pub set_status: Option<TaskStatus>,
}

/// The parts of a task given to the new Session's Agent.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct TaskContextParts {
    /// Id, title, status, priority, due date and upstream link.
    #[serde(default)]
    pub summary: bool,
    /// The body, and the asset files as paths.
    #[serde(default)]
    pub body_and_assets: bool,
    /// The parent task and the other tasks under it.
    #[serde(default)]
    pub parent_and_siblings: bool,
    /// The Session Note of the Session the task was created in.
    #[serde(default)]
    pub origin_note: bool,
    /// A transcript of that Session's Main Thread (`summary::summarize`, capped).
    #[serde(default)]
    pub origin_transcript: bool,
}

/// A Session's Session Note (ADR 0028): `<session dir>/note.md`, with images in
/// `<session dir>/attachments/note/`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct Note {
    /// Markdown; empty when the note was never written.
    pub content: String,
    /// sha256 (hex) of `content`; `WriteNote` takes it back as `base_hash`.
    pub hash: String,
    /// When `note.md` was last written; none when it does not exist.
    #[specta(type = Option<specta_typescript::Number>)]
    pub updated_ms: Option<i64>,
    /// Absolute paths of the note's images, oldest first. `ReadAttachment` reads them.
    pub images: Vec<String>,
}
