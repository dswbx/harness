//! Permission Policy rule types.

use serde::{Deserialize, Serialize};
use specta::Type;

use super::*;

/// A Permission Policy rule. The narrowest matching scope wins, then the more specific rule
/// (kind + pattern), then the stricter decision.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct PermissionRule {
    pub id: String,
    pub scope: RuleScope,
    /// ACP tool kind (read, edit, delete, move, search, execute, fetch, other); `None` = any.
    pub tool_kind: Option<String>,
    /// Command prefix for `execute`, otherwise a path glob (relative to the Workspace Folder).
    pub pattern: Option<String>,
    pub decision: Decision,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct NewPermissionRule {
    pub scope: RuleScope,
    pub tool_kind: Option<String>,
    pub pattern: Option<String>,
    pub decision: Decision,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RuleScope {
    Global,
    Agent { agent_id: String },
    Session { session_id: SessionId },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    Allow,
    Ask,
    Deny,
}
