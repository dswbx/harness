# Claude Agent: reply not streamed after tool calls

Date: 2026-10-29. Version: `claude-agent-acp` 0.97.0.

Symptom: in the chat, the Agent's text after tool calls appears all at once instead of streaming.

## Observed

- One Session log (a turn with 4 tool calls and 1 permission request): the last tool event was at seq 50. Then nothing for about 6.7 s. Then seq 51 was one `AgentMessageChunk` with 2069 characters, followed by two small chunks (14 and 13 characters) about 70 ms apart.
- Turns without tool calls in the same Session streamed in many small chunks, about 70 ms apart.
- The gap is in the Session Log (`ts_ms` is set when core receives the update), so it is before any Frontend.
- The chat reducer starts a new agent row after a tool card and appends each chunk; the View re-renders once per frame.

## Assumed / unverified

- Cause is on the Agent side. The adapter streams text from the Claude SDK's `stream_event` deltas. When no deltas arrive for a message, it sends the consolidated `assistant` message as one chunk. That matches a model writing for ~6 s, then the full text arriving at once.
- Why the SDK sent no deltas after the tool calls is unknown.

## Open questions

- Reproduce headless (smoke example) with a prompt that triggers tool calls and time the chunks.
- Does it happen on every turn with tools, or only after permission requests / MCP tools?
- If confirmed, report upstream to `claude-agent-acp`.
