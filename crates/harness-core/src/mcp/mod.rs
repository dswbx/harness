//! Harness MCP (ADR 0011): an in-process MCP server on loopback HTTP that gives Agents the
//! Harness Primitives and their Session's Frontend Tools. Each Agent Session gets a bearer token
//! naming its Session and Thread; requests with an `Origin` header are refused. Agents without
//! HTTP MCP reach it through `run_shim` (stdio).

mod frontend_tools;
mod info;
pub(crate) mod results;
mod server;
mod shim;
mod tools;

pub(crate) use results::result_of;
pub use server::HarnessMcp;
pub use shim::run_shim;

use crate::session::Session;

/// The Harness MCP tool a tool call title names: `mcp__harness__git_status` (Claude) or
/// `mcp.harness.git_status` (Codex) -> `git_status`. Agents name MCP tools their own way; this
/// knows only how they name ours.
pub fn harness_tool_name(title: &str) -> Option<&str> {
    crate::agent_quirks::harness_tool_prefixes().iter().find_map(|p| title.strip_prefix(p)).filter(|n| !n.is_empty())
}

/// Whether `name` is a tool this Harness MCP serves for the Session: a Primitive or one of its
/// Frontend's Tools.
pub fn serves_tool(session: &Session, name: &str) -> bool {
    tools::primitives().iter().any(|p| p.name == name) || session.frontend_tools().iter().any(|t| t.name == name)
}

/// Whether an Agent's permission request for a tool call may skip the Permission Policy because the
/// Harness MCP checks it itself (`authorize`). The title is untrusted Agent text, so it is not
/// enough: the tool must really be served for the Session, and the call must look like a plain tool
/// call: no `command`, no paths, and a kind that is absent, `other` or `think`. Any other kind
/// (a plan approval, a read, an edit, ...) goes through the Policy.
pub fn trusted_harness_call(served: bool, facts: &crate::permissions::ToolFacts) -> bool {
    let plain = matches!(facts.kind.as_deref(), None | Some("other" | "think"));
    served && plain && facts.command.is_none() && facts.paths.is_empty()
}

#[cfg(test)]
mod harness_tool_tests {
    #[test]
    fn names_harness_tools_in_each_agent_format() {
        use super::harness_tool_name as n;
        assert_eq!(
            [n("mcp__harness__git_status"), n("mcp.harness.git_commit"), n("mcp__other__x"), n("mcp__harness__")],
            [Some("git_status"), Some("git_commit"), None, None]
        );
    }

    #[test]
    fn trust_needs_a_served_tool_and_a_plain_call() {
        use super::trusted_harness_call as t;
        use crate::permissions::ToolFacts;
        let facts = |kind: Option<&str>, command: Option<&str>, paths: &[&str]| ToolFacts {
            kind: kind.map(Into::into),
            command: command.map(Into::into),
            paths: paths.iter().map(Into::into).collect(),
        };
        for kind in [Some("other"), Some("think"), None] {
            assert!(t(true, &facts(kind, None, &[])), "{kind:?}");
            assert!(!t(false, &facts(kind, None, &[])), "{kind:?} unserved");
            assert!(!t(true, &facts(kind, Some("rm -rf ~"), &[])), "{kind:?} command");
            assert!(!t(true, &facts(kind, None, &["/etc/passwd"])), "{kind:?} paths");
        }
        for kind in ["execute", "edit", "delete", "move", "fetch", "read", "search", "switch_mode", "unknown"] {
            assert!(!t(true, &facts(Some(kind), None, &[])), "{kind}");
        }
        assert!(!t(true, &facts(Some("read"), None, &["/outside/secret"])));
    }
}
