//! What the Agent can read about the UI: `harness_info`, `ui_get` and Shared Artifacts.

use serde_json::{Map, Value, json};

use super::frontend_tools::tree_error;
use crate::session::Session;

/// `ui_get`: the latest stored input of a live `render_ui` item, plus the Session State values at
/// the paths it binds (`$state`, `$bindState`, `${/path}` in `$template`; `$computed` args are
/// ordinary `$state` values).
pub(super) fn ui_get(session: &Session, id: Option<&str>) -> anyhow::Result<Value> {
    let id = id.ok_or_else(|| anyhow::anyhow!("id is required"))?;
    if let Some(shared) = crate::shared::reference(id) {
        session.ensure_attached(shared)?;
        return shared_get(session, shared);
    }
    let Some(item) = session.frontend_item(crate::session::RENDER_UI, id)? else {
        let items = session.frontend_items()?;
        let known: Vec<&str> = items.iter().filter(|x| x.tool == crate::session::RENDER_UI).map(|x| x.id.as_str()).collect();
        anyhow::bail!("no render_ui panel with id {id:?}. Known ids: {}", if known.is_empty() { "none".to_owned() } else { known.join(", ") });
    };
    let input = &item.input;
    let source = input.get("source").and_then(Value::as_str);
    if let Some(shared) = source.and_then(crate::shared::reference) {
        let mut out = json!({ "input": input });
        match shared_get(session, shared) {
            Ok(Value::Object(o)) => {
                if let Some(m) = out.as_object_mut() {
                    m.extend(o);
                }
            }
            Ok(_) => {}
            Err(e) => out["error"] = json!(format!("Shared artifact missing: {e:#}")),
        }
        return Ok(out);
    }
    let mut out = json!({ "input": input, "state": bound_values(&session.state()?, input) });
    if let Some(source) = source {
        match crate::panels::read(&session.panels_dir(), source) {
            Ok((content, _)) => out["content"] = json!(content),
            Err(e) => out["error"] = json!(format!("{e:#}")),
        }
    }
    Ok(out)
}

/// The values of `doc` at the paths `input` binds (null when missing).
fn bound_values(doc: &Value, input: &Value) -> Map<String, Value> {
    crate::state::bound_paths(input)
        .into_iter()
        .map(|p| {
            let v = doc.pointer(&p).cloned().unwrap_or(Value::Null);
            (p, v)
        })
        .collect()
}

/// `ui_get` for a Shared Artifact: its meta, folder, content (a tree as `input`) and state (for a
/// tree, the values at the paths it binds; else all of it).
fn shared_get(session: &Session, id: &str) -> anyhow::Result<Value> {
    let r = session.shared().artifacts.read(id)?;
    let mut out = shared_info(session, &r.meta);
    if r.meta.kind == crate::api::SharedKind::Ui {
        let ui: Value = serde_json::from_str(&r.content).map_err(|e| anyhow::anyhow!("ui.json of {id} is not JSON: {e}"))?;
        out["state"] = json!(bound_values(&r.state, &ui["root"]));
        out["tree"] = ui;
    } else {
        out["content"] = json!(r.content);
        out["state"] = r.state;
    }
    Ok(out)
}

/// What the Agent needs to find a Shared Artifact again: id, title, kind, folder and content file.
pub(super) fn shared_info(session: &Session, meta: &crate::api::SharedArtifactMeta) -> Value {
    let dir = session.shared().artifacts.folder(&meta.id).map(|d| d.display().to_string()).unwrap_or_default();
    json!({ "id": meta.id, "title": meta.title, "kind": meta.kind, "dir": dir, "file": crate::shared::content_name(meta.kind) })
}

/// `harness_info`: live Frontend items (calls with an `id`, with the errors the UI reported for
/// them, and a missing `source` file; `updated_ms`), the Session State's top-level keys, `panels_dir`,
/// the attached Shared Artifacts, this Session's Tasks and `note_path` (the Session Note).
pub(super) fn info(session: &Session) -> anyhow::Result<Value> {
    let errors = session.frontend_errors()?;
    let panels = session.panels_dir();
    let items: Vec<Value> = session
        .frontend_items()?
        .into_iter()
        .map(|item| {
            let (shown_title, shown_icon) = (item.title.clone(), item.icon.clone());
            let crate::session::FrontendItem { tool, id, input, ts_ms, .. } = item.as_ref();
            let (tool, id, ts_ms) = (tool.clone(), id.clone(), *ts_ms);
            let mut item = json!({ "tool": tool, "id": id });
            for k in ["placement", "title", "source"] {
                if let Some(v) = input.get(k) {
                    item[k] = v.clone();
                }
            }
            // The user's rename wins; the Agent sees what the user sees.
            if let Some(t) = shown_title {
                item["title"] = json!(t);
                item["agent_title"] = input.get("title").cloned().unwrap_or(Value::Null);
            }
            if let Some(i) = shown_icon {
                item["icon"] = json!(i);
            }
            let mut errs: Vec<String> = errors.iter().filter(|e| e.tool == tool && e.item == id).map(|e| e.message.clone()).collect();
            // When it last changed: its latest call, or for a file-backed panel a later file write.
            let mut updated = ts_ms;
            if let Some(source) = input.get("source").and_then(Value::as_str) {
                match crate::shared::reference(source) {
                    Some(sid) => match session.shared().artifacts.get(sid) {
                        Ok(m) => updated = updated.max(m.updated_ms),
                        Err(_) => errs.push(format!("Shared artifact missing: {sid}")),
                    },
                    None => match crate::panels::read(&panels, source) {
                        Ok((content, _)) => {
                            updated = updated.max(crate::panels::mtime_ms(&panels, source).unwrap_or(0));
                            errs.extend(tree_error(session, source, &content));
                        }
                        Err(e) => errs.push(format!("Source missing: {e:#}")),
                    },
                }
            }
            item["updated_ms"] = json!(updated);
            if !errs.is_empty() {
                item["errors"] = json!(errs);
            }
            item
        })
        .collect();
    let keys: Vec<String> = session.state()?.as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default();
    let shared: Vec<Value> = session
        .attached_shared()?
        .into_iter()
        .map(|id| match session.shared().artifacts.get(&id) {
            Ok(meta) => shared_info(session, &meta),
            Err(_) => json!({ "id": id, "errors": ["Shared artifact missing: it was deleted"] }),
        })
        .collect();
    Ok(json!({
        "items": items, "state_keys": keys, "panels_dir": panels.display().to_string(), "shared": shared,
        "tasks": super::task_tools::session_tasks(session), "note_path": session.note_path().display().to_string(),
    }))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "tests fail loudly")]
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn harness_info_shows_the_users_title_and_hides_deleted_panels() {
        let (s, _dir) = crate::session::projection_tests::session().await;
        crate::session::projection_tests::call(&s, "render_ui", "c1", json!({ "id": "a", "title": "Agent title", "root": {} }));
        crate::session::projection_tests::call(&s, "render_ui", "c2", json!({ "id": "b", "title": "Other", "root": {} }));
        s.edit_panel("a", Some("Mine".into()), None).unwrap();
        s.delete_panel("b").unwrap();
        let info = info(&s).unwrap();
        let items = info["items"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!((items[0]["id"].as_str(), items[0]["title"].as_str(), items[0]["agent_title"].as_str()), (Some("a"), Some("Mine"), Some("Agent title")));
    }
}
