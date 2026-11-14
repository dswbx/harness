//! Agents and their MCP server definitions.

use serde::{Deserialize, Serialize};
use specta::Type;

/// How to launch an Agent.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AgentInfo {
    pub id: String,
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub source: AgentSource,
    pub version: Option<String>,
    pub icon: Option<String>,
    /// Hash, previous version, hold and last check of an installed Agent (ADR 0007).
    #[serde(default)]
    pub install: InstallInfo,
}

/// What the Harness knows about an installed Agent's files.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct InstallInfo {
    /// sha256 of the downloaded artifact (binary installs); `None` for npx/uvx.
    #[serde(default)]
    pub sha256: Option<String>,
    /// The registry listed no sha256: installed on the user's say-so.
    #[serde(default)]
    pub unverified: bool,
    /// The version kept for rollback.
    #[serde(default)]
    pub previous: Option<PreviousInstall>,
    /// Not updated while held.
    #[serde(default)]
    pub held: bool,
    /// The last conformance check (of this version, or of an update that was refused).
    #[serde(default)]
    pub check: Option<ConformanceCheck>,
}

/// Launch spec of the version an Agent can roll back to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct PreviousInstall {
    pub version: String,
    pub command: String,
    pub args: Vec<String>,
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub unverified: bool,
}

/// Result of the headless conformance check of one Agent version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct ConformanceCheck {
    pub version: Option<String>,
    pub passed: bool,
    /// The Agent needs sign-in: spawn and protocol passed, `session/new` was not completed.
    pub auth_required: bool,
    /// Why it failed, with the stderr tail.
    pub error: Option<String>,
    #[specta(type = specta_typescript::Number)]
    pub at_ms: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentSource {
    Registry {
        registry_id: String,
    },
    #[default]
    Custom,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RegistryAgent {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub icon: Option<String>,
    pub website: Option<String>,
    /// `binary`, `npx` or `uvx`; `None` when nothing installs on this machine.
    pub install_method: Option<String>,
    pub installed_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AuthMethodInfo {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    /// `agent` (call Authenticate) or `terminal` (call OpenAuthTerminal).
    pub kind: String,
}

/// An MCP server in the MCP Library.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct McpServerDef {
    /// Stable id; empty on first save means "derive from name".
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub transport: McpTransport,
    /// Env vars (stdio) or headers (http) whose values live in the Keychain.
    #[serde(default)]
    pub secret_keys: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum McpTransport {
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: std::collections::BTreeMap<String, String>,
    },
    Http {
        url: String,
        #[serde(default)]
        headers: std::collections::BTreeMap<String, String>,
    },
}
