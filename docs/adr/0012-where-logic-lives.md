# Where logic lives: core field, shared helper, or Frontend

Extends ADR 0002 (Shared Primitives in Rust) and ADR 0008 (strict ACP). Before adding logic that reads Events, ask: **would a second Frontend have to copy this to show the same truth?**

1. **Core: a field on the Event** (`crates/harness-core`, `api.rs`). When the logic needs knowledge only the core or an Agent has: Agent-specific signals (only in `agent_quirks.rs`, see ADR 0008), the core's own tools and Primitives, anything per Agent. Every Frontend then gets one correct value. Cost: the field is fixed when the Event is written, so older logs lack it.
2. **`@harness/api`: a shared helper** (`packages/api/src`). When it is a pure derivation from fields Events already carry and more than one Frontend could use it. The log stays raw; helpers also work on old logs.
3. **Frontend.** How to present: cards, grouping into rows, open/closed state, labels, layout.

If the answer to the question is no, it stays in the Frontend. If yes, use level 1 only when it needs core or Agent knowledge; otherwise level 2. Move a derivation to level 2 when a second Frontend needs it, not before.

Examples: which Harness MCP tool a call is → core (`harness_tool`); which subagent made a call → core (`parent_tool_call_id`, from `agent_quirks.rs`); grouping a subagent's calls and its state → `@harness/api` (`groupSubagents`); the Subagent card → Chat Frontend.
