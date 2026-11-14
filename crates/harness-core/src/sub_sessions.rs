//! Sub Sessions: a Session's Agent starts another Session (its own Agent process, by default in its
//! own Worktree) through the Harness MCP tools `session_start`, `session_send`, `session_wait` and
//! `session_list`.
//! The child keeps `parent` in its meta; the user sees it under the parent. Depth 1: only the Main
//! Thread of a Session that is not a Sub Session gets the tools. Results are JSON text, so the UI can
//! read them.
//!
//! An Agent acts only on a prompt, so a parent that ended its Turn would never learn that a child
//! finished. `watch` closes that gap: when a Turn the parent started in a child ends, or the child
//! starts waiting for the user, the parent's Agent gets a message (`Notices`), once it is idle.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};

use crate::api::{
    AppEvent, EventKind, PromptOrigin, PromptOriginKind, SessionId, SessionParent, SessionStatus, SubSessionReport, SubSessionReportKind, ThreadId,
};
use crate::host::{Harness, NewSession};
use crate::session::Session;

/// The tools, as named in `mcp::primitives`.
pub const TOOLS: [&str; 4] = ["session_start", "session_send", "session_wait", "session_list"];

/// Safety guard, not a product limit: each running Sub Session is a separate Agent process (memory,
/// CPU, API cost), and the cap stops a looping Agent from starting many. Raise or remove freely.
pub const MAX_RUNNING_SUB_SESSIONS: usize = 4;

/// Default and longest wait of `session_wait`, in seconds. `timeout_s: 0` only checks.
const WAIT_DEFAULT_S: u64 = 600;
const WAIT_MAX_S: u64 = 1800;

/// Whether the tools are offered to this Thread: the Main Thread of a Session that is no Sub Session.
pub fn offered(session: &Session, thread: &ThreadId) -> bool {
    session.meta().parent.is_none() && session.is_main(Some(thread))
}

/// Runs one of `TOOLS`. Each asks the Permission Policy itself (`acp::authorize`), after its input
/// is checked, so the user never approves a call that cannot run.
pub async fn call(session: &Arc<Session>, thread: &ThreadId, name: &str, args: &Value) -> anyhow::Result<String> {
    anyhow::ensure!(offered(session, thread), "{name} is only available on the Main Thread of a Session that is not a Sub Session");
    let host = session.shared().host()?;
    let v = match name {
        "session_start" => start(&host, session, thread, args).await?,
        "session_send" => send(&host, session, thread, args).await?,
        "session_wait" => wait(&host, session, thread, args).await?,
        "session_list" => list(&host, session, thread, args).await?,
        _ => anyhow::bail!("unknown tool {name}"),
    };
    Ok(serde_json::to_string_pretty(&v)?)
}

/// What a tool takes, for the error when an argument is missing: an Agent that called it before it
/// loaded the schema can retry from the error alone.
fn usage(tool: &str) -> &'static str {
    match tool {
        "session_start" => {
            r#"session_start needs "prompt" (the first message to its agent); optional: "folder", "title", "model", "effort", "worktree", "branch", "notify"."#
        }
        "session_send" => r#"session_send needs "id" (the session_id from session_start) and "text"."#,
        "session_wait" => r#"session_wait needs "id" (the session_id from session_start); optional: "timeout_s" (0 only checks)."#,
        _ => "",
    }
}

/// A required text argument of `tool`.
fn required(args: &Value, key: &str, tool: &str) -> anyhow::Result<String> {
    text_arg(args, key).ok_or_else(|| anyhow::anyhow!("\"{key}\" is missing. {}", usage(tool)))
}

fn text_arg(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned)
}

fn origin(session: &Session) -> PromptOrigin {
    let m = session.meta();
    PromptOrigin { session_id: m.id, title: m.title, kind: PromptOriginKind::Parent, reports: Vec::new() }
}

/// Errors when the parent already has `MAX_RUNNING_SUB_SESSIONS` children working or waiting for the user.
fn ensure_capacity(host: &Harness, parent: &Session) -> anyhow::Result<()> {
    let running = host.children(&parent.id()).iter().filter(|c| c.agent_slot().status() != SessionStatus::Idle).count();
    anyhow::ensure!(
        running < MAX_RUNNING_SUB_SESSIONS,
        "{running} Sub Sessions of this Session are running, the most allowed. Wait for one to finish (session_wait) first."
    );
    Ok(())
}

async fn start(host: &Arc<Harness>, session: &Arc<Session>, thread: &ThreadId, args: &Value) -> anyhow::Result<Value> {
    let prompt = required(args, "prompt", "session_start")?;
    let folder = match text_arg(args, "folder") {
        Some(f) => f,
        None => session.summary().workspace.source_folder,
    };
    anyhow::ensure!(Path::new(&folder).is_dir(), "folder {folder} does not exist");
    let is_repo = crate::workspace::repo_root(Path::new(&folder)).await.is_some();
    let worktree = args.get("worktree").and_then(Value::as_bool).unwrap_or(is_repo);
    let branch = text_arg(args, "branch");
    anyhow::ensure!(branch.is_none() || worktree, "branch needs a worktree: omit worktree or pass worktree: true");
    anyhow::ensure!(!worktree || is_repo, "{folder} is not in a git repository: pass worktree: false");
    ensure_capacity(host, session)?;
    let config = Config::choose(&main_config(session)?, text_arg(args, "model").as_deref(), text_arg(args, "effort").as_deref())?;
    let title = text_arg(args, "title")
        .or_else(|| crate::session::title_from_text(&prompt))
        .unwrap_or_else(|| Path::new(&folder).file_name().map_or_else(|| folder.clone(), |n| n.to_string_lossy().into_owned()));
    crate::acp::authorize(session, thread, "session_start", &format!("Start sub session: {title} in {folder}"), "session", args).await?;
    ensure_capacity(host, session)?;
    let meta = session.meta();
    let child = host
        .create_session(NewSession {
            folder,
            agent_id: meta.agent.id.clone(),
            frontend_id: meta.frontend_id.clone(),
            title: Some(title),
            branch,
            worktree,
            new_branch: None,
            pr: None,
            mcp_servers: Vec::new(),
            parent: Some(SessionParent {
                session_id: meta.id.clone(),
                thread_id: thread.clone(),
                tool_call_id: None,
                notify: args.get("notify").and_then(Value::as_bool).unwrap_or(true),
            }),
            initial_config: config.values.clone(),
        })
        .await?;
    session.shared().app_events.emit(AppEvent::SessionsChanged);
    let id = child.id();
    // Returns once the Turn started, so the child's log has the prompt before the parent goes on.
    if let Err(e) = child.prompt(None, prompt, Vec::new(), Some(origin(session))).await {
        anyhow::bail!("started Sub Session {id}, but its first prompt failed: {e:#}");
    }
    let m = child.meta();
    let branch = m.workspace.worktree.as_ref().map(|w| w.branch.clone()).or_else(|| crate::workspace::head_branch(Path::new(&m.folder)));
    Ok(json!({
        "session_id": id,
        "title": m.title,
        "folder": m.folder,
        "repo": m.repo_folder().map(|p| p.display().to_string()),
        "branch": branch,
        "model": config.model,
        "effort": config.effort,
    }))
}

/// A Sub Session of `parent` by id; any other Session is refused.
fn owned_child(host: &Harness, parent: &Session, args: &Value, tool: &str) -> anyhow::Result<Arc<Session>> {
    let id = required(args, "id", tool)?;
    let child = host.session(&id).map_err(|_| anyhow::anyhow!("no Sub Session {id}"))?;
    let owned = child.meta().parent.is_some_and(|p| p.session_id == parent.id());
    anyhow::ensure!(owned, "Session {id} is not a Sub Session of this Session");
    Ok(child)
}

async fn send(host: &Arc<Harness>, session: &Arc<Session>, thread: &ThreadId, args: &Value) -> anyhow::Result<Value> {
    let child = owned_child(host, session, args, "session_send")?;
    let text = required(args, "text", "session_send")?;
    let m = child.meta();
    let busy = || -> anyhow::Result<()> {
        anyhow::ensure!(!child.thread_working(&m.main_thread_id)?, "Sub Session \"{}\" is still working. Call session_wait first.", m.title);
        Ok(())
    };
    busy()?;
    crate::acp::authorize(session, thread, "session_send", &format!("Send to sub session: {}", m.title), "session", args).await?;
    busy()?;
    child.prompt(None, text, Vec::new(), Some(origin(session))).await?;
    Ok(json!({ "session_id": m.id, "title": m.title }))
}

/// Unsubscribes from AppEvents when the wait ends in any way.
struct Subscription(Arc<Harness>, u64);

impl Drop for Subscription {
    fn drop(&mut self) {
        self.0.unsubscribe_app(self.1);
    }
}

async fn wait(host: &Arc<Harness>, session: &Arc<Session>, thread: &ThreadId, args: &Value) -> anyhow::Result<Value> {
    let child = owned_child(host, session, args, "session_wait")?;
    let timeout = args.get("timeout_s").and_then(Value::as_u64).unwrap_or(WAIT_DEFAULT_S).min(WAIT_MAX_S);
    let m = child.meta();
    crate::acp::authorize(session, thread, "session_wait", &format!("Wait for sub session: {}", m.title), "read", args).await?;
    // The wait reports this child's Turn end itself: no notice for it meanwhile.
    let _waiting = session.shared().notices.waiting(&m.id);
    // Subscribe before looking, so an end between the look and the wait still wakes it.
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let (id, main) = (m.id.clone(), m.main_thread_id.clone());
    let sub = host.subscribe_app(Box::new(move |e| {
        let hit = match e {
            AppEvent::TurnFinished { session_id, thread_id, .. } => *session_id == id && *thread_id == main,
            AppEvent::SessionStatus { session_id, .. } => *session_id == id,
            _ => false,
        };
        if hit { tx.send(()).is_ok() } else { !tx.is_closed() }
    }));
    let _sub = Subscription(host.clone(), sub);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout);
    while status(&child)? == "working" {
        match tokio::time::timeout_at(deadline, rx.recv()).await {
            Ok(Some(())) => {}
            Ok(None) | Err(_) => break,
        }
    }
    let out = report(&child)?;
    if out["status"] != "working" {
        session.shared().notices.drop_for(&session.id(), &m.id);
    }
    Ok(out)
}

/// Every Sub Session of this Session (oldest first), with its status, so the Agent finds them again
/// after its context lost the `session_start` results.
async fn list(host: &Arc<Harness>, session: &Arc<Session>, thread: &ThreadId, args: &Value) -> anyhow::Result<Value> {
    crate::acp::authorize(session, thread, "session_list", "List sub sessions", "read", args).await?;
    let rows = host
        .children(&session.id())
        .iter()
        .map(|c| {
            let m = c.meta();
            let branch = m.workspace.worktree.as_ref().map(|w| w.branch.clone()).or_else(|| crate::workspace::head_branch(Path::new(&m.folder)));
            Ok(json!({
                "session_id": m.id,
                "title": m.title,
                "folder": m.folder,
                "repo": m.repo_folder().map(|p| p.display().to_string()),
                "branch": branch,
                "status": status(c)?,
                "archived": m.archived,
            }))
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    Ok(json!({ "sub_sessions": rows }))
}

/// `needs_attention` (a permission request waits for the user), `working` (a Main Thread Turn is in
/// flight) or `idle`.
fn status(child: &Session) -> anyhow::Result<&'static str> {
    if child.agent_slot().status() == SessionStatus::NeedsAttention {
        return Ok("needs_attention");
    }
    Ok(if child.thread_working(&child.meta().main_thread_id)? { "working" } else { "idle" })
}

/// The `session_wait` answer: status, and the last Main Thread Turn's stop reason, duration and
/// last reply.
fn report(child: &Session) -> anyhow::Result<Value> {
    let m = child.meta();
    let status = status(child)?;
    let events = child.log().events()?;
    let main = &m.main_thread_id;
    let started = events.iter().rev().find_map(|e| match &e.kind {
        EventKind::TurnStarted { turn_id, .. } if e.thread_id.as_ref() == Some(main) => Some((turn_id.clone(), e.ts_ms)),
        _ => None,
    });
    let ended = started.as_ref().and_then(|(turn, _)| {
        events.iter().rev().find_map(|e| match &e.kind {
            EventKind::TurnEnded { turn_id, stop_reason } if turn_id == turn => Some((stop_reason.clone(), e.ts_ms)),
            _ => None,
        })
    });
    let duration_ms = match (&started, &ended) {
        (Some((_, from)), Some((_, to))) => to - from,
        (Some((_, from)), None) => crate::log::now_ms() - from,
        _ => 0,
    };
    let reply = crate::summary::turns(&events, main, None)
        .pop()
        .and_then(|t| {
            t.parts.into_iter().rev().find_map(|p| match p {
                crate::summary::Part::Reply(r) => Some(r),
                crate::summary::Part::Tool { .. } => None,
            })
        })
        .unwrap_or_default();
    let mut out = json!({ "session_id": m.id, "title": m.title, "status": status, "duration_ms": duration_ms, "reply": reply });
    if let Some((stop_reason, _)) = ended.filter(|_| status != "working") {
        out["stop_reason"] = json!(stop_reason);
    }
    Ok(out)
}

/// Messages for parents about their Sub Sessions, held until the parent's Main Thread is idle,
/// then sent as one prompt.
#[derive(Default)]
pub struct Notices(parking_lot::Mutex<NoticeState>);

#[derive(Default)]
struct NoticeState {
    /// By parent: (child, text for the Agent, the same for Frontends), oldest first.
    pending: HashMap<SessionId, Vec<(SessionId, String, SubSessionReport)>>,
    /// Children a `session_wait` waits for, and how many waits.
    waiting: HashMap<SessionId, usize>,
    /// Children already reported as waiting for the user (until they stop waiting).
    attention: HashSet<SessionId>,
    /// Parents a notice prompt is being sent to.
    sending: HashSet<SessionId>,
}

/// Counts a running `session_wait` for a child until dropped.
pub struct Waiting<'a>(&'a Notices, SessionId);

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        let mut st = self.0.0.lock();
        if let Some(n) = st.waiting.get_mut(&self.1) {
            *n -= 1;
            if *n == 0 {
                st.waiting.remove(&self.1);
            }
        }
    }
}

impl Notices {
    fn waiting(&self, child: &SessionId) -> Waiting<'_> {
        *self.0.lock().waiting.entry(child.clone()).or_default() += 1;
        Waiting(self, child.clone())
    }

    /// Drops what a parent was still to hear about a child (a `session_wait` just told it).
    fn drop_for(&self, parent: &SessionId, child: &SessionId) {
        if let Some(list) = self.0.lock().pending.get_mut(parent) {
            list.retain(|(c, ..)| c != child);
        }
    }

    fn push(&self, parent: &SessionId, text: String, report: SubSessionReport) {
        self.0.lock().pending.entry(parent.clone()).or_default().push((report.session_id.clone(), text, report));
    }
}

/// Watches Turn ends and status changes for `Notices`, for the Harness's lifetime.
pub(crate) fn watch(host: &Arc<Harness>) {
    let weak = Arc::downgrade(host);
    host.subscribe_app(Box::new(move |e| {
        let Some(host) = weak.upgrade() else { return false };
        on_event(&host, e);
        true
    }));
}

fn on_event(host: &Arc<Harness>, e: &AppEvent) {
    let (session_id, ended) = match e {
        AppEvent::TurnFinished { session_id, thread_id, .. } => (session_id, Some(thread_id)),
        AppEvent::SessionStatus { session_id, .. } => (session_id, None),
        _ => return,
    };
    let Ok(session) = host.session(session_id) else { return };
    let m = session.meta();
    if let Some(thread) = ended
        && *thread != m.main_thread_id
    {
        return;
    }
    // As a parent: its Main Thread may be idle now.
    if ended.is_some() && m.parent.is_none() {
        flush(host, session_id);
    }
    let Some(parent) = m.parent.filter(|p| p.notify) else { return };
    let notices = &session.shared().notices;
    let needs_user = session.agent_slot().status() == SessionStatus::NeedsAttention;
    {
        let mut st = notices.0.lock();
        if !needs_user {
            st.attention.remove(session_id);
        }
        // A status change only matters when the child starts waiting for the user.
        if ended.is_none() && (!needs_user || st.attention.contains(session_id)) {
            return;
        }
        if st.waiting.contains_key(session_id) {
            return;
        }
    }
    if !started_by(&session, &parent.session_id) {
        return;
    }
    let mut report = SubSessionReport {
        session_id: m.id.clone(),
        title: m.title.clone(),
        kind: SubSessionReportKind::NeedsUser,
        stop_reason: None,
        duration_ms: None,
        asked: last_prompt(&session),
        reply: None,
    };
    let text = if ended.is_some() {
        let Ok(r) = self::report(&session) else { return };
        report.kind = SubSessionReportKind::Ended;
        report.stop_reason = r["stop_reason"].as_str().map(str::to_owned);
        report.duration_ms = r["duration_ms"].as_i64();
        report.reply = r["reply"].as_str().filter(|r| !r.trim().is_empty()).map(str::to_owned);
        let mut text = format!("Sub Session \"{}\" (session_id {}) ended its Turn", m.title, m.id);
        if let Some(stop) = &report.stop_reason {
            text += &format!(" ({stop})");
        }
        match &report.reply {
            Some(reply) => text + ". Its last reply:\n\n" + reply,
            None => text + " without a reply.",
        }
    } else {
        notices.0.lock().attention.insert(session_id.clone());
        format!("Sub Session \"{}\" (session_id {}) waits for the user to answer a permission request there. It goes on once the user answers.", m.title, m.id)
    };
    notices.push(&parent.session_id, text, report);
    flush(host, &parent.session_id);
}

/// The prompt of the latest Main Thread Turn of `child`.
fn last_prompt(child: &Session) -> Option<String> {
    let main = child.meta().main_thread_id;
    let events = child.log().events().ok()?;
    events.iter().rev().find_map(|e| match &e.kind {
        EventKind::TurnStarted { text, .. } if e.thread_id.as_ref() == Some(&main) => Some(text.clone()),
        _ => None,
    })
}

/// Whether the latest Main Thread Turn of `child` came from the parent's Agent (not from the user).
fn started_by(child: &Session, parent: &SessionId) -> bool {
    let main = child.meta().main_thread_id;
    let Ok(events) = child.log().events() else { return false };
    events.iter().rev().find_map(|e| match &e.kind {
        EventKind::TurnStarted { origin, .. } if e.thread_id.as_ref() == Some(&main) => {
            Some(origin.as_ref().is_some_and(|o| o.session_id == *parent && o.kind == PromptOriginKind::Parent))
        }
        _ => None,
    }) == Some(true)
}

/// Sends a parent its pending notices as one prompt, when its Main Thread is idle. Otherwise its
/// next Turn end comes back here.
fn flush(host: &Arc<Harness>, parent_id: &SessionId) {
    let Ok(rt) = tokio::runtime::Handle::try_current() else { return };
    let Ok(parent) = host.session(parent_id) else { return };
    let notices = &parent.shared().notices;
    if notices.0.lock().pending.get(parent_id).is_none_or(Vec::is_empty) {
        return;
    }
    let m = parent.meta();
    if m.archived || parent.thread_working(&m.main_thread_id).unwrap_or(true) {
        return;
    }
    let list = {
        let mut st = notices.0.lock();
        if !st.sending.insert(parent_id.clone()) {
            return;
        }
        st.pending.remove(parent_id).unwrap_or_default()
    };
    let parent_id = parent_id.clone();
    rt.spawn(async move {
        let titles: Vec<&str> = list.iter().map(|(.., r)| r.title.as_str()).collect();
        let text = list.iter().map(|(_, text, _)| text.as_str()).collect::<Vec<_>>().join("\n\n---\n\n");
        let origin = PromptOrigin {
            session_id: list[0].0.clone(),
            title: titles.join(", "),
            kind: PromptOriginKind::SubSession,
            reports: list.into_iter().map(|(.., r)| r).collect(),
        };
        if let Err(e) = parent.prompt(None, text, Vec::new(), Some(origin)).await {
            tracing::warn!("telling Session {parent_id} about its Sub Sessions: {e:#}");
        }
        parent.shared().notices.0.lock().sending.remove(&parent_id);
    });
}

/// The latest config options of the Session's Main Thread (empty before its Agent reported any).
fn main_config(session: &Session) -> anyhow::Result<Vec<Value>> {
    let main = session.meta().main_thread_id;
    Ok(session
        .log()
        .events()?
        .into_iter()
        .rev()
        .find_map(|e| match e.kind {
            EventKind::ConfigOptionsChanged { options, .. } if e.thread_id.as_ref() == Some(&main) => options.as_array().cloned(),
            _ => None,
        })
        .unwrap_or_default())
}

/// A Sub Session's starting model and effort.
#[derive(Debug, Default, PartialEq)]
struct Config {
    /// Config option id -> value, for `SessionMeta::initial_config`.
    values: BTreeMap<String, String>,
    model: Option<String>,
    effort: Option<String>,
}

impl Config {
    /// The parent's current model and effort, each replaced by the asked one (a value, or a name
    /// in any case) when given. An unknown one errors with the valid names.
    fn choose(options: &[Value], model: Option<&str>, effort: Option<&str>) -> anyhow::Result<Self> {
        let mut out = Config::default();
        for (role, asked) in [(Role::Model, model), (Role::Effort, effort)] {
            let Some(option) = options.iter().find(|o| role.matches(o)) else {
                anyhow::ensure!(asked.is_none(), "this agent has no {} option", role.label());
                continue;
            };
            let value = match asked {
                Some(a) => role.pick(option, a)?,
                None => match option["currentValue"].as_str() {
                    Some(v) => v.to_owned(),
                    None => continue,
                },
            };
            if let Some(id) = option["id"].as_str() {
                out.values.insert(id.to_owned(), value.clone());
            }
            match role {
                Role::Model => out.model = Some(value),
                Role::Effort => out.effort = Some(value),
            }
        }
        Ok(out)
    }
}

#[derive(Clone, Copy)]
enum Role {
    Model,
    Effort,
}

impl Role {
    fn label(self) -> &'static str {
        match self {
            Role::Model => "model",
            Role::Effort => "effort",
        }
    }

    /// By ACP category, else by a common id (Agents without categories).
    fn matches(self, option: &Value) -> bool {
        let (category, ids): (&str, &[&str]) = match self {
            Role::Model => ("model", &["model"]),
            Role::Effort => ("thought_level", &["effort", "reasoning_effort", "thought_level"]),
        };
        match option["category"].as_str() {
            Some(c) => c == category,
            None => option["id"].as_str().is_some_and(|id| ids.contains(&id)),
        }
    }

    fn pick(self, option: &Value, asked: &str) -> anyhow::Result<String> {
        let choices = choices(option);
        let hit =
            choices.iter().find(|(v, _)| v == asked).or_else(|| choices.iter().find(|(v, n)| n.eq_ignore_ascii_case(asked) || v.eq_ignore_ascii_case(asked)));
        match hit {
            Some((v, _)) => Ok(v.clone()),
            None => {
                let valid: Vec<String> = choices.iter().map(|(v, n)| if v == n { v.clone() } else { format!("{n} ({v})") }).collect();
                anyhow::bail!("unknown {} {asked:?}. Valid: {}", self.label(), valid.join(", "))
            }
        }
    }
}

/// (value, name) of a select option's choices, groups flattened.
fn choices(option: &Value) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for o in option["options"].as_array().into_iter().flatten() {
        if let Some(group) = o["options"].as_array() {
            out.extend(group.iter().filter_map(choice));
        } else {
            out.extend(choice(o));
        }
    }
    out
}

fn choice(o: &Value) -> Option<(String, String)> {
    let v = o["value"].as_str()?;
    Some((v.to_owned(), o["name"].as_str().unwrap_or(v).to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options() -> Vec<Value> {
        serde_json::from_value(json!([
            { "id": "model", "category": "model", "currentValue": "opus", "options": [
                { "group": "main", "name": "Main", "options": [{ "value": "opus", "name": "Opus" }, { "value": "sonnet", "name": "Sonnet" }] }
            ] },
            { "id": "effort", "category": "thought_level", "currentValue": "high", "options": [{ "value": "low", "name": "Low" }, { "value": "high", "name": "High" }] },
            { "id": "mode", "category": "mode", "currentValue": "auto", "options": [{ "value": "auto", "name": "Auto" }] }
        ]))
        .unwrap()
    }

    #[test]
    fn defaults_to_the_parents_model_and_effort_but_not_its_mode() {
        let c = Config::choose(&options(), None, None).unwrap();
        assert_eq!(c.values, BTreeMap::from([("model".into(), "opus".into()), ("effort".into(), "high".into())]));
        assert_eq!((c.model.as_deref(), c.effort.as_deref()), (Some("opus"), Some("high")));
    }

    #[test]
    fn picks_by_value_or_name_in_any_case() {
        let c = Config::choose(&options(), Some("SONNET"), Some("low")).unwrap();
        assert_eq!(c.values["model"], "sonnet");
        assert_eq!(c.values["effort"], "low");
    }

    #[test]
    fn an_unknown_choice_lists_the_valid_names() {
        let e = Config::choose(&options(), Some("gpt"), None).unwrap_err().to_string();
        assert_eq!(e, "unknown model \"gpt\". Valid: Opus (opus), Sonnet (sonnet)");
        let e = Config::choose(&[], None, Some("high")).unwrap_err().to_string();
        assert_eq!(e, "this agent has no effort option");
    }

    #[test]
    fn options_without_categories_match_by_id() {
        let o: Vec<Value> = serde_json::from_value(json!([{ "id": "model", "currentValue": "a", "options": [{ "value": "a", "name": "A" }] }])).unwrap();
        assert_eq!(Config::choose(&o, None, None).unwrap().values["model"], "a");
    }
}
