//! The Task tools (ADR 0028): the user's own work items, kept across Sessions. Not the Agent's
//! Task List. The Agent adds Tasks with this Session as their origin, and changes only the Tasks
//! created in this Session or linked to it.

use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::results::TasksAnswer;
use crate::api::{ListedTask, StateWriter, Task, TaskField, TaskPatch, TaskPriority, TaskStatus, TaskSummary, TaskUpstream, ThreadId};
use crate::session::Session;
use crate::tasks::{Actor, NewTask};

/// Most rows `task_list` and `harness_info` return.
const MAX_ROWS: usize = 50;

/// The status and priority values (`TaskStatus`, `TaskPriority` as JSON), for the schemas.
pub(super) const STATUSES: [&str; 7] = ["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"];
pub(super) const PRIORITIES: [&str; 5] = ["none", "low", "medium", "high", "urgent"];

fn actor(session: &Session) -> Actor {
    Actor { by: StateWriter::Agent, session_id: Some(session.id()) }
}

/// Tells every window which Tasks changed.
fn changed(session: &Session, ids: Vec<String>) {
    let shared = session.shared();
    shared.tasks.emit_changed(&shared.app_events, ids);
}

/// The answer of `task_add` and `task_update`: `{"tasks": [{id, title, status}]}`, which
/// `results::result_of` reads back for the chat card.
fn answer(tasks: &[Task]) -> anyhow::Result<String> {
    let tasks = tasks.iter().map(|t| ListedTask { id: t.id.clone(), title: t.title.clone(), status: t.status }).collect();
    Ok(serde_json::to_string_pretty(&TasksAnswer { tasks })?)
}

/// How a Task relates to the Session: created in it, linked to it (started from it), or neither.
fn relation(session_id: &str, origin: Option<&str>, linked: bool) -> Option<&'static str> {
    if origin == Some(session_id) {
        Some("created_here")
    } else if linked {
        Some("started_from")
    } else {
        None
    }
}

fn relation_of(session_id: &str, t: &TaskSummary) -> Option<&'static str> {
    relation(session_id, t.origin_session_id.as_deref(), t.sessions.iter().any(|l| l.session_id == session_id))
}

/// One Task as a short row; fields without a value are left out.
fn row(session_id: &str, t: &TaskSummary) -> Value {
    let mut m = Map::new();
    m.insert("id".into(), json!(t.id));
    m.insert("title".into(), json!(t.title));
    m.insert("status".into(), json!(t.status));
    if t.priority != TaskPriority::None {
        m.insert("priority".into(), json!(t.priority));
    }
    if let Some(due) = &t.due {
        m.insert("due".into(), json!(due));
    }
    if let Some(p) = &t.parent_id {
        m.insert("parent".into(), json!(p));
    }
    if let Some(u) = &t.upstream {
        m.insert("upstream_url".into(), json!(u.url));
    }
    if let Some(r) = relation_of(session_id, t) {
        m.insert("session".into(), json!(r));
    }
    Value::Object(m)
}

/// This Session's Tasks for `harness_info`: created here or linked to it (started from), oldest
/// first.
pub(super) fn session_tasks(session: &Session) -> Vec<Value> {
    let id = session.id();
    session.shared().tasks.list().iter().filter(|t| relation_of(&id, t).is_some()).map(|t| row(&id, t)).take(MAX_ROWS).collect()
}

/// Refuses a Task the Agent may not change: one not created in this Session and not linked to it.
fn ensure_own(session: &Session, task: &Task) -> anyhow::Result<()> {
    let sid = session.id();
    if relation(&sid, task.origin_session_id.as_deref(), task.sessions.iter().any(|l| l.session_id == sid)).is_some() {
        return Ok(());
    }
    Err(crate::error::invalid(format!(
        "task {} was not created in this Session and is not linked to it, so you cannot change it. Ask the user to change it.",
        task.id
    )))
}

#[derive(Deserialize)]
struct NewItem {
    title: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    status: Option<TaskStatus>,
    #[serde(default)]
    priority: Option<TaskPriority>,
    #[serde(default)]
    due: Option<String>,
    #[serde(default)]
    parent: Option<String>,
    #[serde(default)]
    upstream_url: Option<String>,
    #[serde(default)]
    upstream_label: Option<String>,
}

pub(super) async fn run_task_add(session: &Arc<Session>, _: &ThreadId, args: &Value) -> anyhow::Result<String> {
    let list = args.get("tasks").filter(|v| !v.is_null()).ok_or_else(|| anyhow::anyhow!("tasks is required: a list of {{title, ...}}"))?;
    let items: Vec<NewItem> = serde_json::from_value(list.clone()).map_err(|e| anyhow::anyhow!("tasks must be a list of {{title, ...}}: {e}"))?;
    anyhow::ensure!(!items.is_empty(), "tasks is empty: give at least one {{title}}");
    let origin = (session.id(), session.meta().title);
    let new = items
        .into_iter()
        .map(|i| NewTask {
            title: i.title,
            body: i.body.unwrap_or_default(),
            parent_id: i.parent.filter(|p| !p.trim().is_empty()),
            status: i.status,
            priority: i.priority,
            due: i.due.filter(|d| !d.trim().is_empty()),
            upstream: i.upstream_url.filter(|u| !u.trim().is_empty()).map(|url| TaskUpstream { url, label: i.upstream_label }),
            origin: Some(origin.clone()),
        })
        .collect();
    let (tasks, done) = session.shared().tasks.create_all(new, &actor(session));
    // Tell the windows also when a write error stopped the batch after some were created.
    if !tasks.is_empty() {
        changed(session, tasks.iter().map(|t| t.id.clone()).collect());
    }
    if let Err(e) = done {
        if tasks.is_empty() {
            return Err(e);
        }
        let ids: Vec<&str> = tasks.iter().map(|t| t.id.as_str()).collect();
        return Err(e.context(format!("created {} before this error; the rest were not created", ids.join(", "))));
    }
    answer(&tasks)
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct UpdateArgs {
    id: Option<String>,
    title: Option<String>,
    body: Option<String>,
    status: Option<TaskStatus>,
    priority: Option<TaskPriority>,
    /// `""` clears it.
    due: Option<String>,
}

pub(super) async fn run_task_update(session: &Arc<Session>, _: &ThreadId, args: &Value) -> anyhow::Result<String> {
    let a: UpdateArgs = serde_json::from_value(args.clone()).map_err(|e| anyhow::anyhow!("invalid arguments: {e}"))?;
    let id = a.id.filter(|i| !i.trim().is_empty()).ok_or_else(|| anyhow::anyhow!("id is required"))?;
    let tasks = &session.shared().tasks;
    let task = tasks.get(&id)?;
    ensure_own(session, &task)?;
    // `parent`: absent keeps it; null or "" moves the Task to the top level.
    let parent = args.get("parent").map(|p| p.as_str().map(str::trim).filter(|p| !p.is_empty()).map(str::to_owned));
    if let Some(Some(p)) = &parent {
        anyhow::ensure!(crate::tasks::is_id(p), crate::error::invalid(format!("{p:?} is not a task id")));
    }
    let mut patch = TaskPatch { title: a.title, body: a.body, status: a.status, priority: a.priority, ..Default::default() };
    match a.due {
        Some(d) if d.trim().is_empty() => patch.clear.push(TaskField::Due),
        d => patch.due = d,
    }
    if patch.title.as_deref().is_some_and(|t| t.trim().is_empty()) {
        return Err(crate::error::invalid("title cannot be empty"));
    }
    let fields =
        patch.title.is_some() || patch.body.is_some() || patch.status.is_some() || patch.priority.is_some() || patch.due.is_some() || !patch.clear.is_empty();
    anyhow::ensure!(fields || parent.is_some(), "nothing to change: give status, title, body, priority, due or parent");
    // Check the whole patch before any write, so a bad call changes nothing.
    crate::tasks::Tasks::check_patch(&patch)?;
    let actor = actor(session);
    // The move first: of the rest, it is the change most likely refused (a loop), and then
    // nothing changed.
    let moved = match &parent {
        Some(p) if *p != task.parent_id => Some(tasks.move_to(&id, p.as_deref(), None, &actor)?),
        _ => None,
    };
    let updated = if fields { tasks.update(&id, patch, None, &actor).map(Some) } else { Ok(None) };
    // Tell the windows whenever something was written, also when the update after a move failed.
    if moved.is_some() || matches!(updated, Ok(Some(_))) {
        changed(session, vec![id]);
    }
    let task = updated?.or(moved).unwrap_or(task);
    answer(&[task])
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct ListArgs {
    scope: Option<String>,
    status: Option<String>,
    query: Option<String>,
}

pub(super) async fn run_task_list(session: &Arc<Session>, _: &ThreadId, args: &Value) -> anyhow::Result<String> {
    let a: ListArgs = serde_json::from_value(args.clone()).map_err(|e| anyhow::anyhow!("invalid arguments: {e}"))?;
    let all = match a.scope.as_deref() {
        None | Some("session") => false,
        Some("all") => true,
        Some(o) => anyhow::bail!("scope must be session or all, not {o}"),
    };
    let status: Option<Option<TaskStatus>> = match a.status.as_deref() {
        None => None,
        Some("open") => Some(None),
        Some(s) => Some(Some(serde_json::from_value(json!(s)).map_err(|_| anyhow::anyhow!("status must be open or one of {}", STATUSES.join(", ")))?)),
    };
    let query = a.query.map(|q| q.trim().to_lowercase()).filter(|q| !q.is_empty());
    let sid = session.id();
    let mut hits: Vec<TaskSummary> = session
        .shared()
        .tasks
        .list()
        .into_iter()
        .filter(|t| all || relation_of(&sid, t).is_some())
        .filter(|t| match status {
            None => true,
            Some(None) => !matches!(t.status, TaskStatus::Done | TaskStatus::Cancelled),
            Some(Some(s)) => t.status == s,
        })
        .filter(|t| query.as_deref().is_none_or(|q| t.title.to_lowercase().contains(q) || t.id == q))
        .collect();
    hits.sort_by_key(|t| std::cmp::Reverse(t.updated_ms));
    let total = hits.len();
    let rows: Vec<Value> = hits.iter().take(MAX_ROWS).map(|t| row(&sid, t)).collect();
    let mut out = json!({ "tasks": rows });
    if total > MAX_ROWS {
        out["more"] = json!(format!("{} more not shown: narrow with status or query", total - MAX_ROWS));
    }
    Ok(serde_json::to_string_pretty(&out)?)
}

pub(super) async fn run_task_get(session: &Arc<Session>, _: &ThreadId, args: &Value) -> anyhow::Result<String> {
    let id = args.get("id").and_then(Value::as_str).filter(|i| !i.trim().is_empty()).ok_or_else(|| anyhow::anyhow!("id is required"))?;
    let tasks = &session.shared().tasks;
    let t = tasks.get(id.trim())?;
    let sid = session.id();
    let parent = t.parent_id.as_deref().map(|p| match tasks.get(p) {
        Ok(p) => json!({ "id": p.id, "title": p.title }),
        Err(_) => json!({ "id": p }),
    });
    let mut subtasks: Vec<TaskSummary> = tasks.list().into_iter().filter(|c| c.parent_id.as_deref() == Some(t.id.as_str())).collect();
    subtasks.sort_by(|a, b| a.order.total_cmp(&b.order));
    let files = tasks.files_dir(&t.id)?;
    let assets: Vec<Value> =
        t.assets.iter().map(|a| json!({ "name": a.name, "mime": a.mime, "size": a.size, "path": files.join(&a.name).display().to_string() })).collect();
    let origin = t.origin_session_id.as_ref().map(|o| json!({ "session_id": o, "title": t.origin_title, "this_session": *o == sid }));
    let sessions: Vec<Value> =
        t.sessions.iter().map(|l| json!({ "session_id": l.session_id, "title": l.title, "this_session": l.session_id == sid })).collect();
    let can_update = ensure_own(session, &t).is_ok();
    let out = json!({
        "id": t.id, "title": t.title, "status": t.status, "priority": t.priority, "due": t.due, "upstream": t.upstream,
        "body": t.body, "parent": parent, "subtasks": subtasks.iter().map(|c| row(&sid, c)).collect::<Vec<_>>(),
        "origin": origin, "sessions": sessions, "assets": assets, "can_update": can_update,
        "created_ms": t.created_ms, "updated_ms": t.updated_ms,
    });
    Ok(serde_json::to_string_pretty(&out)?)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "tests fail loudly")]
    use super::*;

    #[test]
    fn the_schema_values_are_the_enums() {
        for s in STATUSES {
            let parsed: TaskStatus = serde_json::from_value(json!(s)).unwrap();
            assert_eq!(json!(parsed), json!(s));
        }
        for p in PRIORITIES {
            let parsed: TaskPriority = serde_json::from_value(json!(p)).unwrap();
            assert_eq!(json!(parsed), json!(p));
        }
    }
}
