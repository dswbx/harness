# Side Threads fork the Main Thread and read transcripts through tools

The user wants to ask about the conversation (or a selected excerpt of it) without the question entering the Main Thread's context. Claude Code (`/btw`) and Codex (`/side`) both do this by forking the current context, read-only, never writing back ([exploration](../explorations/2026-10-29-side-threads-transcript-tools.md)).

**Start: fork when the Agent can, seed otherwise.** A Side Thread's Agent Session starts with ACP `session/fork` of the Main Thread's Agent Session when the Agent advertises `sessionCapabilities.fork` (Claude and Codex do), else as a new Agent Session with a text Context Seed (`summary.rs` transcript). Both carry the same Context Seed on top: the selected excerpt and where it sits (Turn, `seq`), if any. How the Thread started is logged (`Boundary::Forked` vs `Initial`) so Views can say so. A fork is a snapshot; it does not follow later Main Thread Turns.

**Transcript tools, in both modes.** The Harness MCP gets read-only tools over the Session Log: `transcript_outline`, `transcript_read`, `transcript_search`, addressed by Thread. They are how a seeded Side Thread sees the Main Thread, how a forked one sees Turns after its fork point, and how the Main Thread reads a Side Thread when the user asks. Scope: Threads of the same Session; other Sessions stay off until the policy in the exploration note is built. Results are marked as data (prompt injection).

**Read-only by default.** Forks share the Workspace. A Side Thread starts with a Permission Policy layer that denies edit, delete, move and execute kinds; the user can lift it per Side Thread. Agent-internal tools the Harness cannot mediate stay a known gap (ADR 0006).

**Nothing flows back on its own.** The Main Thread's context changes only through the user: "Send to main" puts a quote or the Side Thread's last reply into the Main Thread's composer; the user sends it. No Agent-initiated `post_to_main` for now.

**UI.** Side Threads are tabs in the right panel, beside Changes and `render_ui` right items (ADR 0015). Opened empty (button, shortcut), from a text selection ("Ask in side thread"), and later `/btw <text>`. Closing a tab hides the Side Thread; it stays in the Session Log and can be reopened.

**Kept open for Subsessions.** Later we may add Subsessions: child Sessions an orchestrator (or the user) starts for a piece of work, e.g. a canvas Frontend that always works through them. A Subsession differs from a Side Thread: it is its own Session (own Session Log, possibly own Frontend and Worktree), may write, and reports results back. A Side Thread stays a Thread: same Session, a detour, read-only by default. To not block Subsessions:
- How an Agent Session starts (fork of a Thread up to a `seq`, text seed, nothing) is one core type, not Side-Thread-specific, so Subsession creation reuses it.
- Transcript tools take a Thread reference that can name another Session, so cross-Session reads (parent reading a Subsession, the exploration's policy levels) are a scope change, not a new API.
- Right panel tabs host any View the Frontend chooses, not only Side Threads.

**Considered.** Fresh-only with transcript tools: works with every Agent and is cheap per question, but answers miss what the Agent read and decided, and users expect `/btw` to know the conversation. Fork-only: fails on Agents without fork. Hybrid costs one more start path.

**Risks.** A fork that misses the prompt cache re-writes the whole context (cost); measure before relying on it. Forking while a Main Thread Turn runs is untested.
