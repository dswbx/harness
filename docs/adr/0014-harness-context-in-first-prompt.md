# Harness context in the first prompt

The Agent needs to know about the Harness hosting it: its MCP tools, worktrees, the Frontend's tools (when to use `render_ui`), and facts about the Session. Tool descriptions only explain each tool on its own.

**Decision:** the core sends a `<harness_context>` text block before the user's text, on the first prompt of each Agent Session (a new Session, a new Thread, and after "continue with a summary"). Not on resume or load: the Agent already has it.

**Why the first prompt:** ACP has no standard system prompt field. Agent apps already send their instruction files as tagged blocks in user turns (Claude Code: CLAUDE.md in `<system-reminder>`; Codex: AGENTS.md in `<user_instructions>`), and models are trained to read them as context. MCP server `instructions` are not shown with the same weight by every Agent. Agent-specific system prompt fields would be Agent-specific code (ADR 0008).

**Tag name:** `<harness_context>`, not `<system_instructions>`. Models are trained to distrust text in a user turn that claims system authority (that is how prompt injection looks), so an honest name works better.

**Texts are plain files**, not code: `crates/harness-core/prompts/harness.md` (built in) and each Frontend's `instructions.md` (copied into its manifest by `gen-manifests`). `<data dir>/prompts/harness.md` and `<data dir>/prompts/<frontend id>.md` override them without a rebuild. The core adds Session facts (folder, repository, worktree and branch).

**Transparency:** `TurnStarted.context` records the exact block sent; the chat shows it on request ("Harness context" under the message).

**Known risk:** when an Agent compacts its context, it may summarize or drop the block, and ACP has no standard signal for compaction. Keep the texts short and important; add a reminder in a later Turn if Agents forget it.
