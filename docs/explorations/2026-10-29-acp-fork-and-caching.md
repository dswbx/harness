# ACP fork and prompt caching

Date: 2026-10-29. Versions: `claude-agent-acp` 0.97.0, `codex-acp` 2.3.0, `agent-client-protocol-schema` 1.12.0.

Context: could a Side Thread (see [GLOSSARY.md](../../GLOSSARY.md)) start from a copy of the Main Thread's context, e.g. "select text, ask a question about it" without the question entering the main context?

## Observed

- ACP has `session/fork`: a new Agent Session from an existing one's context; the fork never writes back to the source. In the Rust schema it is behind the `unstable_session_fork` feature. Agents advertise it as `agentCapabilities.sessionCapabilities.fork`.
- `initialize` (empty client capabilities) on the installed Agents:
  - Claude Agent 0.97.0: `sessionCapabilities` = `additionalDirectories, close, delete, fork, list, resume, systemPrompt`.
  - Codex 2.3.0: `sessionCapabilities` = `resume, list, close, delete, fork, additionalDirectories, subagents, systemPrompt`.
- Claude adapter (`acp-agent.js`, `unstable_forkSession`): copies the transcript into a new session, then starts it like a resume (model and permission mode from the transcript; `cwd`, `mcpServers`, `systemPrompt` from the fork request).
- Harness today: Side Threads exist in core only (`StartSideThread{seed}`), each a fresh Agent Session seeded with text. No UI. ACP fork is not used.

## Assumed / unverified

- Other ACP Registry Agents (Gemini, Goose, Cursor, OpenCode, ...): unknown; needs install + `initialize`.
- Claude caching: prompt caching is prefix-based (system prompt, tools, messages must match byte for byte). A fork with the same model, tools and system prompt, within the cache TTL (5 min default, 1 h in some setups), should read the main context from cache on its first prompt.
- Things that likely break the Claude cache: different model, different MCP servers/tools, a `systemPrompt` on the fork request, environment info Claude Code rebuilds on start (e.g. git status snapshot) if it sits before the messages, TTL expiry. A miss re-writes the full context (cache write costs more than plain input).
- Codex caching: OpenAI caching is automatic and prefix-based. Codex likely sends a per-conversation cache key; a fork gets a new id and may miss even with the same prefix.
- Forks share the Workspace: file edits in a fork are visible to the Main Thread.

## Open questions

- Measure: fork a warm Claude and Codex session headless and compare cache-read vs input tokens on the fork's first prompt.
- Should Side Threads use `session/fork` when the Agent supports it, and fall back to a text seed otherwise?
- Which Registry Agents support fork?

## Observed 2026-10-31 (smoke `SMOKE_SIDE`, claude-agent-acp + codex-acp from the Registry)

- `session/fork` works on both: the forked Side Thread knew a word given only in the Main Thread. The fork answers with its own config options and mode (inherited from the source).
- Claude fork: about 25k tokens in context for a 1-Turn Main Thread, cost $0.07 for the first Side Thread prompt; cache read vs write not visible in ACP usage, still unmeasured.
- Codex in mode `agent` ("Auto review") ran `touch` without a permission request, so the Harness read-only check never saw it. Fix: read-only Side Threads switch to the Agent's asking mode (`agent_quirks::asking_mode`: Codex `read-only`, Claude `default`) before each prompt; then the write arrives as a permission request and is denied.
- Codex's only reject option is `cancel` ("No, and tell Codex what to do differently"): a denial ends its Turn (`stop_reason: cancelled`), in any Thread.
- Codex titles a Session from its first prompt, `<harness_context>` included (`SessionInfoUpdated`); not new, seen on the Main Thread too.
