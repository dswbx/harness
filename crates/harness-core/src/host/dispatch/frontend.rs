//! Commands: frontend.

use crate::api::*;
use crate::host::Harness;

impl Harness {
    pub(in crate::host) fn cmd_list_frontends(&self) -> anyhow::Result<CommandResult> {
        Ok(CommandResult::Frontends { frontends: self.shared.frontends.read().clone() })
    }

    pub(in crate::host) fn cmd_frontend_read(&self, session_id: SessionId, path: String) -> anyhow::Result<CommandResult> {
        Ok(CommandResult::FileContent { content: self.session(&session_id)?.frontend_read(&path)? })
    }

    pub(in crate::host) async fn cmd_panel_source_read(&self, session_id: SessionId, name: String) -> anyhow::Result<CommandResult> {
        let session = self.session(&session_id)?;
        let (content, hash, mtime_ms, path) = tokio::task::spawn_blocking(move || {
            let (content, hash) = session.panel_source_read(&name)?;
            let dir = session.panels_dir();
            let path = crate::panels::source_path(&dir, &name)?.display().to_string();
            anyhow::Ok((content, hash, crate::panels::mtime_ms(&dir, &name).unwrap_or(0), path))
        })
        .await?
        .map_err(|e| crate::error::not_found(format!("{e:#}")))?;
        Ok(CommandResult::PanelSource { content, hash, mtime_ms, path })
    }

    pub(in crate::host) fn cmd_get_state(&self, session_id: SessionId) -> anyhow::Result<CommandResult> {
        Ok(CommandResult::State { state: self.session(&session_id)?.state()? })
    }

    pub(in crate::host) fn cmd_patch_state(&self, session_id: SessionId, ops: Vec<StatePatchOp>) -> anyhow::Result<CommandResult> {
        self.session(&session_id)?.patch_state(None, ops, crate::api::StateWriter::User)?;
        Ok(CommandResult::Ok)
    }

    pub(in crate::host) fn cmd_report_frontend_error(
        &self,
        session_id: SessionId,
        tool: String,
        item: String,
        message: String,
    ) -> anyhow::Result<CommandResult> {
        self.session(&session_id)?.report_frontend_error(&tool, &item, &message)?;
        Ok(CommandResult::Ok)
    }

    pub(in crate::host) fn cmd_answer_frontend_request(
        &self,
        session_id: SessionId,
        request_id: String,
        answer: FrontendAnswer,
    ) -> anyhow::Result<CommandResult> {
        self.session(&session_id)?.answer_frontend_request(&request_id, answer);
        Ok(CommandResult::Ok)
    }

    pub(in crate::host) fn cmd_frontend_read_image(&self, session_id: SessionId, path: String) -> anyhow::Result<CommandResult> {
        let (mime, data) = self.session(&session_id)?.frontend_read_image(&path)?;
        Ok(CommandResult::Attachment { mime, data })
    }

    pub(in crate::host) fn cmd_frontend_write(&self, session_id: SessionId, path: String, content: String) -> anyhow::Result<CommandResult> {
        self.session(&session_id)?.frontend_write(&path, &content)?;
        Ok(CommandResult::Ok)
    }

    pub(in crate::host) fn cmd_frontend_list(&self, session_id: SessionId, dir: String) -> anyhow::Result<CommandResult> {
        Ok(CommandResult::Files { files: self.session(&session_id)?.frontend_list(&dir)? })
    }
}
