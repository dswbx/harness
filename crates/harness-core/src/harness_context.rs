//! `<harness_context>`: what the Agent should know about the Harness hosting it. Sent as a text
//! block before the user's text on the first prompt of each Agent Session, the way agent apps send
//! their own instruction files. The texts are plain files: `prompts/harness.md` (built in) and the
//! Frontend's `instructions.md` (in its manifest). `<data dir>/prompts/harness.md` and
//! `<data dir>/prompts/<frontend id>.md` override them without a rebuild.

use std::path::Path;

use crate::api::ThreadId;
use crate::session::Session;

const HARNESS: &str = include_str!("../prompts/harness.md");

/// The full block for a new Agent Session of `thread` (plus the Side Thread note, if it is one).
pub fn build(session: &Session, thread: &ThreadId) -> String {
    let dir = &session.shared().prompts_dir;
    let frontend = session.frontend();
    let mut parts = vec![read(dir, "harness").unwrap_or_else(|| HARNESS.trim().to_owned())];
    if let Some(f) = &frontend
        && let Some(text) = read(dir, &f.id).or_else(|| f.instructions.clone())
    {
        parts.push(format!("## Frontend: {}\n\n{text}", f.name));
    }
    parts.push(facts(session));
    parts.extend(side_note(session, thread, false));
    format!("<harness_context>\n{}\n</harness_context>", parts.join("\n\n"))
}

/// What a forked Side Thread's Agent is told: it already has the Main Thread's full block.
pub fn fork_note(session: &Session, thread: &ThreadId) -> String {
    let note = side_note(session, thread, true).unwrap_or_default();
    format!("<harness_context>\n{note}\n</harness_context>")
}

/// Where a Side Thread comes from and what it may do; `None` for the Main Thread.
fn side_note(session: &Session, thread: &ThreadId, forked: bool) -> Option<String> {
    let meta = session.meta();
    let turn = meta.origins.get(thread)?.point.turn;
    let start = if forked {
        format!("You are in a Side Thread, forked from the Main Thread after its Turn {turn}. Everything above is the Main Thread's conversation up to then.")
    } else {
        format!("You are in a Side Thread, a detour from the Main Thread. The Main Thread's transcript up to its Turn {turn} may be given as context.")
    };
    Some(format!(
        "## Side Thread\n\n{start} What you say here does not enter the Main Thread. `transcript_read` and the other transcript tools read the Main Thread, including its later Turns."
    ))
}

fn read(dir: &Path, name: &str) -> Option<String> {
    let text = std::fs::read_to_string(dir.join(format!("{name}.md"))).ok()?;
    Some(text.trim().to_owned()).filter(|t| !t.is_empty())
}

/// Facts about this Session at the start of the Agent Session.
fn facts(session: &Session) -> String {
    let meta = session.meta();
    let mut lines = vec!["## This Session".to_owned(), format!("- Workspace folder: {}", meta.folder)];
    match (&meta.workspace.repo_root, &meta.workspace.worktree) {
        (_, Some(wt)) => {
            lines.push(format!("- Repository: {}", wt.repo_root.display()));
            lines.push(format!("- Worktree: yes, branch `{}`, cut from `{}`", wt.branch, wt.base));
        }
        (Some(root), None) => {
            lines.push(format!("- Repository: {}", root.display()));
            lines.push("- Worktree: no, you work in the user's own checkout".to_owned());
        }
        (None, None) => lines.push("- Not a git repository".to_owned()),
    }
    lines.join("\n")
}
