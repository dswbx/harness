//! Tools of the Session's Frontend: validated against the Frontend's schema, then stored or answered.

use std::sync::Arc;

use rmcp::model::ContentBlock;
use serde_json::{Value, json};

use super::info::info;
use crate::api::ThreadId;
use crate::session::Session;

/// Runs a call of one of the Session's Frontend Tools, after the Permission Policy agrees.
pub(super) async fn call(session: &Arc<Session>, thread: &ThreadId, name: &str, args: Value) -> anyhow::Result<Vec<ContentBlock>> {
    let tool = session.frontend_tools().into_iter().find(|t| t.name == name).ok_or_else(|| anyhow::anyhow!("unknown tool {name}"))?;
    let (validator, images) =
        crate::frontend_files::validator(&tool.input_schema).map_err(|e| anyhow::anyhow!("the Frontend's schema for {name} is invalid: {e}"))?;
    let errors = crate::frontend_files::format_errors(&validator, &args);
    // Agents may call a tool before they have seen its schema (some load schemas on demand), so
    // the error carries the description: enough to get the next call right.
    anyhow::ensure!(errors.is_empty(), "invalid input for {name}:\n{errors}\n\nHow to call {name}:\n{}", tool.description);
    // A file-backed panel (ADR 0023): the log keeps the name; the file must exist in panels_dir.
    // `shared:<id>` names an attached Shared Artifact instead (ADR 0024).
    if let Some(source) = args.get("source").and_then(Value::as_str) {
        match crate::shared::reference(source) {
            Some(id) => drop(session.ensure_attached(id)?),
            None => {
                let (content, _) =
                    crate::panels::read(&session.panels_dir(), source).map_err(|e| anyhow::anyhow!("{e:#}. Write the file first, then call {name} again."))?;
                if let Some(e) = tree_error(session, source, &content) {
                    anyhow::bail!("{e}\n\nFix the file, then call {name} again.");
                }
            }
        }
    }
    // `id: "shared:<id>"` with a `root` replaces a shared tree's `ui.json`. Not logged: the watcher
    // tells every View.
    if let Some(id) = args.get("id").and_then(Value::as_str).and_then(crate::shared::reference) {
        let root = args.get("root").filter(|_| args.get("remove").is_none() && args.get("source").is_none());
        let root = root.ok_or_else(|| anyhow::anyhow!("an id shared:<id> takes only a new root (to detach it, use artifact_detach)"))?;
        session.ensure_attached(id)?;
        let images = images.lock().clone();
        let planned = crate::frontend_files::plan(std::path::Path::new(&session.meta().folder), &images)?;
        crate::acp::authorize(session, thread, name, &format!("Frontend tool: {name}"), "frontend_tool", &args).await?;
        session.shared().artifacts.write_ui(id, root, planned)?;
        session.shared().app_events.emit(crate::api::AppEvent::SharedArtifactChanged { id: id.to_owned() });
        return Ok(vec![ContentBlock::text(format!("Done. Shared artifact {id} now shows the new tree in every Session that has it attached."))]);
    }
    if tool.replies {
        crate::acp::authorize(session, thread, name, &format!("Frontend tool: {name}"), "read", &args).await?;
        let answer = session.request_frontend(name, args).await?;
        if let Some(error) = answer.error {
            anyhow::bail!("{error}");
        }
        let text = answer.text.map(ContentBlock::text);
        let image = answer.image.map(|i| ContentBlock::image(i.data, i.mime));
        return Ok(text.into_iter().chain(image).collect());
    }
    let images = images.lock().clone();
    let planned = crate::frontend_files::plan(std::path::Path::new(&session.meta().folder), &images)?;
    crate::acp::authorize(session, thread, name, &format!("Frontend tool: {name}"), "frontend_tool", &args).await?;
    let files = crate::frontend_files::store(&session.frontend_dir(), planned)?;
    let path = session.write_frontend_tool_output(thread, name, args, files)?;
    let items = info(session)?["items"].clone();
    Ok(vec![ContentBlock::text(format!("Done. The Frontend received it ({path}). Live items: {items}"))])
}

/// Why a `.json` panel source cannot show: not JSON, no `root`, a root the render_ui schema refuses,
/// or a local image (only `root` input copies those). None for other sources and good trees.
pub(super) fn tree_error(session: &Session, source: &str, content: &str) -> Option<String> {
    if !source.ends_with(".json") {
        return None;
    }
    let ui: Value = match serde_json::from_str(content) {
        Ok(v) => v,
        Err(e) => return Some(format!("source {source:?} is not JSON: {e}")),
    };
    let Some(root) = ui.get("root").filter(|r| r.is_object()) else {
        return Some(format!("source {source:?} must be {{\"root\": node}}, the same root you would pass to render_ui"));
    };
    let tool = session.frontend_tools().into_iter().find(|t| t.name == crate::session::RENDER_UI)?;
    let (validator, images) = crate::frontend_files::validator(&tool.input_schema).ok()?;
    let errors = crate::frontend_files::format_errors(&validator, &json!({ "root": root }));
    if !errors.is_empty() {
        return Some(format!("source {source:?} has an invalid tree:\n{errors}"));
    }
    let local: Vec<String> = images.lock().iter().filter(|s| !s.starts_with("https://") && !s.starts_with("data:image/")).cloned().collect();
    (!local.is_empty()).then(|| format!("source {source:?} uses local images ({}); a .json source can only show https: or data: images", local.join(", ")))
}
