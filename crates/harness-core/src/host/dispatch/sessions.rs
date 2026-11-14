//! Commands: sessions.

use std::path::PathBuf;

use crate::api::*;
use crate::host::Harness;

impl Harness {
    pub(in crate::host) fn cmd_list_sessions(&self) -> anyhow::Result<CommandResult> {
        let mut sessions: Vec<SessionSummary> = self.sessions.read().values().map(|s| s.summary()).collect();
        sessions.sort_by_key(|s| std::cmp::Reverse(s.created_ms));
        self.refresh_pr_states();
        Ok(CommandResult::Sessions { sessions })
    }

    pub(in crate::host) async fn cmd_prompt(
        &self,
        session_id: SessionId,
        thread_id: Option<ThreadId>,
        text: String,
        attachments: Vec<AttachmentInput>,
    ) -> anyhow::Result<CommandResult> {
        self.session(&session_id)?.prompt(thread_id, text, attachments, None).await?;
        Ok(CommandResult::Ok)
    }

    pub(in crate::host) fn cmd_read_attachment(&self, session_id: SessionId, path: String) -> anyhow::Result<CommandResult> {
        let (mime, data) = self.session(&session_id)?.read_attachment(&path)?;
        Ok(CommandResult::Attachment { mime, data })
    }

    pub(in crate::host) fn cmd_read_image_file(&self, path: String) -> anyhow::Result<CommandResult> {
        let (mime, data) = crate::attachments::read_image(&path)?;
        Ok(CommandResult::Attachment { mime, data })
    }

    pub(in crate::host) async fn cmd_cancel(&self, session_id: SessionId, thread_id: Option<ThreadId>) -> anyhow::Result<CommandResult> {
        self.session(&session_id)?.cancel(thread_id).await?;
        Ok(CommandResult::Ok)
    }

    pub(in crate::host) fn cmd_warm_up(&self, session_id: SessionId) -> anyhow::Result<CommandResult> {
        self.session(&session_id)?.warm_up();
        Ok(CommandResult::Ok)
    }

    pub(in crate::host) async fn cmd_continue_with_summary(
        &self,
        session_id: SessionId,
        thread_id: Option<ThreadId>,
        text: Option<String>,
        attachments: Vec<AttachmentInput>,
    ) -> anyhow::Result<CommandResult> {
        self.session(&session_id)?.continue_with_summary(thread_id, text, attachments).await?;
        Ok(CommandResult::Ok)
    }

    pub(in crate::host) async fn cmd_start_side_thread(
        &self,
        session_id: SessionId,
        seed: Option<String>,
        source: ThreadStart,
        mode: Option<String>,
    ) -> anyhow::Result<CommandResult> {
        let session = self.session(&session_id)?;
        let (thread_id, forked) = session.start_side_thread(seed, source, mode)?;
        if forked {
            // Fork now, so the Side Thread sees the Main Thread as it was when opened.
            let thread = thread_id.clone();
            tokio::spawn(async move {
                if let Err(e) = crate::acp::warm_up(session, thread).await {
                    tracing::debug!("side thread warm-up: {e:#}");
                }
            });
        }
        Ok(CommandResult::ThreadStarted { thread_id, forked })
    }

    pub(in crate::host) async fn cmd_open_in_editor(&self, session_id: SessionId, path: Option<String>, line: Option<u32>) -> anyhow::Result<CommandResult> {
        let editor = crate::editor::load(&self.data_dir).ok_or_else(|| crate::error::invalid("choose an editor in Settings first"))?;
        let folder = PathBuf::from(self.session(&session_id)?.meta().folder);
        let file = crate::editor::resolve(&folder, path.as_deref())?;
        let target = crate::editor::target(&editor, &file, line);
        crate::editor::open(&target).await?;
        Ok(CommandResult::Ok)
    }

    pub(in crate::host) async fn cmd_export_plan(
        &self,
        session_id: SessionId,
        name: String,
        markdown: String,
        open_in_editor: bool,
    ) -> anyhow::Result<CommandResult> {
        let editor = if open_in_editor {
            Some(crate::editor::load(&self.data_dir).ok_or_else(|| crate::error::invalid("choose an editor in Settings first"))?)
        } else {
            None
        };
        let dir = self.session(&session_id)?.dir().to_path_buf();
        let file = tokio::task::spawn_blocking(move || crate::editor::export_plan(&dir, &name, &markdown)).await??;
        if let Some(editor) = editor {
            // The file was just written by Harness inside the Session's data dir, so `resolve` does not apply.
            let target = crate::editor::target(&editor, &file, None);
            crate::editor::open(&target).await?;
        }
        Ok(CommandResult::PlanFile { path: file.to_string_lossy().into_owned() })
    }

    pub(in crate::host) async fn cmd_list_session_files(&self, session_id: SessionId) -> anyhow::Result<CommandResult> {
        let folder = PathBuf::from(self.session(&session_id)?.meta().folder);
        let (files, prefix) = tokio::join!(crate::editor::list_files(&folder), crate::workspace::folder_prefix(&folder));
        Ok(CommandResult::SessionFiles { files: files?, prefix })
    }

    pub(in crate::host) async fn cmd_read_session_file(
        &self,
        session_id: SessionId,
        path: String,
        start: Option<u32>,
        end: Option<u32>,
    ) -> anyhow::Result<CommandResult> {
        let folder = PathBuf::from(self.session(&session_id)?.meta().folder);
        let (path, start, lines, total) = tokio::task::spawn_blocking(move || crate::editor::read_lines(&folder, &path, start, end)).await??;
        Ok(CommandResult::FileLines { path, start, lines, total })
    }

    // Sub Sessions follow their parent.
    pub(in crate::host) async fn cmd_archive_session(&self, session_id: SessionId) -> anyhow::Result<CommandResult> {
        let session = self.session(&session_id)?;
        for child in self.children(&session_id).into_iter().filter(|c| !c.meta().archived) {
            self.terminals.kill_all(&child.id());
            child.archive().await?;
        }
        self.terminals.kill_all(&session_id);
        session.archive().await?;
        Ok(CommandResult::Ok)
    }

    pub(in crate::host) async fn cmd_unarchive_session(&self, session_id: SessionId) -> anyhow::Result<CommandResult> {
        self.session(&session_id)?.unarchive().await?;
        for child in self.children(&session_id).into_iter().filter(|c| c.meta().archived) {
            child.unarchive().await?;
        }
        Ok(CommandResult::Ok)
    }

    pub(in crate::host) async fn cmd_delete_session(&self, session_id: SessionId, force: bool) -> anyhow::Result<CommandResult> {
        self.delete_session(&session_id, force).await?;
        Ok(CommandResult::Ok)
    }

    pub(in crate::host) async fn cmd_discard_empty_session(&self, session_id: SessionId) -> anyhow::Result<CommandResult> {
        let discardable = self.sessions.read().get(&session_id).is_some_and(|s| s.is_discardable());
        if discardable {
            self.delete_session(&session_id, false).await?;
        }
        Ok(CommandResult::Ok)
    }

    pub(in crate::host) fn cmd_resolve_permission(
        &self,
        session_id: SessionId,
        request_id: String,
        option_id: Option<String>,
        global: bool,
    ) -> anyhow::Result<CommandResult> {
        self.session(&session_id)?.resolve_permission(&request_id, option_id, global)?;
        Ok(CommandResult::Ok)
    }

    pub(in crate::host) async fn cmd_set_config_option(
        &self,
        session_id: SessionId,
        thread_id: Option<ThreadId>,
        config_id: String,
        value: String,
    ) -> anyhow::Result<CommandResult> {
        self.session(&session_id)?.set_config_option(thread_id, config_id, value).await?;
        Ok(CommandResult::Ok)
    }

    pub(in crate::host) async fn cmd_set_mode(&self, session_id: SessionId, thread_id: Option<ThreadId>, mode_id: String) -> anyhow::Result<CommandResult> {
        self.session(&session_id)?.set_mode(thread_id, mode_id).await?;
        Ok(CommandResult::Ok)
    }
}
