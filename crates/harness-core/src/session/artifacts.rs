//! Shared Artifacts of a Session (ADR 0024): attach, detach, share.

use std::path::{Path, PathBuf};

use super::Session;
use super::frontend::RENDER_UI;
use super::meta::title_from_text;
use crate::api::{EventKind, ThreadId};

impl Session {
    /// Shared Artifacts this Session has attached (from its log), in order of attaching.
    pub fn attached_shared(&self) -> anyhow::Result<Vec<String>> {
        self.log.attached_shared()
    }

    /// The folders of the attached Shared Artifacts that still exist.
    pub fn attached_shared_dirs(&self) -> Vec<PathBuf> {
        let ids = self.attached_shared().unwrap_or_default();
        ids.iter().filter(|id| self.shared.artifacts.get(id).is_ok()).filter_map(|id| self.shared.artifacts.folder(id).ok()).collect()
    }

    /// Errors unless the Shared Artifact exists and this Session has it attached.
    pub fn ensure_attached(&self, id: &str) -> anyhow::Result<crate::api::SharedArtifactMeta> {
        let meta = self.shared.artifacts.get(id)?;
        if !self.attached_shared()?.iter().any(|x| x == id) {
            return Err(crate::error::conflict(format!("shared artifact {id} is not attached to this Session: attach it first (artifact_attach)")));
        }
        Ok(meta)
    }

    /// Attaches a Shared Artifact (logs `ArtifactAttached`); does nothing when it is attached.
    pub fn attach_shared(&self, id: &str, by: crate::api::StateWriter) -> anyhow::Result<crate::api::SharedArtifactMeta> {
        let meta = self.shared.artifacts.get(id)?;
        if self.attached_shared()?.iter().any(|x| x == id) {
            return Ok(meta);
        }
        self.log.append(None, EventKind::ArtifactAttached { id: id.to_owned(), by })?;
        self.shared.artifacts.set_attached(id, &self.id(), true)?;
        self.shared.artifacts.get(id)
    }

    /// Detaches a Shared Artifact (logs `ArtifactDetached`); does nothing when it is not attached.
    /// Works for a deleted artifact too.
    pub fn detach_shared(&self, id: &str, by: crate::api::StateWriter) -> anyhow::Result<()> {
        if !self.attached_shared()?.iter().any(|x| x == id) {
            return Ok(());
        }
        self.log.append(None, EventKind::ArtifactDetached { id: id.to_owned(), by })?;
        if self.shared.artifacts.get(id).is_ok() {
            self.shared.artifacts.set_attached(id, &self.id(), false)?;
        }
        Ok(())
    }

    /// Changes an attached Shared Artifact's state and logs `ArtifactStateChanged` here (only here).
    pub fn patch_artifact_state(
        &self,
        thread: Option<ThreadId>,
        id: &str,
        ops: Vec<crate::api::StatePatchOp>,
        by: crate::api::StateWriter,
    ) -> anyhow::Result<serde_json::Value> {
        self.ensure_attached(id)?;
        let next = self.shared.artifacts.patch_state(id, &ops)?;
        self.log.append(thread, EventKind::ArtifactStateChanged { id: id.to_owned(), ops, by })?;
        Ok(next)
    }

    fn creator(&self) -> crate::api::SharedCreator {
        let m = self.meta();
        crate::api::SharedCreator { session_id: m.id, session_title: m.title, origin: None }
    }

    /// Makes the `render_ui` item `item_id` shared (ADR 0024): a file panel's file moves out of
    /// `panels/`; a tree becomes `ui.json` with its images and the state it binds (the whole Session
    /// State for an Html tree or file). Then the item shows `source: "shared:<id>"`, logged as a new
    /// call on the Thread of its latest one, and this Session is attached.
    pub fn share_item(&self, item_id: &str, by: crate::api::StateWriter) -> anyhow::Result<crate::api::SharedArtifactMeta> {
        use crate::api::SharedKind;
        let item = self.frontend_item(RENDER_UI, item_id)?.ok_or_else(|| crate::error::not_found(format!("no {RENDER_UI} item with id {item_id:?}")))?;
        let title = item.display_title().unwrap_or(item_id).to_owned();
        let icon = item.display_icon().map(str::to_owned);
        let artifacts = &self.shared.artifacts;
        let write_state = |dir: &Path, state: &serde_json::Value| -> anyhow::Result<()> {
            if state.as_object().is_some_and(|o| !o.is_empty()) {
                std::fs::write(dir.join("state.json"), serde_json::to_vec_pretty(state)?)?;
            }
            Ok(())
        };
        let meta = if let Some(source) = item.input.get("source").and_then(|v| v.as_str()) {
            if crate::shared::reference(source).is_some() {
                return Err(crate::error::conflict(format!("{item_id} is already shared ({source})")));
            }
            let file = crate::panels::source_path(&self.panels_dir(), source)?;
            if !file.is_file() {
                return Err(crate::error::not_found(format!("source {source:?} does not exist in panels_dir")));
            }
            let kind = if source.ends_with(".html") {
                SharedKind::Html
            } else if source.ends_with(".json") {
                SharedKind::Ui
            } else {
                SharedKind::Md
            };
            let state = match kind {
                SharedKind::Html => self.state()?,
                // A tree file is a `ui.json` already: it takes the state it binds, like a `root`.
                SharedKind::Ui => {
                    let ui: serde_json::Value =
                        serde_json::from_slice(&std::fs::read(&file)?).map_err(|e| crate::error::invalid(format!("source {source:?} is not JSON: {e}")))?;
                    let root = &ui["root"];
                    let doc = self.state()?;
                    if has_html(root) { doc } else { crate::state::subset(&doc, &crate::state::bound_paths(root))? }
                }
                SharedKind::Md => serde_json::json!({}),
            };
            artifacts.create(&title, icon.as_deref(), kind, self.creator(), vec![self.id()], |dir| {
                write_state(dir, &state)?;
                crate::shared::move_file(&file, &dir.join(crate::shared::content_name(kind)))
            })?
        } else if let Some(root) = item.input.get("root") {
            let doc = self.state()?;
            let state = if has_html(root) { doc } else { crate::state::subset(&doc, &crate::state::bound_paths(root))? };
            artifacts.create(&title, icon.as_deref(), SharedKind::Ui, self.creator(), vec![self.id()], |dir| {
                write_state(dir, &state)?;
                let mut files = std::collections::BTreeMap::new();
                for (src, rel) in &item.files {
                    let name = Path::new(rel).file_name().ok_or_else(|| anyhow::anyhow!("bad image path {rel}"))?;
                    let to = Path::new("files").join(name);
                    std::fs::create_dir_all(dir.join("files"))?;
                    std::fs::copy(self.frontend_path(rel)?, dir.join(&to))?;
                    files.insert(src.clone(), to.display().to_string());
                }
                let ui = serde_json::json!({ "root": root, "files": files });
                Ok(std::fs::write(dir.join(crate::shared::content_name(SharedKind::Ui)), serde_json::to_vec_pretty(&ui)?)?)
            })?
        } else {
            return Err(crate::error::invalid(format!("{item_id} has neither root nor source")));
        };
        let mut input = item.input.clone();
        if let Some(o) = input.as_object_mut() {
            o.remove("root");
            o.insert("source".into(), serde_json::json!(format!("{}{}", crate::shared::PREFIX, meta.id)));
        }
        let thread = item.thread.clone().unwrap_or_else(|| self.meta().main_thread_id);
        self.write_frontend_tool_output(&thread, RENDER_UI, input, Default::default())?;
        // The title and icon moved into the artifact: the per-Session override would only go stale.
        if item.title.is_some() || item.icon.is_some() {
            self.log.append(None, EventKind::PanelEdited { tool: RENDER_UI.to_owned(), id: item_id.to_owned(), title: None, icon: None })?;
        }
        self.log.append(None, EventKind::ArtifactAttached { id: meta.id.clone(), by })?;
        Ok(meta)
    }

    /// Shares a copy of Markdown (a block from a message) as a new `md` artifact and attaches it.
    pub fn share_markdown(
        &self,
        markdown: &str,
        title: Option<&str>,
        origin: Option<String>,
        by: crate::api::StateWriter,
    ) -> anyhow::Result<crate::api::SharedArtifactMeta> {
        if markdown.trim().is_empty() {
            return Err(crate::error::invalid("the Markdown is empty"));
        }
        let title = title.map(str::to_owned).filter(|t| !t.trim().is_empty()).unwrap_or_else(|| markdown_title(markdown));
        let kind = crate::api::SharedKind::Md;
        let text = markdown.to_owned();
        let meta = self.shared.artifacts.create(&title, None, kind, crate::api::SharedCreator { origin, ..self.creator() }, vec![self.id()], |dir| {
            Ok(std::fs::write(dir.join(crate::shared::content_name(kind)), text)?)
        })?;
        self.log.append(None, EventKind::ArtifactAttached { id: meta.id.clone(), by })?;
        Ok(meta)
    }
}

/// Whether a `render_ui` tree has an Html node, which can read any state path.
fn has_html(v: &serde_json::Value) -> bool {
    match v {
        serde_json::Value::Object(o) => o.get("type").and_then(|t| t.as_str()) == Some("Html") || o.values().any(has_html),
        serde_json::Value::Array(a) => a.iter().any(has_html),
        _ => false,
    }
}

/// A title for shared Markdown: its first line without Markdown marks, at most 40 characters.
fn markdown_title(markdown: &str) -> String {
    let line = markdown.lines().map(|l| l.trim_matches(|c: char| c == '#' || c == '`' || c == '|' || c.is_whitespace())).find(|l| !l.is_empty());
    match line {
        Some("mermaid") => "Diagram".to_owned(),
        Some(l) => title_from_text(l).unwrap_or_else(|| "Shared note".to_owned()),
        None => "Shared note".to_owned(),
    }
}
