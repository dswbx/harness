//! Commands: Tasks and the Session Note (ADR 0028).

use crate::api::*;
use crate::host::Harness;
use crate::tasks::{Actor, NewTask};

impl Harness {
    pub(in crate::host) fn cmd_list_tasks(&self) -> anyhow::Result<CommandResult> {
        Ok(CommandResult::Tasks { tasks: self.shared.tasks.list() })
    }

    pub(in crate::host) fn cmd_read_task(&self, id: String) -> anyhow::Result<CommandResult> {
        Ok(CommandResult::Task { task: self.shared.tasks.get(&id)? })
    }

    #[allow(clippy::too_many_arguments, reason = "one per Command field")]
    pub(in crate::host) fn cmd_create_task(
        &self,
        title: String,
        body: Option<String>,
        parent_id: Option<String>,
        session_id: Option<SessionId>,
        status: Option<TaskStatus>,
        priority: Option<TaskPriority>,
        due: Option<String>,
        upstream: Option<TaskUpstream>,
    ) -> anyhow::Result<CommandResult> {
        let origin = match session_id {
            Some(id) => Some((id.clone(), self.session(&id)?.meta().title)),
            None => None,
        };
        let actor = Actor { by: StateWriter::User, session_id: origin.as_ref().map(|(id, _)| id.clone()) };
        let new = NewTask { title, body: body.unwrap_or_default(), parent_id, status, priority, due, upstream, origin };
        Ok(CommandResult::Task { task: self.shared.tasks.create(new, &actor)? })
    }

    pub(in crate::host) fn cmd_update_task(&self, id: String, patch: TaskPatch, base_updated_ms: Option<i64>) -> anyhow::Result<CommandResult> {
        Ok(CommandResult::Task { task: self.shared.tasks.update(&id, patch, base_updated_ms, &Actor::user())? })
    }

    pub(in crate::host) fn cmd_move_task(&self, id: String, parent_id: Option<String>, before: Option<String>) -> anyhow::Result<CommandResult> {
        Ok(CommandResult::Task { task: self.shared.tasks.move_to(&id, parent_id.as_deref(), before.as_deref(), &Actor::user())? })
    }

    pub(in crate::host) fn cmd_delete_task(&self, id: String) -> anyhow::Result<CommandResult> {
        self.shared.tasks.delete(&id, &Actor::user())?;
        Ok(CommandResult::Ok)
    }

    pub(in crate::host) async fn cmd_add_task_assets(&self, id: String, files: Vec<AttachmentInput>) -> anyhow::Result<CommandResult> {
        let shared = self.shared.clone();
        let task = tokio::task::spawn_blocking(move || shared.tasks.add_assets(&id, files)).await??;
        Ok(CommandResult::Task { task })
    }

    pub(in crate::host) fn cmd_remove_task_asset(&self, id: String, name: String) -> anyhow::Result<CommandResult> {
        Ok(CommandResult::Task { task: self.shared.tasks.remove_asset(&id, &name)? })
    }

    pub(in crate::host) async fn cmd_read_task_asset(&self, id: String, name: String) -> anyhow::Result<CommandResult> {
        let shared = self.shared.clone();
        let (mime, data) = tokio::task::spawn_blocking(move || shared.tasks.read_asset(&id, &name)).await??;
        Ok(CommandResult::Attachment { mime, data })
    }

    pub(in crate::host) fn cmd_read_note(&self, session_id: SessionId) -> anyhow::Result<CommandResult> {
        Ok(CommandResult::Note { note: self.session(&session_id)?.read_note()? })
    }

    pub(in crate::host) fn cmd_write_note(&self, session_id: SessionId, content: String, base_hash: Option<String>) -> anyhow::Result<CommandResult> {
        Ok(CommandResult::Note { note: self.session(&session_id)?.write_note(&content, base_hash.as_deref())? })
    }

    pub(in crate::host) async fn cmd_add_note_images(&self, session_id: SessionId, files: Vec<AttachmentInput>) -> anyhow::Result<CommandResult> {
        let session = self.session(&session_id)?;
        let note = tokio::task::spawn_blocking(move || session.add_note_images(files)).await??;
        Ok(CommandResult::Note { note })
    }
}
