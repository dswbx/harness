//! The Primitive tools: one table of name, description, schema, Permission Policy kind and handler, and
//! the dispatcher that runs a call.

use std::sync::Arc;

use futures_util::future::BoxFuture;
use rmcp::model::ContentBlock;
use serde_json::{Value, json};

use super::frontend_tools;
use super::info::{info, shared_info, ui_get};
use crate::api::{GitActor, ThreadId};
use crate::session::Session;

/// Tools that read other Threads, not offered to a Side Thread started without the Main Thread's
/// conversation (its point is an independent view).
pub(super) const TRANSCRIPT_TOOLS: [&str; 4] = ["threads_list", "transcript_outline", "transcript_read", "transcript_search"];

/// What runs a Primitive: the Sub Session tools ask the Permission Policy themselves (`sub_sessions::call`);
/// the others are authorized by the dispatcher first.
pub(super) enum Handler {
    Sub,
    Run(Run),
}

type Run = for<'a> fn(&'a Arc<Session>, &'a ThreadId, &'a Value) -> BoxFuture<'a, anyhow::Result<String>>;

/// A Primitive tool, listed and handled from one entry.
pub(super) struct Primitive {
    pub(super) name: &'static str,
    pub(super) description: &'static str,
    /// Input schema.
    pub(super) schema: Value,
    /// Permission Policy kind.
    pub(super) kind: &'static str,
    pub(super) handler: Handler,
}

impl Primitive {
    fn run(name: &'static str, description: &'static str, schema: Value, kind: &'static str, run: Run) -> Self {
        Self { name, description, schema, kind, handler: Handler::Run(run) }
    }

    fn sub(name: &'static str, description: &'static str, schema: Value, kind: &'static str) -> Self {
        Self { name, description, schema, kind, handler: Handler::Sub }
    }
}

/// Primitive tools, in the order they are listed.
pub(super) fn primitives() -> Vec<Primitive> {
    let empty = json!({ "type": "object", "properties": {} });
    vec![
        Primitive::run(
            "git_status",
            "Git status of the Session's Workspace: branch, upstream, ahead/behind, changed files.",
            empty.clone(),
            "read",
            |s, t, a| Box::pin(run_git_status(s, t, a)),
        ),
        Primitive::run(
            "git_diff",
            "Unified diff of the Workspace. Defaults to everything changed in this Session (since its base branch, or HEAD), untracked files included.",
            json!({ "type": "object", "properties": {
                "from": { "type": "string", "description": "Commit or tree to diff from" },
                "to": { "type": "string", "description": "Commit or tree to diff to (default: the working tree)" }
            } }),
            "read",
            |s, t, a| Box::pin(run_git_diff(s, t, a)),
        ),
        Primitive::run("list_branches", "Local branches of the Workspace's repository, most recent first.", empty.clone(), "read", |s, t, a| {
            Box::pin(run_list_branches(s, t, a))
        }),
        Primitive::run(
            "git_commit",
            "Stage all changes in the Workspace and commit them.",
            json!({ "type": "object", "properties": { "message": { "type": "string" } }, "required": ["message"] }),
            "git_commit",
            |s, t, a| Box::pin(run_git_commit(s, t, a)),
        ),
        Primitive::run("git_push", "Push the current branch to origin (sets upstream).", empty.clone(), "git_push", |s, t, a| Box::pin(run_git_push(s, t, a))),
        Primitive::run(
            "state_get",
            "Read the Session State: one JSON document the user's UI can show and change (e.g. a score, answers). Omit `statePath` for all of it. With `artifact`, read that attached Shared Artifact's own state instead.",
            json!({ "type": "object", "properties": {
                "statePath": { "type": "string", "description": "JSON Pointer, e.g. /quiz/score" },
                "artifact": { "type": "string", "description": "Id of an attached Shared Artifact" }
            } }),
            "read",
            |s, t, a| Box::pin(run_state_get(s, t, a)),
        ),
        Primitive::run(
            "state_patch",
            "Change the Session State with JSON Patch operations, applied all or nothing. `add`/`replace` create missing parent objects; `-` appends to an array; `test` checks a value first. UI bound to a path (`{\"$state\": \"/quiz/score\"}`) updates at once. Returns the new state.",
            json!({ "type": "object", "properties": {
                "ops": { "type": "array", "minItems": 1, "items": { "type": "object", "properties": {
                    "op": { "type": "string", "enum": ["add", "replace", "remove", "test"] },
                    "path": { "type": "string", "description": "JSON Pointer, e.g. /quiz/score" },
                    "value": { "description": "For add, replace and test" }
                }, "required": ["op", "path"] } },
                "artifact": { "type": "string", "description": "Id of an attached Shared Artifact: change its own state instead of the Session State" }
            }, "required": ["ops"] }),
            "state",
            |s, t, a| Box::pin(run_state_patch(s, t, a)),
        ),
        Primitive::run(
            "harness_info",
            "What the user's UI shows now: live Frontend items you placed with an `id` (e.g. render_ui slots: id, placement, title, source, `updated_ms` (when it last changed: its latest call, or a later write of its source file), and `errors` the UI reported, such as script errors or a missing source file), the top-level keys of the Session State, `panels_dir`: the folder for the .md, .html or .json files of file-backed panels (render_ui `source`), and `shared`: the Shared Artifacts attached to this Session (id, title, kind, `dir`: their folder, `file`: the content file in it).",
            empty.clone(),
            "read",
            |s, t, a| Box::pin(run_harness_info(s, t, a)),
        ),
        Primitive::run(
            "set_title",
            "Name this Session: a short title (3-7 words) the user sees in the sidebar and header. Replaces the automatic title.",
            json!({ "type": "object", "properties": { "title": { "type": "string" } }, "required": ["title"] }),
            "state",
            |s, t, a| Box::pin(run_set_title(s, t, a)),
        ),
        Primitive::run(
            "ui_get",
            "Read a panel you placed with render_ui: its stored input (root or source, placement, title, ...), the Session State values its `$state` paths point to, and for a `source` panel the file's current `content`. For a Shared Artifact (`shared:<id>`, or a panel whose source is one): its meta, content and its own state. Use it before you change a panel you no longer see, e.g. after compaction.",
            json!({ "type": "object", "properties": {
                "id": { "type": "string", "description": "The panel's id, as in render_ui, or shared:<artifact id>" }
            }, "required": ["id"] }),
            "read",
            |s, t, a| Box::pin(run_ui_get(s, t, a)),
        ),
        Primitive::run(
            "artifact_search",
            "Find Shared Artifacts (artifacts kept outside any Session, e.g. a checklist the user works on across Sessions) whose title or content contains `query`. Returns id, title, kind, updated_ms, a snippet, and whether this Session has it attached. Use it when the user names one. Omit `query` to list all.",
            json!({ "type": "object", "properties": { "query": { "type": "string" } } }),
            "read",
            |s, t, a| Box::pin(run_artifact_search(s, t, a)),
        ),
        Primitive::run(
            "artifact_share",
            "Make one of this Session's render_ui panels (by its id) a Shared Artifact, so other Sessions can attach it. Its file or tree moves out of this Session, with the state it uses. Only when the user asks. Returns the shared id and its folder.",
            json!({ "type": "object", "properties": {
                "id": { "type": "string", "description": "The panel's id, as in render_ui" }
            }, "required": ["id"] }),
            "state",
            |s, t, a| Box::pin(run_artifact_share(s, t, a)),
        ),
        Primitive::run(
            "artifact_attach",
            "Attach a Shared Artifact to this Session: the user sees it as a panel. Returns its folder and content file: edit .md and .html files there with your Edit tool; for a render_ui tree call render_ui with `id: \"shared:<id>\"` and a new `root`. Attaching is explicit: do it when the user asks for the artifact, not because it was named.",
            json!({ "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] }),
            "state",
            |s, t, a| Box::pin(run_artifact_attach(s, t, a)),
        ),
        Primitive::run(
            "artifact_detach",
            "Detach a Shared Artifact from this Session. The artifact stays; other Sessions keep it.",
            json!({ "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] }),
            "state",
            |s, t, a| Box::pin(run_artifact_detach(s, t, a)),
        ),
        Primitive::run(
            "threads_list",
            "The Threads of this Session: the Main Thread and any Side Threads (id, kind, title from the first prompt, Turn count).",
            empty,
            "read",
            |s, t, a| Box::pin(run_threads_list(s, t, a)),
        ),
        Primitive::run(
            "transcript_outline",
            "Outline of a Thread's transcript: one line per Turn (number, short prompt, tool count, size). Read-only.",
            json!({ "type": "object", "properties": { "thread": crate::transcript::thread_schema() } }),
            "read",
            |s, t, a| Box::pin(run_transcript_outline(s, t, a)),
        ),
        Primitive::run(
            "transcript_read",
            "Read Turns `from` to `to` (1-based, inclusive) of a Thread's transcript: prompts, replies and tool titles. Tool input and output only with `tools`. Read-only.",
            json!({ "type": "object", "properties": {
                "thread": crate::transcript::thread_schema(),
                "from": { "type": "integer", "minimum": 1, "description": "First Turn (default 1)" },
                "to": { "type": "integer", "minimum": 1, "description": "Last Turn (default: the last)" },
                "tools": { "type": "boolean", "description": "Include tool input and output (default false)" }
            } }),
            "read",
            |s, t, a| Box::pin(run_transcript_read(s, t, a)),
        ),
        Primitive::run(
            "transcript_search",
            "Find Turns of a Thread's transcript containing `query` (case-insensitive): Turn numbers with snippets. Read-only.",
            json!({ "type": "object", "properties": {
                "thread": crate::transcript::thread_schema(),
                "query": { "type": "string" }
            }, "required": ["query"] }),
            "read",
            |s, t, a| Box::pin(run_transcript_search(s, t, a)),
        ),
        Primitive::sub(
            "session_start",
            "Start a Sub Session: another Session with its own agent, shown to the user under this one. Only for work the user asked to run separately (for example in another repository). It works in a new worktree when the folder is in a git repository, unless `worktree` is false. Returns once its first Turn started, as JSON: session_id, title, folder, repo, branch, agent, model, effort. When a Turn you started there ends, or it waits for the user, you get a message from the Harness, so you can end your Turn instead of waiting; use session_wait only when you need its reply before you go on.",
            json!({ "type": "object", "properties": {
                "prompt": { "type": "string", "description": "The first message to its agent" },
                "folder": { "type": "string", "description": "Folder to work in (default: this Session's folder, outside its worktree)" },
                "title": { "type": "string" },
                "agent": { "type": "string", "description": "Installed agent by id or name, for example \"codex\" or \"claude\", for an independent review (default: this Session's agent)" },
                "model": { "type": "string", "description": "Model value or name (default: this Session's model; with another agent, that agent's last model)" },
                "effort": { "type": "string", "description": "Effort value or name (default: this Session's effort; with another agent, that agent's last effort)" },
                "worktree": { "type": "boolean", "description": "Work in a new worktree (default: true in a git repository)" },
                "branch": { "type": "string", "description": "Branch to cut the worktree from (default: the current branch). Needs a worktree." },
                "notify": { "type": "boolean", "description": "Get a message when a Turn you started there ends or it waits for the user (default true)" }
            }, "required": ["prompt"] }),
            "session",
        ),
        Primitive::sub(
            "session_send",
            "Send a message to one of your Sub Sessions. Refused while it is still working: call session_wait first. Returns JSON: session_id, title.",
            json!({ "type": "object", "properties": {
                "id": { "type": "string", "description": "session_id from session_start" },
                "text": { "type": "string" }
            }, "required": ["id", "text"] }),
            "session",
        ),
        Primitive::sub(
            "session_wait",
            "Wait until one of your Sub Sessions ends its Turn or needs the user, at most `timeout_s` seconds (0: check its status now, without waiting). Returns JSON: session_id, title, status (idle, needs_attention or working when the wait timed out; then call it again), stop_reason, duration_ms, reply (its last message).",
            json!({ "type": "object", "properties": {
                "id": { "type": "string", "description": "session_id from session_start" },
                "timeout_s": { "type": "integer", "minimum": 0, "maximum": 1800, "description": "Default 600. 0 checks now." }
            }, "required": ["id"] }),
            "read",
        ),
        Primitive::sub(
            "session_list",
            "List your Sub Sessions, oldest first. Returns JSON: sub_sessions, each with session_id, title, folder, repo, branch, status (idle, needs_attention or working), archived.",
            json!({ "type": "object", "properties": {} }),
            "read",
        ),
    ]
}

/// `k` of the call's arguments, when it is a string.
fn arg_str(args: &Value) -> impl Fn(&str) -> Option<String> + '_ {
    |k| args.get(k).and_then(Value::as_str).map(str::to_owned)
}

/// Runs one tool call for the Session, after the Permission Policy agrees.
pub(super) async fn call(session: &Arc<Session>, thread: &ThreadId, name: &str, args: Value) -> anyhow::Result<Vec<ContentBlock>> {
    if let Some(p) = primitives().into_iter().find(|p| p.name == name) {
        let run = match p.handler {
            Handler::Sub => return Ok(vec![ContentBlock::text(crate::sub_sessions::call(session, thread, name, &args).await?)]),
            Handler::Run(run) => run,
        };
        anyhow::ensure!(
            !(TRANSCRIPT_TOOLS.contains(&name) && session.is_fresh_side(thread)),
            "{name} is not available: the user started this Side Thread without the Main Thread's conversation"
        );
        let s = arg_str(&args);
        let title = match name {
            "git_commit" => format!("Commit: {}", s("message").unwrap_or_default()),
            "git_push" => "Push branch to origin".to_owned(),
            _ => p.description.to_owned(),
        };
        crate::acp::authorize(session, thread, name, &title, p.kind, &args).await?;
        return Ok(vec![ContentBlock::text(run(session, thread, &args).await?)]);
    }
    frontend_tools::call(session, thread, name, args).await
}

async fn run_git_status(session: &Arc<Session>, _: &ThreadId, _: &Value) -> anyhow::Result<String> {
    Ok(serde_json::to_string_pretty(&session.git_status().await?)?)
}

async fn run_git_diff(session: &Arc<Session>, _: &ThreadId, args: &Value) -> anyhow::Result<String> {
    let s = arg_str(args);
    let d = session.git_diff(s("from"), s("to")).await?;
    let mut patch = d.patch;
    if patch.len() > 200_000 {
        patch.truncate(patch.floor_char_boundary(200_000));
        patch.push_str("\n[diff truncated]");
    }
    Ok(if patch.is_empty() { "No changes.".to_owned() } else { patch })
}

async fn run_list_branches(session: &Arc<Session>, _: &ThreadId, _: &Value) -> anyhow::Result<String> {
    let folder = std::path::PathBuf::from(session.meta().folder);
    Ok(serde_json::to_string_pretty(&crate::git::list_branches(&folder).await?)?)
}

async fn run_git_commit(session: &Arc<Session>, _: &ThreadId, args: &Value) -> anyhow::Result<String> {
    let s = arg_str(args);
    let message = s("message").filter(|m| !m.trim().is_empty()).ok_or_else(|| anyhow::anyhow!("message is required"))?;
    Ok(super::results::committed_text(&session.git_commit(message, GitActor::Agent).await?))
}

async fn run_git_push(session: &Arc<Session>, _: &ThreadId, _: &Value) -> anyhow::Result<String> {
    let branch = session.git_push(GitActor::Agent).await?;
    Ok(super::results::pushed_text(&branch))
}

async fn run_state_get(session: &Arc<Session>, _: &ThreadId, args: &Value) -> anyhow::Result<String> {
    let s = arg_str(args);
    let state = match s("artifact") {
        Some(id) => {
            session.ensure_attached(&id)?;
            session.shared().artifacts.state(&id)?
        }
        None => session.state()?,
    };
    let v = match s("statePath").filter(|p| !p.is_empty()) {
        Some(p) => state.pointer(&p).cloned().ok_or_else(|| anyhow::anyhow!("nothing at {p}"))?,
        None => state,
    };
    Ok(serde_json::to_string_pretty(&v)?)
}

async fn run_state_patch(session: &Arc<Session>, thread: &ThreadId, args: &Value) -> anyhow::Result<String> {
    let s = arg_str(args);
    let ops: Vec<crate::api::StatePatchOp> =
        serde_json::from_value(args.get("ops").cloned().unwrap_or_default()).map_err(|e| anyhow::anyhow!("invalid ops: {e}"))?;
    let state = match s("artifact") {
        Some(id) => session.patch_artifact_state(Some(thread.clone()), &id, ops, crate::api::StateWriter::Agent)?,
        None => session.patch_state(Some(thread.clone()), ops, crate::api::StateWriter::Agent)?,
    };
    Ok(serde_json::to_string_pretty(&state)?)
}

async fn run_artifact_search(session: &Arc<Session>, _: &ThreadId, args: &Value) -> anyhow::Result<String> {
    let s = arg_str(args);
    let attached = session.attached_shared()?;
    let hits: Vec<Value> = session
        .shared()
        .artifacts
        .list(s("query").as_deref())
        .into_iter()
        .take(20)
        .map(|e| {
            let m = e.meta;
            json!({ "id": m.id, "title": m.title, "kind": m.kind, "updated_ms": m.updated_ms, "snippet": e.snippet, "attached": attached.contains(&m.id) })
        })
        .collect();
    Ok(if hits.is_empty() { "No Shared Artifacts match.".to_owned() } else { serde_json::to_string_pretty(&hits)? })
}

async fn run_artifact_share(session: &Arc<Session>, _: &ThreadId, args: &Value) -> anyhow::Result<String> {
    let s = arg_str(args);
    let id = s("id").ok_or_else(|| anyhow::anyhow!("id is required"))?;
    let meta = session.share_item(&id, crate::api::StateWriter::Agent)?;
    session.shared().app_events.emit(crate::api::AppEvent::SharedArtifactsChanged);
    Ok(serde_json::to_string_pretty(&shared_info(session, &meta))?)
}

async fn run_artifact_attach(session: &Arc<Session>, _: &ThreadId, args: &Value) -> anyhow::Result<String> {
    let s = arg_str(args);
    let id = s("id").ok_or_else(|| anyhow::anyhow!("id is required"))?;
    let meta = session.attach_shared(&id, crate::api::StateWriter::Agent)?;
    session.shared().app_events.emit(crate::api::AppEvent::SharedArtifactsChanged);
    Ok(serde_json::to_string_pretty(&shared_info(session, &meta))?)
}

async fn run_artifact_detach(session: &Arc<Session>, _: &ThreadId, args: &Value) -> anyhow::Result<String> {
    let s = arg_str(args);
    let id = s("id").ok_or_else(|| anyhow::anyhow!("id is required"))?;
    session.detach_shared(&id, crate::api::StateWriter::Agent)?;
    session.shared().app_events.emit(crate::api::AppEvent::SharedArtifactsChanged);
    Ok(format!("Detached {id}."))
}

async fn run_harness_info(session: &Arc<Session>, _: &ThreadId, _: &Value) -> anyhow::Result<String> {
    Ok(serde_json::to_string_pretty(&info(session)?)?)
}

async fn run_set_title(session: &Arc<Session>, _: &ThreadId, args: &Value) -> anyhow::Result<String> {
    let title = arg_str(args)("title").unwrap_or_default();
    session.set_title(&title)?;
    Ok(format!("Session titled: {}", session.meta().title))
}

async fn run_ui_get(session: &Arc<Session>, _: &ThreadId, args: &Value) -> anyhow::Result<String> {
    let s = arg_str(args);
    Ok(serde_json::to_string_pretty(&ui_get(session, s("id").as_deref())?)?)
}

async fn run_threads_list(session: &Arc<Session>, _: &ThreadId, _: &Value) -> anyhow::Result<String> {
    crate::transcript::threads_list(session)
}

async fn run_transcript_outline(session: &Arc<Session>, _: &ThreadId, args: &Value) -> anyhow::Result<String> {
    crate::transcript::outline(session, args)
}

async fn run_transcript_read(session: &Arc<Session>, _: &ThreadId, args: &Value) -> anyhow::Result<String> {
    crate::transcript::read(session, args)
}

async fn run_transcript_search(session: &Arc<Session>, _: &ThreadId, args: &Value) -> anyhow::Result<String> {
    crate::transcript::search(session, args)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sub_session_tools_are_the_ones_with_the_sub_handler() {
        let table = primitives();
        for name in crate::sub_sessions::TOOLS {
            assert!(table.iter().any(|p| p.name == name && matches!(p.handler, Handler::Sub)), "{name}");
        }
        assert_eq!(table.iter().filter(|p| matches!(p.handler, Handler::Sub)).count(), crate::sub_sessions::TOOLS.len());
    }
}
