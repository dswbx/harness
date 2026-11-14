//! Commands: terminals.

use crate::api::*;
use crate::host::Harness;

impl Harness {
    pub(in crate::host) async fn cmd_list_terminals(&self, session_id: SessionId) -> anyhow::Result<CommandResult> {
        self.session(&session_id)?;
        let terminals = self.terminals.clone();
        // Naming the foreground process runs `ps`.
        let terminals = tokio::task::spawn_blocking(move || terminals.list(&session_id)).await?;
        Ok(CommandResult::Terminals { terminals })
    }

    pub(in crate::host) fn cmd_terminal_open(&self, session_id: SessionId) -> anyhow::Result<CommandResult> {
        self.session(&session_id)?;
        Ok(CommandResult::TerminalOpened { terminal_id: self.terminals.open(&session_id) })
    }

    pub(in crate::host) fn cmd_terminal_close(&self, session_id: SessionId, terminal_id: u32) -> anyhow::Result<CommandResult> {
        self.terminals.close(&session_id, terminal_id);
        Ok(CommandResult::Ok)
    }

    pub(in crate::host) fn cmd_terminal_input(&self, session_id: SessionId, terminal_id: u32, data: String) -> anyhow::Result<CommandResult> {
        self.terminals.input(&session_id, terminal_id, data.as_bytes())?;
        Ok(CommandResult::Ok)
    }

    pub(in crate::host) fn cmd_terminal_resize(&self, session_id: SessionId, terminal_id: u32, cols: u16, rows: u16) -> anyhow::Result<CommandResult> {
        self.terminals.resize(&session_id, terminal_id, cols, rows)?;
        Ok(CommandResult::Ok)
    }

    pub(in crate::host) fn cmd_terminal_ack(&self, session_id: SessionId, terminal_id: u32, bytes: u32) -> anyhow::Result<CommandResult> {
        self.terminals.ack(&session_id, terminal_id, bytes as usize);
        Ok(CommandResult::Ok)
    }

    pub(in crate::host) fn cmd_terminal_kill(&self, session_id: SessionId, terminal_id: u32) -> anyhow::Result<CommandResult> {
        self.terminals.kill(&session_id, terminal_id);
        Ok(CommandResult::Ok)
    }
}
