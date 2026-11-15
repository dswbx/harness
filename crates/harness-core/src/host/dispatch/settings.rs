//! Commands: settings.

use crate::api::*;
use crate::host::Harness;

impl Harness {
    pub(in crate::host) fn cmd_get_app_setting(&self, key: AppSettingKey) -> anyhow::Result<CommandResult> {
        Ok(CommandResult::Json { value: crate::app_settings::load(&self.data_dir, key) })
    }

    pub(in crate::host) fn cmd_set_app_setting(&self, key: AppSettingKey, value: Option<Json>) -> anyhow::Result<CommandResult> {
        crate::app_settings::save(&self.data_dir, key, value.as_ref())?;
        Ok(CommandResult::Ok)
    }

    pub(in crate::host) async fn cmd_fetch_json(&self, url: String) -> anyhow::Result<CommandResult> {
        Ok(CommandResult::Json { value: Some(crate::app_settings::fetch_json(&url).await?) })
    }

    pub(in crate::host) fn cmd_get_worktree_dir(&self) -> anyhow::Result<CommandResult> {
        Ok(CommandResult::WorktreeDir { dir: crate::git::worktree_dir(&self.data_dir) })
    }

    pub(in crate::host) fn cmd_set_worktree_dir(&self, dir: Option<String>) -> anyhow::Result<CommandResult> {
        crate::git::set_worktree_dir(&self.data_dir, dir.as_deref())?;
        Ok(CommandResult::Ok)
    }

    pub(in crate::host) fn cmd_get_editor(&self) -> anyhow::Result<CommandResult> {
        Ok(CommandResult::Editor { editor: crate::editor::load(&self.data_dir) })
    }

    pub(in crate::host) fn cmd_set_editor(&self, editor: Option<Editor>) -> anyhow::Result<CommandResult> {
        crate::editor::save(&self.data_dir, editor.as_ref())?;
        Ok(CommandResult::Ok)
    }
}
