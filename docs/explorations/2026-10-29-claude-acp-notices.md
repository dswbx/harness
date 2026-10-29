# Claude Agent: notices vs bold-label text

Date: 2026-10-29. Versions: `claude-agent-acp` 0.97.0, `agent-client-protocol-schema` 1.12.0.

Symptom: hook output (e.g. `UserPromptSubmit says: ...`) showed up as `**Notice:** ...` glued to the start of the Agent's reply.

## Observed

- The adapter (`session-notices.js`) sends `sessionUpdate: "notice"` (`severity`, `title`, optional `description`) only when the client advertises `clientCapabilities.session.notices = {}`.
- Without it, the adapter sends an `agent_message_chunk` with `**<title>:** <description>`, which merges into the reply text.
- Harness now advertises the capability (`acp.rs`, `initialize`) and maps `notice` to `EventKind::AgentNotice`. The chat renders it as a separate card. Older Session Logs still hold the glued text.

## Assumed / unverified

- ACP says notices are live events, not session history. Harness still logs them (Views render only from the Session Log). On `session/load` the Agent probably does not replay them.
- Other Agents may send notices too now that Harness advertises the capability; not checked.

## Open questions

- Which other Agents send `notice` updates, and what for?
