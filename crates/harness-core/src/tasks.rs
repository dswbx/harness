//! Tasks (ADR 0028): the user's own work items, kept across Sessions. Each Task is a folder
//! `<data dir>/tasks/<id>/` with `task.json` and, for assets, `files/`. The Host keeps every Task
//! in memory, read by a scan at startup; there is no catalog and there are no migrations.
//! All file access to Tasks stays in this module.

use parking_lot::{Mutex, RwLock};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use crate::api::{
    AttachmentInput, SessionId, StateWriter, Task, TaskActivity, TaskActivityKind, TaskAsset, TaskDep, TaskField, TaskPatch, TaskPriority, TaskSessionLink,
    TaskStatus, TaskSummary, TaskUpstream,
};

/// The folder in the data dir.
pub const DIR: &str = "tasks";
const FILE: &str = "task.json";
const FILES: &str = "files";
const VERSION: u32 = 1;
/// Activity entries kept per Task.
const MAX_ACTIVITY: usize = 100;
/// Largest asset file.
const MAX_ASSET: u64 = 25 * 1024 * 1024;
/// Most Properties per Task, and the longest key and value (ADR 0029).
const MAX_PROPS: usize = 16;
const MAX_PROP_KEY: usize = 32;
const MAX_PROP_VALUE: usize = 64;

/// Whether `id` is a Task id: `t<n>`, `n` a number without leading zeros.
pub fn is_id(id: &str) -> bool {
    number(id).is_some()
}

fn number(id: &str) -> Option<u64> {
    let n = id.strip_prefix('t')?;
    if n.is_empty() || n.len() > 18 || n.starts_with('0') || !n.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    n.parse().ok()
}

/// Who changes a Task, and in which Session.
#[derive(Debug, Clone)]
pub struct Actor {
    pub by: StateWriter,
    pub session_id: Option<SessionId>,
}

impl Actor {
    pub fn user() -> Self {
        Self { by: StateWriter::User, session_id: None }
    }
}

/// What `Tasks::create` takes. `origin`: the Session it is created in, with its title.
#[derive(Debug, Default)]
pub struct NewTask {
    pub title: String,
    pub body: String,
    pub parent_id: Option<String>,
    pub status: Option<TaskStatus>,
    pub priority: Option<TaskPriority>,
    pub due: Option<String>,
    pub upstream: Option<TaskUpstream>,
    pub deps: Vec<TaskDep>,
    pub props: BTreeMap<String, String>,
    pub origin: Option<(SessionId, String)>,
}

pub struct Tasks {
    dir: PathBuf,
    index: RwLock<BTreeMap<String, Task>>,
    /// Serializes writes; holds the number of the next new Task.
    write_lock: Mutex<u64>,
}

impl Tasks {
    /// Opens `dir` (made when missing) and reads its Tasks.
    pub fn open(dir: PathBuf) -> anyhow::Result<Self> {
        std::fs::create_dir_all(&dir)?;
        let (index, next) = scan(&dir);
        Ok(Self { dir, index: RwLock::new(index), write_lock: Mutex::new(next) })
    }

    fn folder(&self, id: &str) -> anyhow::Result<PathBuf> {
        if !is_id(id) {
            return Err(crate::error::invalid(format!("{id:?} is not a task id")));
        }
        Ok(self.dir.join(id))
    }

    pub fn get(&self, id: &str) -> anyhow::Result<Task> {
        self.index.read().get(id).cloned().ok_or_else(|| crate::error::not_found(format!("no task {id:?}")))
    }

    /// All Tasks, oldest first.
    pub fn list(&self) -> Vec<TaskSummary> {
        let mut tasks: Vec<TaskSummary> = self.index.read().values().map(TaskSummary::from).collect();
        tasks.sort_by_key(|t| number(&t.id));
        tasks
    }

    /// Tells every window that the Tasks `ids` changed, with their summaries read as the event is
    /// queued (see `AppEvents::emit_with`). A deleted id has no summary.
    pub fn emit_changed(&self, events: &crate::app_events::AppEvents, ids: Vec<String>) {
        events.emit_with(|| {
            let index = self.index.read();
            let tasks = ids.iter().filter_map(|id| index.get(id)).map(TaskSummary::from).collect();
            crate::api::AppEvent::TasksChanged { ids, tasks }
        });
    }

    /// The Tasks linked to `session` (it was started from them), oldest first. The link in
    /// `Task::sessions` is the one record of "started from".
    pub fn started_from(&self, session: &str) -> Vec<TaskSummary> {
        self.list().into_iter().filter(|t| t.sessions.iter().any(|l| l.session_id == session)).collect()
    }

    /// The ids of the Tasks that deleting `id` changes: its direct children, and the Tasks with a
    /// Dependency on it.
    pub fn delete_touches(&self, id: &str) -> Vec<String> {
        let index = self.index.read();
        index.values().filter(|t| t.id != id && (t.parent_id.as_deref() == Some(id) || t.deps.iter().any(|d| d.id == id))).map(|t| t.id.clone()).collect()
    }

    /// The folder of a Task's asset files (it may not exist yet).
    pub fn files_dir(&self, id: &str) -> anyhow::Result<PathBuf> {
        Ok(self.folder(id)?.join(FILES))
    }

    /// Creates each Task in order. Checks them all first, so a bad one creates none. A write error
    /// can still stop the batch half way: returns the Tasks created, and the error that stopped it.
    pub fn create_all(&self, new: Vec<NewTask>, actor: &Actor) -> (Vec<Task>, anyhow::Result<()>) {
        let checked = new.iter().enumerate().try_for_each(|(i, n)| {
            let at = |e: anyhow::Error| crate::error::invalid(format!("task {}: {e:#}", i + 1));
            clean_title(&n.title).map_err(at)?;
            n.due.as_deref().map(check_due).transpose().map_err(at)?;
            n.upstream.clone().map(check_upstream).transpose().map_err(at)?;
            if let Some(p) = &n.parent_id {
                self.get(p).map_err(at)?;
            }
            clean_props(n.props.clone()).map_err(at)?;
            // Keeps the error code (not_found for an unknown id) and adds the position.
            check_deps(&self.index.read(), "", &n.deps).map_err(|e| e.context(format!("task {}", i + 1)))?;
            Ok(())
        });
        let mut created = Vec::new();
        if let Err(e) = checked {
            return (created, Err(e));
        }
        for (i, n) in new.into_iter().enumerate() {
            match self.create(n, actor) {
                Ok(t) => created.push(t),
                Err(e) => return (created, Err(e.context(format!("task {}", i + 1)))),
            }
        }
        (created, Ok(()))
    }

    pub fn create(&self, new: NewTask, actor: &Actor) -> anyhow::Result<Task> {
        let title = clean_title(&new.title)?;
        let due = new.due.as_deref().map(check_due).transpose()?;
        let upstream = new.upstream.map(check_upstream).transpose()?;
        let props = clean_props(new.props)?;
        let mut next = self.write_lock.lock();
        if let Some(p) = &new.parent_id {
            self.get(p)?;
        }
        let id = format!("t{}", *next);
        check_deps(&self.index.read(), &id, &new.deps)?;
        let now = crate::log::now_ms();
        let (origin_session_id, origin_title) = new.origin.map_or((None, None), |(s, t)| (Some(s), Some(t)));
        let mut task = Task {
            v: VERSION,
            id: id.clone(),
            title,
            body: new.body,
            status: new.status.unwrap_or_default(),
            priority: new.priority.unwrap_or_default(),
            due,
            upstream,
            order: last_order(&self.index.read(), new.parent_id.as_deref(), &id),
            parent_id: new.parent_id,
            origin_session_id,
            origin_title,
            sessions: Vec::new(),
            assets: Vec::new(),
            created_ms: now,
            updated_ms: now,
            body_updated_ms: now,
            activity: Vec::new(),
            deps: new.deps,
            props,
        };
        record(&mut task, actor, now, TaskActivityKind::Created);
        let tmp = self.dir.join(format!(".new-{id}"));
        let made = std::fs::create_dir_all(&tmp)
            .map_err(anyhow::Error::from)
            .and_then(|()| write_task(&tmp, &task))
            .and_then(|()| Ok(std::fs::rename(&tmp, self.folder(&id)?)?));
        if let Err(e) = made {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err(e);
        }
        *next += 1;
        self.index.write().insert(id, task.clone());
        Ok(task)
    }

    /// Checks the fields of `patch` without writing, so a caller can refuse a bad patch before it
    /// writes anything else.
    pub fn check_patch(patch: &TaskPatch) -> anyhow::Result<()> {
        patch.title.as_deref().map(clean_title).transpose()?;
        patch.due.as_deref().map(check_due).transpose()?;
        patch.upstream.clone().map(check_upstream).transpose()?;
        patch.props.clone().map(clean_props).transpose()?;
        Ok(())
    }

    /// Checks `deps` as the new Dependencies of task `id` without writing, like `check_patch`.
    pub fn check_deps(&self, id: &str, deps: &[TaskDep]) -> anyhow::Result<()> {
        check_deps(&self.index.read(), id, deps)
    }

    /// Applies `patch`. A body change is refused when the body changed after `base_updated_ms`.
    pub fn update(&self, id: &str, patch: TaskPatch, base_updated_ms: Option<i64>, actor: &Actor) -> anyhow::Result<Task> {
        let title = patch.title.as_deref().map(clean_title).transpose()?;
        let due = patch.due.as_deref().map(check_due).transpose()?;
        let upstream = patch.upstream.map(check_upstream).transpose()?;
        let props = patch.props.map(clean_props).transpose()?;
        let _guard = self.write_lock.lock();
        let mut task = self.get(id)?;
        if let Some(deps) = &patch.deps {
            check_deps(&self.index.read(), id, deps)?;
        }
        let now = stamp(&task);
        if let Some(body) = patch.body
            && body != task.body
        {
            if base_updated_ms.is_some_and(|base| task.body_updated_ms > base) {
                return Err(crate::error::conflict(format!("the body of task {id} changed elsewhere: reload it")));
            }
            task.body = body;
            task.body_updated_ms = now;
        }
        for f in &patch.clear {
            match f {
                TaskField::Due => task.due = None,
                TaskField::Upstream => task.upstream = None,
            }
        }
        if let Some(t) = title {
            task.title = t;
        }
        if let Some(d) = due {
            task.due = Some(d);
        }
        if let Some(u) = upstream {
            task.upstream = Some(u);
        }
        if let Some(p) = patch.priority {
            task.priority = p;
        }
        if let Some(s) = patch.status
            && s != task.status
        {
            let kind = TaskActivityKind::StatusChanged { from: task.status, to: s };
            record(&mut task, actor, now, kind);
            task.status = s;
        }
        if let Some(deps) = patch.deps {
            let removed = task.deps.iter().filter(|d| !deps.iter().any(|n| n.id == d.id)).map(|d| TaskActivityKind::DepRemoved { id: d.id.clone() });
            // A new id, or a new kind for an id.
            let added = deps.iter().filter(|d| !task.deps.contains(d)).map(|d| TaskActivityKind::DepAdded { id: d.id.clone(), kind: d.kind });
            let kinds: Vec<TaskActivityKind> = removed.chain(added).collect();
            for kind in kinds {
                record(&mut task, actor, now, kind);
            }
            task.deps = deps;
        }
        if let Some(p) = props
            && p != task.props
        {
            record(&mut task, actor, now, TaskActivityKind::PropsChanged);
            task.props = p;
        }
        task.updated_ms = now;
        self.save(task)
    }

    /// Puts a Task under `parent` (`None`: top level), before its sibling `before` (`None`: last).
    /// Refuses the Task itself or one of its descendants as the parent. Keeps the origin.
    pub fn move_to(&self, id: &str, parent: Option<&str>, before: Option<&str>, actor: &Actor) -> anyhow::Result<Task> {
        let _guard = self.write_lock.lock();
        let mut task = self.get(id)?;
        let order = {
            let index = self.index.read();
            if let Some(p) = parent {
                anyhow::ensure!(index.contains_key(p), crate::error::not_found(format!("no task {p:?}")));
                if p == id || descends_from(&index, p, id) {
                    return Err(crate::error::invalid(format!("task {id} cannot move under itself or one of its subtasks")));
                }
            }
            match before {
                Some(b) => order_before(&index, parent, b, id)?,
                None => last_order(&index, parent, id),
            }
        };
        let now = stamp(&task);
        let to = parent.map(str::to_owned);
        if task.parent_id != to {
            let kind = TaskActivityKind::Moved { from: task.parent_id.clone(), to: to.clone() };
            record(&mut task, actor, now, kind);
            task.parent_id = to;
        }
        task.order = order;
        task.updated_ms = now;
        self.save(task)
    }

    /// Deletes a Task; its children move to its parent, after the parent's other children, and its
    /// id leaves the `deps` of other Tasks. Returns the ids of the changed Tasks. They are written
    /// first and the Task's folder is removed last, so a retry after a crash finishes the job.
    pub fn delete(&self, id: &str, actor: &Actor) -> anyhow::Result<Vec<String>> {
        let _guard = self.write_lock.lock();
        let task = self.get(id)?;
        let folder = self.folder(id)?;
        let (children, dependents, base) = {
            let index = self.index.read();
            let children: Vec<Task> = siblings(&index, Some(id), "").into_iter().cloned().collect();
            let dependents: Vec<Task> =
                index.values().filter(|t| t.id != id && t.parent_id.as_deref() != Some(id) && t.deps.iter().any(|d| d.id == id)).cloned().collect();
            (children, dependents, last_order(&index, task.parent_id.as_deref(), id))
        };
        let mut changed = Vec::new();
        let unlink = |t: &mut Task, now: i64| {
            if t.deps.iter().any(|d| d.id == id) {
                t.deps.retain(|d| d.id != id);
                record(t, actor, now, TaskActivityKind::DepRemoved { id: id.to_owned() });
            }
        };
        for (i, mut child) in children.into_iter().enumerate() {
            let now = stamp(&child);
            record(&mut child, actor, now, TaskActivityKind::Moved { from: Some(id.to_owned()), to: task.parent_id.clone() });
            unlink(&mut child, now);
            child.parent_id = task.parent_id.clone();
            child.order = base + i as f64;
            child.updated_ms = now;
            changed.push(child.id.clone());
            self.save(child)?;
        }
        for mut t in dependents {
            let now = stamp(&t);
            unlink(&mut t, now);
            t.updated_ms = now;
            changed.push(t.id.clone());
            self.save(t)?;
        }
        std::fs::remove_dir_all(&folder)?;
        self.index.write().remove(id);
        Ok(changed)
    }

    /// Copies `files` into the Task's `files/`. Names that are taken get a `-2`, `-3`, ... suffix.
    pub fn add_assets(&self, id: &str, files: Vec<AttachmentInput>) -> anyhow::Result<Task> {
        anyhow::ensure!(!files.is_empty(), crate::error::invalid("no files"));
        let loaded = files.into_iter().map(|f| crate::attachments::load(f, MAX_ASSET)).collect::<anyhow::Result<Vec<_>>>()?;
        let _guard = self.write_lock.lock();
        let mut task = self.get(id)?;
        let dir = self.folder(id)?.join(FILES);
        std::fs::create_dir_all(&dir)?;
        for (name, mime, bytes) in loaded {
            let name = free_name(&task.assets, &crate::attachments::safe_name(&name));
            crate::fsutil::write_atomic(&dir.join(&name), &bytes)?;
            task.assets.push(TaskAsset { name, mime, size: bytes.len() as u64 });
        }
        task.updated_ms = stamp(&task);
        self.save(task)
    }

    pub fn remove_asset(&self, id: &str, name: &str) -> anyhow::Result<Task> {
        let _guard = self.write_lock.lock();
        let mut task = self.get(id)?;
        let at = asset_at(&task, name)?;
        task.assets.remove(at);
        match std::fs::remove_file(self.folder(id)?.join(FILES).join(name)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
            _ => {}
        }
        task.updated_ms = stamp(&task);
        self.save(task)
    }

    /// An asset as `(mime, base64)`.
    pub fn read_asset(&self, id: &str, name: &str) -> anyhow::Result<(String, String)> {
        let task = self.get(id)?;
        let asset = &task.assets[asset_at(&task, name)?];
        let bytes = std::fs::read(self.folder(id)?.join(FILES).join(name))?;
        Ok((asset.mime.clone(), crate::attachments::encode(&bytes)))
    }

    /// Links a Session started from the Task (`SessionStarted`), and sets `status` once if given.
    pub fn link_session(&self, id: &str, session_id: &str, title: &str, status: Option<TaskStatus>, actor: &Actor) -> anyhow::Result<Task> {
        let _guard = self.write_lock.lock();
        let mut task = self.get(id)?;
        let now = stamp(&task);
        task.sessions.push(TaskSessionLink { session_id: session_id.to_owned(), title: title.to_owned(), started_ms: now });
        record(&mut task, actor, now, TaskActivityKind::SessionStarted { session_id: session_id.to_owned() });
        if let Some(s) = status
            && s != task.status
        {
            let kind = TaskActivityKind::StatusChanged { from: task.status, to: s };
            record(&mut task, actor, now, kind);
            task.status = s;
        }
        task.updated_ms = now;
        self.save(task)
    }

    /// Removes a deleted Session from every Task's `sessions`. The origin stays. Returns the ids
    /// of the Tasks that changed.
    pub fn forget_session(&self, session: &str) -> Vec<String> {
        let _guard = self.write_lock.lock();
        let linked: Vec<Task> = self.index.read().values().filter(|t| t.sessions.iter().any(|l| l.session_id == session)).cloned().collect();
        let mut changed = Vec::new();
        for mut task in linked {
            task.sessions.retain(|l| l.session_id != session);
            let id = task.id.clone();
            match self.save(task) {
                Ok(_) => changed.push(id),
                Err(e) => tracing::warn!("unlinking deleted session from task {id}: {e:#}"),
            }
        }
        changed
    }

    /// Writes `task` and puts it in the index. The caller holds `write_lock`.
    fn save(&self, task: Task) -> anyhow::Result<Task> {
        write_task(&self.folder(&task.id)?, &task)?;
        self.index.write().insert(task.id.clone(), task.clone());
        Ok(task)
    }
}

fn write_task(folder: &Path, task: &Task) -> anyhow::Result<()> {
    crate::fsutil::write_atomic(&folder.join(FILE), &serde_json::to_vec_pretty(task)?)
}

/// A time for a change of `task`: now, but always after its last change, so `updated_ms` grows.
fn stamp(task: &Task) -> i64 {
    crate::log::now_ms().max(task.updated_ms + 1)
}

fn record(task: &mut Task, actor: &Actor, at_ms: i64, kind: TaskActivityKind) {
    task.activity.push(TaskActivity { at_ms, by: actor.by, session_id: actor.session_id.clone(), kind });
    let extra = task.activity.len().saturating_sub(MAX_ACTIVITY);
    task.activity.drain(..extra);
}

/// The children of `parent` (`None`: top level) other than `except`, by `order`.
fn siblings<'a>(index: &'a BTreeMap<String, Task>, parent: Option<&str>, except: &str) -> Vec<&'a Task> {
    let mut out: Vec<&Task> = index.values().filter(|t| t.parent_id.as_deref() == parent && t.id != except).collect();
    out.sort_by(|a, b| a.order.total_cmp(&b.order));
    out
}

/// The `order` that puts a Task last among the children of `parent`.
fn last_order(index: &BTreeMap<String, Task>, parent: Option<&str>, except: &str) -> f64 {
    siblings(index, parent, except).last().map_or(1.0, |t| t.order + 1.0)
}

/// The `order` that puts a Task just before its sibling `before`: the midpoint to the one before.
fn order_before(index: &BTreeMap<String, Task>, parent: Option<&str>, before: &str, except: &str) -> anyhow::Result<f64> {
    let list = siblings(index, parent, except);
    let Some(at) = list.iter().position(|t| t.id == before) else {
        let under = parent.map_or("the top level".to_owned(), |p| format!("task {p}"));
        return Err(crate::error::invalid(format!("task {before} is not under {under}")));
    };
    let next = list[at].order;
    Ok(match at.checked_sub(1).map(|i| list[i].order) {
        Some(prev) => (prev + next) / 2.0,
        None => next - 1.0,
    })
}

/// Whether `id` is below `ancestor` (a child, grandchild, ...).
fn descends_from(index: &BTreeMap<String, Task>, id: &str, ancestor: &str) -> bool {
    let mut at = index.get(id).and_then(|t| t.parent_id.as_deref());
    // Bounded: bad data could hold a loop.
    for _ in 0..=index.len() {
        match at {
            Some(p) if p == ancestor => return true,
            Some(p) => at = index.get(p).and_then(|t| t.parent_id.as_deref()),
            None => return false,
        }
    }
    false
}

/// Whether `from` waits on or follows `target` through a chain of Dependencies of either kind.
fn depends_on(index: &BTreeMap<String, Task>, from: &str, target: &str) -> bool {
    let mut seen = BTreeSet::new();
    let mut todo = vec![from];
    // `seen` bounds the walk: bad data could hold a loop.
    while let Some(at) = todo.pop() {
        if at == target {
            return true;
        }
        if seen.insert(at) {
            todo.extend(index.get(at).into_iter().flat_map(|t| t.deps.iter().map(|d| d.id.as_str())));
        }
    }
    false
}

/// Checks the Dependencies of task `id`: each other task exists once, and none leads back to `id`.
fn check_deps(index: &BTreeMap<String, Task>, id: &str, deps: &[TaskDep]) -> anyhow::Result<()> {
    for (i, d) in deps.iter().enumerate() {
        if !id.is_empty() && d.id == id {
            return Err(crate::error::invalid(format!("task {id} cannot depend on itself")));
        }
        if deps[..i].iter().any(|e| e.id == d.id) {
            return Err(crate::error::invalid(format!("task {} is listed twice in deps", d.id)));
        }
        anyhow::ensure!(index.contains_key(&d.id), crate::error::not_found(format!("no task {:?}", d.id)));
        if depends_on(index, &d.id, id) {
            return Err(crate::error::invalid(format!("task {id} cannot depend on task {}: it would make a loop", d.id)));
        }
    }
    Ok(())
}

/// Properties with trimmed values. Keys are 1-32 characters of `a-z`, `0-9`, `_` and `-`; values
/// 1-64 characters on one line; at most 16 (ADR 0029).
fn clean_props(props: BTreeMap<String, String>) -> anyhow::Result<BTreeMap<String, String>> {
    if props.len() > MAX_PROPS {
        return Err(crate::error::invalid(format!("a task has at most {MAX_PROPS} props, not {}", props.len())));
    }
    props
        .into_iter()
        .map(|(k, v)| {
            let key_ok = (1..=MAX_PROP_KEY).contains(&k.len()) && k.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-');
            if !key_ok {
                return Err(crate::error::invalid(format!("the prop key {k:?} must be 1-{MAX_PROP_KEY} characters of a-z, 0-9, _ and -")));
            }
            let v = v.trim().to_owned();
            if v.is_empty() || v.chars().count() > MAX_PROP_VALUE || v.contains(['\n', '\r']) {
                return Err(crate::error::invalid(format!("the value of prop {k:?} must be 1-{MAX_PROP_VALUE} characters on one line")));
            }
            Ok((k, v))
        })
        .collect()
}

/// A title on one line; refuses an empty one.
fn clean_title(title: &str) -> anyhow::Result<String> {
    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.is_empty() {
        return Err(crate::error::invalid("a title is required"));
    }
    Ok(title)
}

/// `YYYY-MM-DD` with a month 1-12 and a day 1-31.
fn check_due(due: &str) -> anyhow::Result<String> {
    let due = due.trim();
    let ok = due.len() == 10
        && due.bytes().enumerate().all(|(i, b)| if i == 4 || i == 7 { b == b'-' } else { b.is_ascii_digit() })
        && (1..=12).contains(&due[5..7].parse::<u8>().unwrap_or(0))
        && (1..=31).contains(&due[8..10].parse::<u8>().unwrap_or(0));
    if !ok {
        return Err(crate::error::invalid(format!("{due:?} is not a date (YYYY-MM-DD)")));
    }
    Ok(due.to_owned())
}

/// A web link (`http://` or `https://`) with an optional label.
fn check_upstream(u: TaskUpstream) -> anyhow::Result<TaskUpstream> {
    let url = u.url.trim();
    if url.is_empty() {
        return Err(crate::error::invalid("an upstream link needs a url"));
    }
    let rest = ["https://", "http://"].iter().find_map(|s| url.get(..s.len()).filter(|p| p.eq_ignore_ascii_case(s)).map(|_| &url[s.len()..]));
    if rest.is_none_or(|r| r.trim_start_matches('/').is_empty() || r.contains(char::is_whitespace)) {
        return Err(crate::error::invalid(format!("the upstream url {url:?} is not a web link: it must start with https:// or http://")));
    }
    let label = u.label.map(|l| l.trim().to_owned()).filter(|l| !l.is_empty());
    Ok(TaskUpstream { url: url.to_owned(), label })
}

/// `name`, or `name-2.ext`, `name-3.ext`, ... when an asset already has it.
fn free_name(assets: &[TaskAsset], name: &str) -> String {
    let taken = |n: &str| assets.iter().any(|a| a.name == n);
    if !taken(name) {
        return name.to_owned();
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    (2..).map(|n| format!("{stem}-{n}{ext}")).find(|n| !taken(n)).unwrap_or_else(|| name.to_owned())
}

/// Where the asset `name` is in `task.assets`.
fn asset_at(task: &Task, name: &str) -> anyhow::Result<usize> {
    task.assets.iter().position(|a| a.name == name).ok_or_else(|| crate::error::not_found(format!("task {} has no file {name:?}", task.id)))
}

/// One Task from its folder, checked against the folder name.
fn load(folder: &Path) -> anyhow::Result<Task> {
    let task: Task = serde_json::from_slice(&std::fs::read(folder.join(FILE))?)?;
    let name = folder.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    anyhow::ensure!(task.id == name, "task.json names {:?}", task.id);
    Ok(task)
}

/// Every folder of `dir` with a good `task.json` (others are skipped with a warning), and the
/// number for the next new Task: one more than the highest id folder, good or not.
fn scan(dir: &Path) -> (BTreeMap<String, Task>, u64) {
    let mut out = BTreeMap::new();
    let mut highest = 0;
    let Ok(entries) = std::fs::read_dir(dir) else { return (out, 1) };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(n) = number(&name).filter(|_| path.is_dir()) else { continue };
        highest = highest.max(n);
        match load(&path) {
            Ok(task) => {
                out.insert(name, task);
            }
            Err(e) => tracing::warn!("skipping task {}: {e:#}", path.display()),
        }
    }
    (out, highest + 1)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "tests fail loudly")]
    use super::*;
    use crate::api::{TaskDepKind, TaskSessionLink};

    fn store(d: &tempfile::TempDir) -> Tasks {
        Tasks::open(d.path().join(DIR)).unwrap()
    }

    fn add(s: &Tasks, title: &str, parent: Option<&str>) -> Task {
        let new = NewTask { title: title.into(), parent_id: parent.map(Into::into), ..Default::default() };
        s.create(new, &Actor::user()).unwrap()
    }

    fn agent(session: &str) -> Actor {
        Actor { by: StateWriter::Agent, session_id: Some(session.into()) }
    }

    #[test]
    fn ids() {
        assert!(is_id("t1") && is_id("t120"));
        for bad in ["", "t", "t0", "t01", "x1", "t1a", "t-1", "T1", "t/1"] {
            assert!(!is_id(bad), "{bad}");
        }
    }

    #[test]
    fn create_sets_fields_origin_and_activity() {
        let d = tempfile::tempdir().unwrap();
        let s = store(&d);
        let new = NewTask {
            title: "  Fix\nthe   login ".into(),
            body: "Steps".into(),
            status: Some(TaskStatus::InProgress),
            due: Some("2026-12-01".into()),
            upstream: Some(TaskUpstream { url: " https://linear.app/x/issue/ABC-1 ".into(), label: Some(" ".into()) }),
            origin: Some(("s1".into(), "Session one".into())),
            ..Default::default()
        };
        let t = s.create(new, &agent("s1")).unwrap();
        assert_eq!((t.id.as_str(), t.title.as_str(), t.status), ("t1", "Fix the login", TaskStatus::InProgress));
        assert_eq!(t.upstream, Some(TaskUpstream { url: "https://linear.app/x/issue/ABC-1".into(), label: None }));
        assert_eq!((t.origin_session_id.as_deref(), t.origin_title.as_deref()), (Some("s1"), Some("Session one")));
        assert_eq!(t.activity.len(), 1);
        assert_eq!((t.activity[0].by, t.activity[0].session_id.as_deref(), &t.activity[0].kind), (StateWriter::Agent, Some("s1"), &TaskActivityKind::Created));
        let on_disk: Task = serde_json::from_slice(&std::fs::read(d.path().join("tasks/t1/task.json")).unwrap()).unwrap();
        assert_eq!(on_disk, t);
        assert!(s.list()[0].has_body);
        assert!(s.create(NewTask { title: " \n".into(), ..Default::default() }, &Actor::user()).is_err(), "empty title");
        assert!(s.create(NewTask { title: "a".into(), due: Some("2026-13-01".into()), ..Default::default() }, &Actor::user()).is_err());
        assert!(s.create(NewTask { title: "a".into(), parent_id: Some("t9".into()), ..Default::default() }, &Actor::user()).is_err());
    }

    #[test]
    fn ids_continue_after_reopen_and_bad_folders_are_skipped() {
        let d = tempfile::tempdir().unwrap();
        let s = store(&d);
        add(&s, "a", None);
        add(&s, "b", None);
        drop(s);
        let dir = d.path().join(DIR);
        std::fs::create_dir_all(dir.join("t7")).unwrap();
        std::fs::write(dir.join("t7").join(FILE), "not json").unwrap();
        std::fs::create_dir_all(dir.join("t3")).unwrap();
        std::fs::write(dir.join("t3").join(FILE), serde_json::to_vec(&s_task("t4")).unwrap()).unwrap();
        std::fs::create_dir_all(dir.join("notes")).unwrap();
        let s = store(&d);
        let ids: Vec<String> = s.list().into_iter().map(|t| t.id).collect();
        assert_eq!(ids, ["t1", "t2"], "t7 is not JSON, t3 names another id");
        assert_eq!(add(&s, "c", None).id, "t8", "past the highest folder, good or not");
    }

    fn s_task(id: &str) -> Task {
        let d = tempfile::tempdir().unwrap();
        let mut t = add(&store(&d), "x", None);
        t.id = id.into();
        t
    }

    #[test]
    fn create_all_returns_the_tasks_written_before_a_write_error() {
        let d = tempfile::tempdir().unwrap();
        let s = store(&d);
        let new = |t: &str| NewTask { title: t.into(), ..Default::default() };
        let (none, err) = s.create_all(vec![new("a"), new(" ")], &Actor::user());
        assert!(none.is_empty() && err.unwrap_err().to_string().contains("task 2"), "a bad one creates none");
        // A file where t2's folder goes.
        std::fs::write(d.path().join(DIR).join("t2"), "").unwrap();
        let (made, err) = s.create_all(vec![new("a"), new("b"), new("c")], &Actor::user());
        assert_eq!(made.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["t1"]);
        assert!(format!("{:#}", err.unwrap_err()).starts_with("task 2: "));
    }

    #[test]
    fn create_all_keeps_not_found_for_an_unknown_dep() {
        let d = tempfile::tempdir().unwrap();
        let s = store(&d);
        let dep = TaskDep { id: "t99".into(), kind: TaskDepKind::Blocks };
        let (none, err) = s.create_all(vec![NewTask { title: "a".into(), deps: vec![dep], ..Default::default() }], &Actor::user());
        let err = err.unwrap_err();
        assert!(none.is_empty() && format!("{err:#}").contains("task 1"));
        assert_eq!(crate::api::HarnessError::from(err).code, crate::api::ErrorCode::NotFound);
    }

    #[test]
    fn order_appends_and_moves_take_the_midpoint() {
        let d = tempfile::tempdir().unwrap();
        let s = store(&d);
        let a = add(&s, "a", None);
        let b = add(&s, "b", None);
        let c = add(&s, "c", None);
        assert_eq!((a.order, b.order, c.order), (1.0, 2.0, 3.0));
        let c = s.move_to(&c.id, None, Some(&b.id), &Actor::user()).unwrap();
        assert_eq!(c.order, 1.5);
        let c = s.move_to(&c.id, None, Some(&a.id), &Actor::user()).unwrap();
        assert_eq!(c.order, 0.0);
        assert!(c.activity.iter().all(|e| !matches!(e.kind, TaskActivityKind::Moved { .. })), "same parent: no Moved entry");
        let c = s.move_to(&c.id, None, None, &Actor::user()).unwrap();
        assert_eq!(c.order, 3.0, "last again");
        let sub = add(&s, "sub", Some(&a.id));
        assert_eq!(sub.order, 1.0, "order counts per parent");
        assert!(s.move_to(&c.id, None, Some(&sub.id), &Actor::user()).is_err(), "before must be a sibling");
    }

    #[test]
    fn move_refuses_cycles_and_keeps_the_origin() {
        let d = tempfile::tempdir().unwrap();
        let s = store(&d);
        let new = NewTask { title: "root".into(), origin: Some(("s1".into(), "One".into())), ..Default::default() };
        let root = s.create(new, &Actor::user()).unwrap();
        let child = add(&s, "child", Some(&root.id));
        let grandchild = add(&s, "grandchild", Some(&child.id));
        let other = add(&s, "other", None);
        assert!(s.move_to(&root.id, Some(&root.id), None, &Actor::user()).is_err(), "itself");
        assert!(s.move_to(&root.id, Some(&grandchild.id), None, &Actor::user()).is_err(), "a descendant");
        assert!(s.move_to(&root.id, Some("t99"), None, &Actor::user()).is_err(), "unknown parent");
        let moved = s.move_to(&root.id, Some(&other.id), None, &agent("s2")).unwrap();
        assert_eq!(moved.parent_id.as_deref(), Some(other.id.as_str()));
        assert_eq!(moved.origin_session_id.as_deref(), Some("s1"));
        let last = moved.activity.last().unwrap();
        assert_eq!(last.kind, TaskActivityKind::Moved { from: None, to: Some(other.id.clone()) });
        assert_eq!((last.by, last.session_id.as_deref()), (StateWriter::Agent, Some("s2")));
        let top = s.move_to(&grandchild.id, None, None, &Actor::user()).unwrap();
        assert_eq!(top.parent_id, None);
    }

    #[test]
    fn update_patches_fields_and_records_status_changes() {
        let d = tempfile::tempdir().unwrap();
        let s = store(&d);
        let t = s.create(NewTask { title: "a".into(), due: Some("2026-01-02".into()), ..Default::default() }, &Actor::user()).unwrap();
        let patch = TaskPatch {
            title: Some("b".into()),
            status: Some(TaskStatus::Done),
            priority: Some(TaskPriority::High),
            upstream: Some(TaskUpstream { url: "https://github.com/o/r/issues/4".into(), label: None }),
            clear: vec![TaskField::Due],
            ..Default::default()
        };
        let u = s.update(&t.id, patch, None, &Actor::user()).unwrap();
        assert_eq!((u.title.as_str(), u.status, u.priority, u.due.as_deref()), ("b", TaskStatus::Done, TaskPriority::High, None));
        assert!(u.updated_ms > t.updated_ms);
        assert_eq!(u.activity.last().unwrap().kind, TaskActivityKind::StatusChanged { from: TaskStatus::Todo, to: TaskStatus::Done });
        let same = s.update(&t.id, TaskPatch { status: Some(TaskStatus::Done), ..Default::default() }, None, &Actor::user()).unwrap();
        assert_eq!(same.activity.len(), u.activity.len(), "no change, no entry");
        let cleared = s.update(&t.id, TaskPatch { clear: vec![TaskField::Upstream], ..Default::default() }, None, &Actor::user()).unwrap();
        assert_eq!(cleared.upstream, None);
    }

    #[test]
    fn upstream_urls_must_be_web_links() {
        let check = |url: &str| check_upstream(TaskUpstream { url: url.into(), label: None });
        for good in ["https://linear.app/x/issue/ABC-1", "http://localhost:3000/a", " HTTPS://github.com/o/r/issues/4 "] {
            assert!(check(good).is_ok(), "{good}");
        }
        for bad in ["javascript:alert(1)", "file:///etc/passwd", "linear.app/x", "https://", "https:// a", "ftp://x", "data:text/html,x"] {
            let e = check(bad).unwrap_err();
            assert_eq!(crate::api::HarnessError::from(e).code, crate::api::ErrorCode::Invalid, "{bad}");
        }
        assert!(check("ABC-1").unwrap_err().to_string().contains("https://"), "the message says what to give");
    }

    #[test]
    fn body_edits_conflict_when_the_body_changed_after_the_base() {
        let d = tempfile::tempdir().unwrap();
        let s = store(&d);
        let t = add(&s, "a", None);
        let body = |b: &str| TaskPatch { body: Some(b.into()), ..Default::default() };
        let first = s.update(&t.id, body("one"), Some(t.updated_ms), &Actor::user()).unwrap();
        let err = s.update(&t.id, body("two"), Some(t.updated_ms), &Actor::user()).unwrap_err();
        assert_eq!(crate::api::HarnessError::from(err).code, crate::api::ErrorCode::Conflict);
        s.update(&t.id, body("two"), Some(first.updated_ms), &Actor::user()).unwrap();
        // Other fields do not conflict with a body edit.
        let st = s.update(&t.id, TaskPatch { status: Some(TaskStatus::Done), ..Default::default() }, None, &Actor::user()).unwrap();
        let based_before_status = s.get(&t.id).unwrap().body_updated_ms;
        assert!(st.updated_ms > based_before_status);
        s.update(&t.id, body("three"), Some(based_before_status), &Actor::user()).unwrap();
    }

    #[test]
    fn activity_keeps_the_last_100() {
        let d = tempfile::tempdir().unwrap();
        let s = store(&d);
        let t = add(&s, "a", None);
        for i in 0..120 {
            let status = if i % 2 == 0 { TaskStatus::Done } else { TaskStatus::Todo };
            s.update(&t.id, TaskPatch { status: Some(status), ..Default::default() }, None, &Actor::user()).unwrap();
        }
        let t = s.get(&t.id).unwrap();
        assert_eq!(t.activity.len(), MAX_ACTIVITY);
        assert!(!t.activity.iter().any(|e| e.kind == TaskActivityKind::Created), "oldest dropped");
    }

    #[test]
    fn delete_moves_children_to_the_parent() {
        let d = tempfile::tempdir().unwrap();
        let s = store(&d);
        let top = add(&s, "top", None);
        let sibling = add(&s, "sibling", Some(&top.id));
        let mid = add(&s, "mid", Some(&top.id));
        let c1 = add(&s, "c1", Some(&mid.id));
        let c2 = add(&s, "c2", Some(&mid.id));
        let moved = s.delete(&mid.id, &Actor::user()).unwrap();
        assert_eq!(moved, [c1.id.clone(), c2.id.clone()]);
        assert!(!d.path().join("tasks").join(&mid.id).exists());
        assert!(s.get(&mid.id).is_err());
        let (c1, c2) = (s.get(&c1.id).unwrap(), s.get(&c2.id).unwrap());
        assert_eq!((c1.parent_id.as_deref(), c2.parent_id.as_deref()), (Some(top.id.as_str()), Some(top.id.as_str())));
        assert!(sibling.order < c1.order && c1.order < c2.order, "after the parent's other children, in order");
        assert_eq!(c1.activity.last().unwrap().kind, TaskActivityKind::Moved { from: Some(mid.id.clone()), to: Some(top.id.clone()) });
        let reopened = store(&d);
        assert_eq!(reopened.get(&c1.id).unwrap(), c1, "written to disk");
        assert!(s.delete(&top.id, &Actor::user()).is_ok());
        assert_eq!(s.get(&c1.id).unwrap().parent_id, None, "top level");
    }

    #[test]
    fn forget_session_unlinks_and_keeps_the_origin() {
        let d = tempfile::tempdir().unwrap();
        let s = store(&d);
        let new = NewTask { title: "a".into(), origin: Some(("s1".into(), "One".into())), ..Default::default() };
        let t = s.create(new, &Actor::user()).unwrap();
        add(&s, "unrelated", None);
        let mut linked = t.clone();
        linked.sessions = vec![
            TaskSessionLink { session_id: "s1".into(), title: "One".into(), started_ms: 1 },
            TaskSessionLink { session_id: "s2".into(), title: "Two".into(), started_ms: 2 },
        ];
        s.save(linked).unwrap();
        assert_eq!(s.forget_session("s1"), std::slice::from_ref(&t.id));
        let t = store(&d).get(&t.id).unwrap();
        assert_eq!(t.sessions.iter().map(|l| l.session_id.as_str()).collect::<Vec<_>>(), ["s2"]);
        assert_eq!(t.origin_session_id.as_deref(), Some("s1"));
        assert!(s.forget_session("s1").is_empty());
    }

    #[test]
    fn assets_are_stored_read_and_removed() {
        use base64::Engine;
        let d = tempfile::tempdir().unwrap();
        let s = store(&d);
        let t = add(&s, "a", None);
        let data = |name: &str, body: &[u8]| AttachmentInput::Data {
            name: name.into(),
            mime: "text/plain".into(),
            data: base64::engine::general_purpose::STANDARD.encode(body),
        };
        let file = d.path().join("shot.png");
        std::fs::write(&file, b"png").unwrap();
        let files = vec![data("../notes.txt", b"hi"), data("notes.txt", b"again"), AttachmentInput::Path { path: file.display().to_string() }];
        let t = s.add_assets(&t.id, files).unwrap();
        let names: Vec<&str> = t.assets.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(names, ["_notes.txt", "notes.txt", "shot.png"]);
        let t = s.add_assets(&t.id, vec![data("notes.txt", b"third")]).unwrap();
        assert_eq!(t.assets.last().unwrap().name, "notes-2.txt");
        assert_eq!(t.assets[2].mime, "image/png");
        assert_eq!(s.read_asset(&t.id, "notes.txt").unwrap(), ("text/plain".into(), base64::engine::general_purpose::STANDARD.encode(b"again")));
        assert!(s.read_asset(&t.id, "../../task.json").is_err(), "only listed assets");
        let t = s.remove_asset(&t.id, "notes.txt").unwrap();
        assert!(!t.assets.iter().any(|a| a.name == "notes.txt"));
        assert!(!d.path().join("tasks").join(&t.id).join(FILES).join("notes.txt").exists());
        assert!(s.remove_asset(&t.id, "notes.txt").is_err());
    }

    fn dep(id: &str, kind: TaskDepKind) -> TaskDep {
        TaskDep { id: id.into(), kind }
    }

    fn set_deps(s: &Tasks, id: &str, deps: Vec<TaskDep>) -> anyhow::Result<Task> {
        s.update(id, TaskPatch { deps: Some(deps), ..Default::default() }, None, &Actor::user())
    }

    fn code(e: anyhow::Error) -> crate::api::ErrorCode {
        crate::api::HarnessError::from(e).code
    }

    #[test]
    fn old_task_json_without_deps_and_props_loads() {
        let d = tempfile::tempdir().unwrap();
        let s = store(&d);
        let t = add(&s, "a", None);
        drop(s);
        let file = d.path().join(DIR).join(&t.id).join(FILE);
        let mut json: serde_json::Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        let obj = json.as_object_mut().unwrap();
        assert!(obj.remove("deps").is_some() && obj.remove("props").is_some());
        std::fs::write(&file, serde_json::to_vec(&json).unwrap()).unwrap();
        let t = store(&d).get(&t.id).unwrap();
        assert!(t.deps.is_empty() && t.props.is_empty());
    }

    #[test]
    fn deps_are_checked_and_recorded() {
        use crate::api::ErrorCode;
        let d = tempfile::tempdir().unwrap();
        let s = store(&d);
        let (a, b, c) = (add(&s, "a", None), add(&s, "b", None), add(&s, "c", None));
        let e = |r: anyhow::Result<Task>| code(r.unwrap_err());
        assert_eq!(e(set_deps(&s, &a.id, vec![dep(&a.id, TaskDepKind::Blocks)])), ErrorCode::Invalid, "self");
        assert_eq!(e(set_deps(&s, &a.id, vec![dep("t99", TaskDepKind::Blocks)])), ErrorCode::NotFound, "unknown id");
        assert_eq!(e(set_deps(&s, &a.id, vec![dep(&b.id, TaskDepKind::Blocks), dep(&b.id, TaskDepKind::FollowUp)])), ErrorCode::Invalid, "twice");
        // a waits on b, b follows c.
        let a2 = set_deps(&s, &a.id, vec![dep(&b.id, TaskDepKind::Blocks)]).unwrap();
        assert_eq!(a2.activity.last().unwrap().kind, TaskActivityKind::DepAdded { id: b.id.clone(), kind: TaskDepKind::Blocks });
        set_deps(&s, &b.id, vec![dep(&c.id, TaskDepKind::FollowUp)]).unwrap();
        assert_eq!(e(set_deps(&s, &b.id, vec![dep(&a.id, TaskDepKind::FollowUp)])), ErrorCode::Invalid, "direct loop");
        let err = set_deps(&s, &c.id, vec![dep(&a.id, TaskDepKind::Blocks)]).unwrap_err();
        assert!(err.to_string().contains("loop"), "indirect loop: {err}");
        assert!(s.get(&c.id).unwrap().deps.is_empty(), "a refused patch writes nothing");
        // A new kind is an add; a missing id is a remove.
        let a3 = set_deps(&s, &a.id, vec![dep(&b.id, TaskDepKind::FollowUp), dep(&c.id, TaskDepKind::Blocks)]).unwrap();
        let kinds: Vec<_> = a3.activity[a2.activity.len()..].iter().map(|x| x.kind.clone()).collect();
        assert_eq!(
            kinds,
            [
                TaskActivityKind::DepAdded { id: b.id.clone(), kind: TaskDepKind::FollowUp },
                TaskActivityKind::DepAdded { id: c.id.clone(), kind: TaskDepKind::Blocks }
            ]
        );
        let a4 = set_deps(&s, &a.id, vec![dep(&c.id, TaskDepKind::Blocks)]).unwrap();
        assert_eq!(a4.activity.last().unwrap().kind, TaskActivityKind::DepRemoved { id: b.id.clone() });
        assert_eq!(set_deps(&s, &a.id, a4.deps.clone()).unwrap().activity.len(), a4.activity.len(), "no change, no entry");
        // On create too.
        let new = NewTask { title: "d".into(), deps: vec![dep(&a.id, TaskDepKind::Blocks)], ..Default::default() };
        assert_eq!(s.create(new, &Actor::user()).unwrap().deps, [dep(&a.id, TaskDepKind::Blocks)]);
        let new = NewTask { title: "e".into(), deps: vec![dep("t99", TaskDepKind::Blocks)], ..Default::default() };
        assert_eq!(code(s.create(new, &Actor::user()).unwrap_err()), ErrorCode::NotFound);
        assert_eq!(store(&d).get(&a.id).unwrap().deps, a4.deps, "written to disk");
    }

    #[test]
    fn delete_removes_the_id_from_other_tasks_deps() {
        let d = tempfile::tempdir().unwrap();
        let s = store(&d);
        let gone = add(&s, "gone", None);
        let child = add(&s, "child", Some(&gone.id));
        let other = add(&s, "other", None);
        let keep = add(&s, "keep", None);
        set_deps(&s, &child.id, vec![dep(&gone.id, TaskDepKind::FollowUp)]).unwrap();
        set_deps(&s, &other.id, vec![dep(&keep.id, TaskDepKind::Blocks), dep(&gone.id, TaskDepKind::Blocks)]).unwrap();
        let mut touched = s.delete_touches(&gone.id);
        touched.sort();
        assert_eq!(touched, [child.id.clone(), other.id.clone()]);
        assert_eq!(s.delete(&gone.id, &Actor::user()).unwrap(), [child.id.clone(), other.id.clone()]);
        let reopened = store(&d);
        let (child, other) = (reopened.get(&child.id).unwrap(), reopened.get(&other.id).unwrap());
        assert!(child.deps.is_empty() && child.parent_id.is_none(), "a child that depended on it: moved and unlinked");
        assert_eq!(other.deps, [dep(&keep.id, TaskDepKind::Blocks)]);
        assert_eq!(other.activity.last().unwrap().kind, TaskActivityKind::DepRemoved { id: gone.id.clone() });
    }

    #[test]
    fn props_are_checked_and_replaced() {
        let d = tempfile::tempdir().unwrap();
        let s = store(&d);
        let t = add(&s, "a", None);
        let props = |pairs: &[(&str, &str)]| pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<BTreeMap<_, _>>();
        let set = |p: BTreeMap<String, String>| s.update(&t.id, TaskPatch { props: Some(p), ..Default::default() }, None, &Actor::user());
        let u = set(props(&[("component", " web-ui "), ("risk_2", "yes")])).unwrap();
        assert_eq!(u.props, props(&[("component", "web-ui"), ("risk_2", "yes")]), "values trimmed");
        assert_eq!(u.activity.last().unwrap().kind, TaskActivityKind::PropsChanged);
        assert_eq!(s.list()[0].props, u.props, "in the summary");
        let long_key = "k".repeat(33);
        let long_value = "v".repeat(65);
        for bad in [
            props(&[("Component", "x")]),
            props(&[("a b", "x")]),
            props(&[("", "x")]),
            props(&[(&long_key, "x")]),
            props(&[("k", " ")]),
            props(&[("k", "a\nb")]),
            props(&[("k", &long_value)]),
        ] {
            let e = set(bad.clone()).unwrap_err();
            assert_eq!(code(e), crate::api::ErrorCode::Invalid, "{bad:?}");
        }
        assert!(Tasks::check_patch(&TaskPatch { props: Some(props(&[("Bad", "x")])), ..Default::default() }).is_err());
        let many: BTreeMap<String, String> = (0..17).map(|i| (format!("k{i}"), "v".into())).collect();
        assert!(set(many).is_err(), "at most 16");
        assert!(set(BTreeMap::new()).unwrap().props.is_empty(), "replace: empty clears");
        let new = NewTask { title: "b".into(), props: props(&[("BAD", "x")]), ..Default::default() };
        assert!(s.create(new, &Actor::user()).is_err());
    }

    #[test]
    fn excerpt_is_plain_text_from_the_body() {
        let d = tempfile::tempdir().unwrap();
        let s = store(&d);
        let excerpt = |body: &str| {
            let t = s.create(NewTask { title: "x".into(), body: body.into(), ..Default::default() }, &Actor::user()).unwrap();
            TaskSummary::from(&t).excerpt
        };
        let body = "## Goal\n\nMake the **cache** _faster_, see [the notes](https://example.com/notes) and `cache_size`.\n\n```rust\nlet x = 1;\n```\n\n- first step\n1. second ![shot](a.png) step\n> quoted *text*\n---\nsnake_case stays";
        assert_eq!(excerpt(body), "Goal Make the cache faster, see the notes and cache_size. first step second step quoted text snake_case stays");
        assert_eq!(excerpt(""), "");
        assert_eq!(excerpt("```\nonly code\n```"), "");
    }

    #[test]
    fn excerpt_is_cut_at_a_word_to_160_chars() {
        let d = tempfile::tempdir().unwrap();
        let s = store(&d);
        let excerpt = |body: String| {
            let t = s.create(NewTask { title: "x".into(), body, ..Default::default() }, &Actor::user()).unwrap();
            TaskSummary::from(&t).excerpt
        };
        let body = "word ".repeat(100);
        let e = excerpt(body);
        assert!(e.ends_with("word…") && e.chars().count() <= 160, "{e}");
        assert_eq!(e.chars().count(), 32 * 5 - 1 + 1, "32 words, 31 spaces and the …");
        let fits = "ä".repeat(160);
        assert_eq!(excerpt(fits.clone()), fits, "160 chars fit, counted as chars");
        let e = excerpt("ü".repeat(200));
        assert_eq!(e.chars().count(), 160, "one long word is cut inside");
    }
}
