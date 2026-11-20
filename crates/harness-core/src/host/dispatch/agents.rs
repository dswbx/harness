//! Commands: agents.

use crate::api::*;
use crate::host::Harness;

impl Harness {
    pub(in crate::host) fn cmd_list_agents(&self) -> anyhow::Result<CommandResult> {
        Ok(CommandResult::Agents { agents: self.shared.agents.list() })
    }

    pub(in crate::host) async fn cmd_list_registry(&self, refresh: bool) -> anyhow::Result<CommandResult> {
        Ok(CommandResult::Registry { agents: self.shared.agents.registry(refresh).await? })
    }

    pub(in crate::host) async fn cmd_install_agent(&self, registry_id: String, allow_unverified: bool) -> anyhow::Result<CommandResult> {
        Ok(CommandResult::AgentInstalled { agent: self.shared.agents.install(&registry_id, allow_unverified).await? })
    }

    pub(in crate::host) async fn cmd_rollback_agent(&self, agent_id: String) -> anyhow::Result<CommandResult> {
        Ok(CommandResult::AgentInstalled { agent: self.shared.agents.rollback(&agent_id).await? })
    }

    pub(in crate::host) fn cmd_hold_agent_version(&self, agent_id: String, hold: bool) -> anyhow::Result<CommandResult> {
        Ok(CommandResult::AgentInstalled { agent: self.shared.agents.hold(&agent_id, hold)? })
    }

    pub(in crate::host) fn cmd_add_custom_agent(
        &self,
        name: String,
        command: String,
        args: Vec<String>,
        env: std::collections::BTreeMap<String, String>,
    ) -> anyhow::Result<CommandResult> {
        Ok(CommandResult::AgentInstalled { agent: self.shared.agents.add_custom(name, command, args, env)? })
    }

    pub(in crate::host) fn cmd_remove_agent(&self, agent_id: String) -> anyhow::Result<CommandResult> {
        self.shared.agents.remove(&agent_id)?;
        Ok(CommandResult::Ok)
    }

    pub(in crate::host) async fn cmd_authenticate(&self, session_id: SessionId, method_id: String) -> anyhow::Result<CommandResult> {
        self.session(&session_id)?.authenticate(method_id).await?;
        Ok(CommandResult::Ok)
    }

    pub(in crate::host) async fn cmd_open_auth_terminal(&self, session_id: SessionId, method_id: String) -> anyhow::Result<CommandResult> {
        self.session(&session_id)?.open_auth_terminal(&method_id).await?;
        Ok(CommandResult::Ok)
    }

    pub(in crate::host) fn cmd_auth_in_terminal(&self, session_id: SessionId, thread_id: Option<ThreadId>, method_id: String) -> anyhow::Result<CommandResult> {
        let terminal_id = self.session(&session_id)?.auth_in_terminal(&self.terminals, &method_id, thread_id)?;
        Ok(CommandResult::TerminalOpened { terminal_id })
    }

    pub(in crate::host) async fn cmd_list_mcp_servers(&self) -> anyhow::Result<CommandResult> {
        // The lock can be held by a save writing `mcp.json`.
        Ok(CommandResult::McpServers { servers: self.shared.library_blocking(|lib| lib.list()).await? })
    }

    pub(in crate::host) async fn cmd_save_mcp_server(
        &self,
        server: McpServerDef,
        secrets: std::collections::BTreeMap<String, String>,
    ) -> anyhow::Result<CommandResult> {
        let server = self.shared.library_blocking(move |lib| lib.save(server, secrets)).await??;
        Ok(CommandResult::McpServerSaved { server })
    }

    pub(in crate::host) async fn cmd_remove_mcp_server(&self, server_id: String) -> anyhow::Result<CommandResult> {
        self.shared.library_blocking(move |lib| lib.remove(&server_id)).await??;
        Ok(CommandResult::Ok)
    }

    pub(in crate::host) fn cmd_list_permission_rules(&self) -> anyhow::Result<CommandResult> {
        Ok(CommandResult::PermissionRules { rules: self.shared.policy.list() })
    }

    pub(in crate::host) fn cmd_add_permission_rule(&self, rule: NewPermissionRule) -> anyhow::Result<CommandResult> {
        Ok(CommandResult::PermissionRuleAdded { rule: self.shared.policy.add(rule)? })
    }

    pub(in crate::host) fn cmd_remove_permission_rule(&self, rule_id: String) -> anyhow::Result<CommandResult> {
        self.shared.policy.remove(&rule_id)?;
        Ok(CommandResult::Ok)
    }
}
