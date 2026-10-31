# Side Threads fork the Main Thread and read transcripts through tools

The user wants to ask about the conversation (or a selected excerpt of it) without the question entering the Main Thread's context. Claude Code (`/btw`) and Codex (`/side`) both do this by forking the current context, read-only, never writing back ([exploration](../explorations/2026-10-29-side-threads-transcript-tools.md)).

**Start: fork when the Agent can, seed otherwise.** A Side Thread's Agent Session starts with ACP `session/fork` of the Main Thread's Agent Session when the Agent advertises `sessionCapabilities.fork` (Claude and Codex do), else as a new Agent Session with a text Context Seed (`summary.rs` transcript). Text selected in the Main Thread is not a Context Seed: it goes into the Side Thread's prompt box as a quote, like any quote, so the user sees and can remove it. How the Thread started is logged (`Boundary::Forked` vs `Initial`) so Views can say so. A fork is a snapshot; it does not follow later Main Thread Turns.

**Transcript tools, in both modes.** The Harness MCP gets read-only tools over the Session Log: `transcript_outline`, `transcript_read`, `transcript_search`, addressed by Thread. They are how a seeded Side Thread sees the Main Thread, how a forked one sees Turns after its fork point, and how the Main Thread reads a Side Thread when the user asks. Scope: Threads of the same Session; other Sessions stay off until the policy in the exploration note is built. Results are marked as data (prompt injection).

**Writes ask by default.** Forks share the Workspace. A Side Thread starts in the Agent's mode that asks before writes (`agent_quirks::asking_mode`: Codex "Read-only", Claude "Manual"), since a fork inherits the Main Thread's mode, which may auto-approve (Codex "Auto review", Claude "Accept edits"); in those modes writes never reach the Permission Policy. Each write then shows a permission card, as in the Main Thread. The mode is shown in the corner of the Side Thread's prompt box and the user can change it. An earlier separate read-only layer (silent denial plus a toggle) was dropped: it could not hold in auto-approving modes, and two controls for one thing confused.

**Config follows the Main Thread, except the mode.** A Side Thread uses the Main Thread's current config option values (model, effort, ...): core applies them before each Side Thread prompt and refuses changes to them from a Side Thread, and Views hide those pickers. The mode is the Side Thread's own (above). A fork has to stay on the same Agent anyway, and one setting per Session is what the user expects.

**Nothing flows back on its own.** The Main Thread's context changes only through the user: "Send to main" puts a quote or the Side Thread's last reply into the Main Thread's composer; the user sends it. No Agent-initiated `post_to_main` for now.

**UI.** Side Threads are pill tabs in the right panel's side chat view, opened by one toolbar toggle; Changes, Terminal and `render_ui` right items (ADR 0015) are separate views of the same panel. Opened empty (button, shortcut), from a text selection ("Ask in side thread"), and later `/btw <text>`. Closing a tab hides the Side Thread; it stays in the Session Log and can be reopened.

**Kept open for Subsessions.** Later we may add Subsessions: child Sessions an orchestrator (or the user) starts for a piece of work, e.g. a canvas Frontend that always works through them. A Subsession differs from a Side Thread: it is its own Session (own Session Log, possibly own Frontend and Worktree), may write, and reports results back. A Side Thread stays a Thread: same Session, a detour, asking before writes by default. To not block Subsessions:
- How an Agent Session starts (fork of a Thread up to a `seq`, text seed, nothing) is one core type, not Side-Thread-specific, so Subsession creation reuses it.
- Transcript tools take a Thread reference that can name another Session, so cross-Session reads (parent reading a Subsession, the exploration's policy levels) are a scope change, not a new API.
- Right panel tabs host any View the Frontend chooses, not only Side Threads.

**Considered.** Fresh-only with transcript tools: works with every Agent and is cheap per question, but answers miss what the Agent read and decided, and users expect `/btw` to know the conversation. Fork-only: fails on Agents without fork. Hybrid costs one more start path.

**Risks.** A fork that misses the prompt cache re-writes the whole context (cost); measure before relying on it. Forking while a Main Thread Turn runs is untested.
