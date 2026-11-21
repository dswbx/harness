//! The Task tools (ADR 0028): the user's own work items, kept across Sessions. Not the Agent's
//! Task List. The Agent adds Tasks with this Session as their origin, and changes only the Tasks
//! created in this Session or linked to it.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::results::TasksAnswer;
use crate::api::{ListedTask, StateWriter, Task, TaskDep, TaskDepKind, TaskField, TaskPatch, TaskPriority, TaskStatus, TaskSummary, TaskUpstream, ThreadId};
use crate::session::Session;
use crate::tasks::{Actor, NewTask};

/// Most rows `task_list` and `harness_info` return.
const MAX_ROWS: usize = 50;

/// The status and priority values (`TaskStatus`, `TaskPriority` as JSON), for the schemas.
pub(super) const STATUSES: [&str; 7] = ["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"];
pub(super) const PRIORITIES: [&str; 5] = ["none", "low", "medium", "high", "urgent"];

/// The tools of this module: their input is checked against their schema before they run.
pub(super) const TOOLS: [&str; 4] = ["task_add", "task_update", "task_list", "task_get"];

/// Refuses input that does not match the tool's schema, for example a `parent` that is not a
/// string (H15) or a `deps.add` item without an id. The error carries the description, as for
/// Frontend Tools: Agents may call a tool before they have loaded its schema.
pub(super) fn check_args(name: &str, description: &str, schema: &Value, args: &Value) -> anyhow::Result<()> {
    let (validator, _) = crate::frontend_files::validator(schema)?;
    let errors = crate::frontend_files::format_errors(&validator, &without_nulls(args));
    if errors.is_empty() {
        return Ok(());
    }
    Err(crate::error::invalid(format!("invalid input for {name}:\n{errors}\n\nHow to call {name}:\n{description}")))
}

/// `args` without its null object members: serde reads `null` as absent for an optional field,
/// so the schema check treats it the same way. Only the check sees this copy.
fn without_nulls(v: &Value) -> Value {
    match v {
        Value::Object(m) => Value::Object(m.iter().filter(|(_, v)| !v.is_null()).map(|(k, v)| (k.clone(), without_nulls(v))).collect()),
        Value::Array(a) => Value::Array(a.iter().map(without_nulls).collect()),
        v => v.clone(),
    }
}

/// Tasks by id, to look up the title and status of a Dependency.
type ById<'a> = HashMap<&'a str, &'a TaskSummary>;

fn by_id(tasks: &[TaskSummary]) -> ById<'_> {
    tasks.iter().map(|t| (t.id.as_str(), t)).collect()
}

/// Done and cancelled Tasks no longer hold anything up.
fn is_open(status: TaskStatus) -> bool {
    !matches!(status, TaskStatus::Done | TaskStatus::Cancelled)
}

/// How many Tasks `t` waits on: its `blocks` Dependencies that are still open.
fn waits_on(t: &TaskSummary, all: &ById) -> usize {
    t.deps.iter().filter(|d| d.kind == TaskDepKind::Blocks && all.get(d.id.as_str()).is_some_and(|o| is_open(o.status))).count()
}

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
fn row(session_id: &str, t: &TaskSummary, all: &ById) -> Value {
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
    let waits = waits_on(t, all);
    if waits > 0 {
        m.insert("waits_on".into(), json!(waits));
    }
    if !t.props.is_empty() {
        m.insert("props".into(), json!(t.props));
    }
    Value::Object(m)
}

/// This Session's Tasks for `harness_info`: created here or linked to it (started from), oldest
/// first.
pub(super) fn session_tasks(session: &Session) -> Vec<Value> {
    let id = session.id();
    let tasks = session.shared().tasks.list();
    let all = by_id(&tasks);
    tasks.iter().filter(|t| relation_of(&id, t).is_some()).map(|t| row(&id, t, &all)).take(MAX_ROWS).collect()
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

/// One `deps.add` item.
#[derive(Deserialize)]
struct DepInput {
    id: String,
    #[serde(default)]
    kind: Option<TaskDepKind>,
}

/// `deps` of task_add (only `add`) and task_update.
#[derive(Deserialize, Default)]
#[serde(default)]
struct DepsInput {
    add: Vec<DepInput>,
    remove: Vec<String>,
}

/// `current` with `input` applied: `remove` drops ids, `add` appends new ids (kind blocks by
/// default) and changes the kind of ids already there. An id named twice is refused, and so is
/// removing an id that is not a Dependency.
fn apply_deps(mut current: Vec<TaskDep>, input: DepsInput) -> anyhow::Result<Vec<TaskDep>> {
    let mut named: Vec<String> = Vec::new();
    let mut name = |id: &str| {
        let id = id.trim().to_owned();
        if named.contains(&id) {
            return Err(crate::error::invalid(format!("deps names task {id} twice")));
        }
        named.push(id.clone());
        Ok(id)
    };
    for id in input.remove {
        let id = name(&id)?;
        let before = current.len();
        current.retain(|d| d.id != id);
        if current.len() == before {
            let now: Vec<&str> = current.iter().map(|d| d.id.as_str()).collect();
            let now = if now.is_empty() { "none".to_owned() } else { now.join(", ") };
            return Err(crate::error::invalid(format!("cannot remove {id}: it is not a dependency (deps now: {now})")));
        }
    }
    for d in input.add {
        let id = name(&d.id)?;
        let kind = d.kind.unwrap_or(TaskDepKind::Blocks);
        match current.iter_mut().find(|c| c.id == id) {
            Some(c) => c.kind = kind,
            None => current.push(TaskDep { id, kind }),
        }
    }
    Ok(current)
}

/// `current` with `input` applied: a string sets a key, null removes it, other keys stay. The
/// store checks keys and values.
fn apply_props(mut current: BTreeMap<String, String>, input: BTreeMap<String, Option<String>>) -> BTreeMap<String, String> {
    for (k, v) in input {
        match v {
            Some(v) => current.insert(k, v),
            None => current.remove(&k),
        };
    }
    current
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
    #[serde(default)]
    deps: Option<DepsInput>,
    #[serde(default)]
    props: Option<BTreeMap<String, Option<String>>>,
}

pub(super) async fn run_task_add(session: &Arc<Session>, _: &ThreadId, args: &Value) -> anyhow::Result<String> {
    let list = args.get("tasks").filter(|v| !v.is_null()).ok_or_else(|| anyhow::anyhow!("tasks is required: a list of {{title, ...}}"))?;
    let items: Vec<NewItem> = serde_json::from_value(list.clone()).map_err(|e| anyhow::anyhow!("tasks must be a list of {{title, ...}}: {e}"))?;
    anyhow::ensure!(!items.is_empty(), "tasks is empty: give at least one {{title}}");
    let origin = (session.id(), session.meta().title);
    let new = items
        .into_iter()
        .enumerate()
        .map(|(n, i)| {
            let deps = apply_deps(Vec::new(), i.deps.unwrap_or_default()).map_err(|e| crate::error::invalid(format!("task {}: {e:#}", n + 1)))?;
            Ok(NewTask {
                title: i.title,
                body: i.body.unwrap_or_default(),
                parent_id: i.parent.filter(|p| !p.trim().is_empty()),
                status: i.status,
                priority: i.priority,
                due: i.due.filter(|d| !d.trim().is_empty()),
                upstream: i.upstream_url.filter(|u| !u.trim().is_empty()).map(|url| TaskUpstream { url, label: i.upstream_label }),
                origin: Some(origin.clone()),
                deps,
                props: apply_props(BTreeMap::new(), i.props.unwrap_or_default()),
            })
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
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
    deps: Option<DepsInput>,
    props: Option<BTreeMap<String, Option<String>>>,
}

pub(super) async fn run_task_update(session: &Arc<Session>, _: &ThreadId, args: &Value) -> anyhow::Result<String> {
    let a: UpdateArgs = serde_json::from_value(args.clone()).map_err(|e| anyhow::anyhow!("invalid arguments: {e}"))?;
    let id = a.id.filter(|i| !i.trim().is_empty()).ok_or_else(|| anyhow::anyhow!("id is required"))?;
    let tasks = &session.shared().tasks;
    let task = tasks.get(&id)?;
    ensure_own(session, &task)?;
    // `parent`: absent keeps it; null or "" moves the Task to the top level. `check_args` refused
    // any other type.
    let parent = args.get("parent").map(|p| p.as_str().map(str::trim).filter(|p| !p.is_empty()).map(str::to_owned));
    if let Some(Some(p)) = &parent {
        anyhow::ensure!(crate::tasks::is_id(p), crate::error::invalid(format!("{p:?} is not a task id")));
    }
    let deps = a.deps.map(|d| apply_deps(task.deps.clone(), d)).transpose()?;
    let props = a.props.map(|p| apply_props(task.props.clone(), p));
    let mut patch = TaskPatch { title: a.title, body: a.body, status: a.status, priority: a.priority, deps, props, ..Default::default() };
    match a.due {
        Some(d) if d.trim().is_empty() => patch.clear.push(TaskField::Due),
        d => patch.due = d,
    }
    if patch.title.as_deref().is_some_and(|t| t.trim().is_empty()) {
        return Err(crate::error::invalid("title cannot be empty"));
    }
    let fields = patch.title.is_some()
        || patch.body.is_some()
        || patch.status.is_some()
        || patch.priority.is_some()
        || patch.due.is_some()
        || !patch.clear.is_empty()
        || patch.deps.is_some()
        || patch.props.is_some();
    anyhow::ensure!(fields || parent.is_some(), "nothing to change: give status, title, body, priority, due, parent, deps or props");
    // Check the whole patch before any write, so a bad call changes nothing.
    crate::tasks::Tasks::check_patch(&patch)?;
    if let Some(deps) = &patch.deps {
        tasks.check_deps(&id, deps)?;
    }
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
    let every = session.shared().tasks.list();
    let ids = by_id(&every);
    let mut hits: Vec<&TaskSummary> = every
        .iter()
        .filter(|t| all || relation_of(&sid, t).is_some())
        .filter(|t| match status {
            None => true,
            Some(None) => is_open(t.status),
            Some(Some(s)) => t.status == s,
        })
        .filter(|t| query.as_deref().is_none_or(|q| t.title.to_lowercase().contains(q) || t.id == q))
        .collect();
    hits.sort_by_key(|t| std::cmp::Reverse(t.updated_ms));
    let total = hits.len();
    let rows: Vec<Value> = hits.iter().take(MAX_ROWS).map(|t| row(&sid, t, &ids)).collect();
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
    let every = tasks.list();
    let all = by_id(&every);
    let mut subtasks: Vec<&TaskSummary> = every.iter().filter(|c| c.parent_id.as_deref() == Some(t.id.as_str())).collect();
    subtasks.sort_by(|a, b| a.order.total_cmp(&b.order));
    let files = tasks.files_dir(&t.id)?;
    let assets: Vec<Value> =
        t.assets.iter().map(|a| json!({ "name": a.name, "mime": a.mime, "size": a.size, "path": files.join(&a.name).display().to_string() })).collect();
    let origin = t.origin_session_id.as_ref().map(|o| json!({ "session_id": o, "title": t.origin_title, "this_session": *o == sid }));
    let sessions: Vec<Value> =
        t.sessions.iter().map(|l| json!({ "session_id": l.session_id, "title": l.title, "this_session": l.session_id == sid })).collect();
    let can_update = ensure_own(session, &t).is_ok();
    // Dependencies both ways: the ones on this Task, and the Tasks whose deps name it.
    let short = |id: &str| match all.get(id) {
        Some(o) => json!({ "id": o.id, "title": o.title, "status": o.status }),
        None => json!({ "id": id }),
    };
    let on = |kind: TaskDepKind| t.deps.iter().filter(|d| d.kind == kind).map(|d| short(&d.id)).collect::<Vec<_>>();
    let of = |kind: TaskDepKind| every.iter().filter(|o| o.deps.iter().any(|d| d.id == t.id && d.kind == kind)).map(|o| short(&o.id)).collect::<Vec<_>>();
    let waits = all.get(t.id.as_str()).map_or(0, |s| waits_on(s, &all));
    let out = json!({
        "id": t.id, "title": t.title, "status": t.status, "priority": t.priority, "due": t.due, "upstream": t.upstream,
        "props": t.props, "blocked_by": on(TaskDepKind::Blocks), "waits_on": waits, "blocks": of(TaskDepKind::Blocks),
        "follows": on(TaskDepKind::FollowUp), "followed_by": of(TaskDepKind::FollowUp),
        "body": t.body, "parent": parent, "subtasks": subtasks.iter().map(|c| row(&sid, c, &all)).collect::<Vec<_>>(),
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
    fn deps_changes_apply_in_place_and_refuse_an_id_named_twice() {
        let dep = |id: &str, kind| TaskDep { id: id.into(), kind };
        let input = |v: Value| serde_json::from_value::<DepsInput>(v).unwrap();
        let now = vec![dep("t1", TaskDepKind::Blocks), dep("t2", TaskDepKind::Blocks)];
        let out = apply_deps(now.clone(), input(json!({ "add": [{ "id": "t3" }, { "id": "t1", "kind": "follow_up" }], "remove": ["t2"] }))).unwrap();
        assert_eq!(out, [dep("t1", TaskDepKind::FollowUp), dep("t3", TaskDepKind::Blocks)]);
        assert!(apply_deps(now.clone(), input(json!({ "add": [{ "id": "t3" }, { "id": "t3" }] }))).is_err());
        assert!(apply_deps(now, input(json!({ "add": [{ "id": "t1" }], "remove": ["t1"] }))).is_err());
    }

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
