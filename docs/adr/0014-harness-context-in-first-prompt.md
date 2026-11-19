# Harness context in the first prompt

The Agent needs to know about the Harness hosting it: its MCP tools, worktrees, the Frontend's tools (when to use `render_ui`), and facts about the Session. Tool descriptions only explain each tool on its own.

**Decision:** the core sends a `<harness_context>` text block before the user's text, on the first prompt of each Agent Session (a new Session, a new Thread, and after "continue with a summary"). Not on resume or load: the Agent already has it.

**Why the first prompt:** ACP has no standard system prompt field. Agent apps already send their instruction files as tagged blocks in user turns (Claude Code: CLAUDE.md in `<system-reminder>`; Codex: AGENTS.md in `<user_instructions>`), and models are trained to read them as context. MCP server `instructions` are not shown with the same weight by every Agent. Agent-specific system prompt fields would be Agent-specific code (ADR 0008).

**Tag name:** `<harness_context>`, not `<system_instructions>`. Models are trained to distrust text in a user turn that claims system authority (that is how prompt injection looks), so an honest name works better.

**Texts are plain files**, not code: `crates/harness-core/prompts/harness.md` (built in) and each Frontend's `instructions.md` (copied into its manifest by `gen-manifests`). `<data dir>/prompts/harness.md` and `<data dir>/prompts/<frontend id>.md` override them without a rebuild. The core adds Session facts (folder, repository, worktree and branch).

**Transparency:** `TurnStarted.context` records the exact block sent; the chat shows it on request ("Harness context" under the message).

**Known risk:** when an Agent compacts its context, it may summarize or drop the block, and ACP has no standard signal for compaction. Keep the texts short and important; add a reminder in a later Turn if Agents forget it.

## Addendum: Custom Instructions

The user can add their own text to the block: Global (every Session) and per repository, edited in Settings › Instructions. The core adds `## Your instructions for all Sessions` and `## Your instructions (<folder name>)` after the Frontend's part, before the Session facts; the two shapes differ so a folder named `global` stays apart. When the repository's part is sent, the facts add `- Instructions folder: <key>`, so the UI's edit link finds it from a linked worktree too. Like the rest of the block, edits apply from the next Agent Session (new Session or Thread).

**Storage:** `<data dir>/instructions/global.md` and `<data dir>/instructions/repos/<encoded folder>.md`. Nothing is written in the repository: the text is the user's, not the team's (that is what `AGENTS.md` is for). The file name is the folder's absolute path with `%`, `/`, `\` and `:` percent-encoded, so it is readable and the list gets the path back without an index file.

**Key:** the repository's main checkout folder. For a Worktree, the folder of its git common dir, read from the `.git` file without running git, so all Worktrees share one file. The git remote does not matter: a fork or a renamed remote keeps its text. A folder outside git is its own key; Quick Sessions get none. When a repository moves, Settings shows "folder not found" and can move its text to the new folder (`MoveInstructions`).

**Editor:** Settings uses the prompt box's Lexical editor, lent by the chat Frontend as `Frontend.MarkdownEditor` (like `Gallery`), since `app/` may not import Frontend internals. Without one, a plain text area.
