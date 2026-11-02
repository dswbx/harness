# Claude ACP: thinking text is omitted by default

2026-11-02. claude-agent-acp 0.99.0 (Claude Agent SDK, Opus 5.x models).

**Observed:**
- No thinking blocks showed for the Claude Agent. Of all local Session Logs, only one had `AgentThoughtChunk` events.
- `acp-agent.js` `resolveThinkingConfig` reads `CLAUDE_CODE_THINKING_DISPLAY` (`summarized` | `omitted`). Unset: SDK default. Its own comment: recent models default `thinking.display` to `omitted`, which streams thinking blocks with empty text; empty chunks are skipped.

**Assumed / unverified:**
- `agent_quirks::extra_env()` now sets `CLAUDE_CODE_THINKING_DISPLAY=summarized` (a Custom Agent's env overrides it). Not yet checked in a live Claude Session.
- The text is a summary, not the full reasoning.

**Open questions:**
- Does `summarized` add latency or cost?
