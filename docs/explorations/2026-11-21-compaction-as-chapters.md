# Compaction as chapters: load less of a long Session

2026-11-21. Code read at `5520411`. Two real Session Logs measured on disk. The app was not run and nothing was built for this idea.

The idea: a compaction is a border in the Session. The messages before it show as one collapsed block (a chapter). The View does not load their Events until the user expands the block. The Events that every View needs (for example the ones that make panels and Artifacts) still load.

**Observed:**

- A View subscribes from `seq` 0 each time it mounts (`packages/api/src/client/session/core.ts`, `subscribe`), and `ViewHost` mounts the View again for each Session switch (`key={sessionId}`).
- The core sends one Tauri Channel message per Event (`ViewSink::send` in `crates/harness-tauri/src/lib.rs`).
- Log sizes: 6,464 Events in 10 MB, and 15,590 Events in 30 MB. A switch to these Sessions took 1 to 2 seconds for the user.
- The first render waits until no Event came for 40ms, for at most 1 second (`REPLAY_WAIT_MS` in `packages/api/src/react/hooks.ts`). A log that needs longer shows in parts.
- The core keeps Projections in memory (`Projections` in `crates/harness-core/src/log.rs`) and builds them from the full log. `log.checkpoint.json` holds only the log length and the last `seq`.
- A search for "compact" in `crates/harness-core/src` found no Event type for a compaction (matches only in `mcp/tools.rs` and a prompt file).

**Assumed / unverified:**

- The reducer must fold Events in `seq` order, from the first one. So a View cannot show the newest part first and add older Events to the same state later. A partial load needs one of these: all "state Events" from before the border, or a stored state at the border.
- "State Events" are small and all needed (title, modes, plans, Task List, Thread list, panel and Artifact calls). "Transcript Events" (message text, tool output) are most of the bytes. The split was not measured.
- The core can pick the state Events by Event type, with no Frontend logic. Not checked against each Event type.
- Compaction helps only Sessions that were compacted. Turn borders are a more general place to cut. Compaction is then a display feature on top of partial loading, not the base design.
- A related design that came up: show a quick state first (state Events plus the newest Turns), fold the full log in the background into a second state, and swap when it reaches the head. This needs no chapter and no function that works on a partial history.

**Open questions:**

- Does the log record where the Agent compacted? If not, which Event can mark it (per Agent)?
- What share of a long log is transcript Events? Measure by Event type and bytes.
- Which functions need the full history (jump to an old row, the Artifacts list, the Subagents list, export, the Task List position in `items`)? Each one must use state Events or ask the core.
- When the user expands a chapter: fold again from `seq` 0 in the background and swap, or make the reducer accept older rows?
- Does a Side Thread get its own chapters?
