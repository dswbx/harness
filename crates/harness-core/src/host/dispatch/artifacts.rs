//! Commands: artifacts.

use crate::api::*;
use crate::host::Harness;

impl Harness {
    pub(in crate::host) async fn cmd_list_shared_artifacts(&self, query: Option<String>) -> anyhow::Result<CommandResult> {
        let shared = self.shared.clone();
        Ok(CommandResult::SharedArtifactList { artifacts: tokio::task::spawn_blocking(move || shared.artifacts.list(query.as_deref())).await? })
    }

    pub(in crate::host) async fn cmd_shared_artifact_read(&self, id: String) -> anyhow::Result<CommandResult> {
        let shared = self.shared.clone();
        let r = tokio::task::spawn_blocking(move || shared.artifacts.read(&id)).await??;
        Ok(CommandResult::SharedArtifact {
            meta: r.meta,
            content: r.content,
            hash: r.hash,
            mtime_ms: r.mtime_ms,
            state: r.state,
            dir: r.dir.display().to_string(),
        })
    }

    pub(in crate::host) async fn cmd_share_artifact(&self, session_id: SessionId, item_id: String) -> anyhow::Result<CommandResult> {
        let session = self.session(&session_id)?;
        let meta = tokio::task::spawn_blocking(move || session.share_item(&item_id, StateWriter::User)).await??;
        Ok(CommandResult::SharedArtifactInfo { meta })
    }

    pub(in crate::host) fn cmd_share_markdown(
        &self,
        session_id: SessionId,
        markdown: String,
        title: Option<String>,
        origin: Option<String>,
    ) -> anyhow::Result<CommandResult> {
        Ok(CommandResult::SharedArtifactInfo { meta: self.session(&session_id)?.share_markdown(&markdown, title.as_deref(), origin, StateWriter::User)? })
    }

    pub(in crate::host) fn cmd_attach_shared_artifact(&self, session_id: SessionId, id: String) -> anyhow::Result<CommandResult> {
        Ok(CommandResult::SharedArtifactInfo { meta: self.session(&session_id)?.attach_shared(&id, StateWriter::User)? })
    }

    pub(in crate::host) fn cmd_detach_shared_artifact(&self, session_id: SessionId, id: String) -> anyhow::Result<CommandResult> {
        self.session(&session_id)?.detach_shared(&id, StateWriter::User)?;
        Ok(CommandResult::Ok)
    }

    pub(in crate::host) fn cmd_rename_shared_artifact(&self, id: String, title: String, icon: Option<String>) -> anyhow::Result<CommandResult> {
        Ok(CommandResult::SharedArtifactInfo { meta: self.shared.artifacts.rename(&id, &title, icon.as_deref())? })
    }

    pub(in crate::host) async fn cmd_delete_shared_artifact(&self, id: String) -> anyhow::Result<CommandResult> {
        let shared = self.shared.clone();
        tokio::task::spawn_blocking(move || shared.artifacts.delete(&id)).await??;
        Ok(CommandResult::Ok)
    }

    pub(in crate::host) async fn cmd_open_shared_in_editor(&self, id: String) -> anyhow::Result<CommandResult> {
        let editor = crate::editor::load(&self.data_dir).ok_or_else(|| crate::error::invalid("choose an editor in Settings first"))?;
        let target = crate::editor::target(&editor, &self.shared.artifacts.content_path(&id)?, None);
        crate::editor::open(&target).await?;
        Ok(CommandResult::Ok)
    }

    pub(in crate::host) fn cmd_patch_artifact_state(&self, id: String, ops: Vec<StatePatchOp>, session_id: Option<SessionId>) -> anyhow::Result<CommandResult> {
        let state = match session_id {
            Some(sid) => self.session(&sid)?.patch_artifact_state(None, &id, ops, StateWriter::User)?,
            None => self.shared.artifacts.patch_state(&id, &ops)?,
        };
        Ok(CommandResult::State { state })
    }
}
