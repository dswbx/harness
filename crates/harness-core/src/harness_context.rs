//! `<harness_context>`: what the Agent should know about the Harness hosting it. Sent as a text
//! block before the user's text on the first prompt of each Agent Session, the way agent apps send
//! their own instruction files. The texts are plain files: `prompts/harness.md` (built in) and the
//! Frontend's `instructions.md` (in its manifest). `<data dir>/prompts/harness.md` and
//! `<data dir>/prompts/<frontend id>.md` override them without a rebuild.

use std::path::Path;

use crate::session::Session;

const HARNESS: &str = include_str!("../prompts/harness.md");

pub fn build(session: &Session) -> String {
    let dir = &session.shared().prompts_dir;
    let frontend = session.frontend();
    let mut parts = vec![read(dir, "harness").unwrap_or_else(|| HARNESS.trim().to_owned())];
    if let Some(f) = &frontend
        && let Some(text) = read(dir, &f.id).or_else(|| f.instructions.clone())
    {
        parts.push(format!("## Frontend: {}\n\n{text}", f.name));
    }
    parts.push(facts(session));
    format!("<harness_context>\n{}\n</harness_context>", parts.join("\n\n"))
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
