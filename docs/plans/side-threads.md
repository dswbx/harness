# Side Threads plan

**Directories:** `crates/harness-core` (api, session, acp, mcp, permissions, summary), `packages/api`, `packages/frontend-chat`, `docs/`. Design: [ADR 0018](../adr/0018-side-threads-fork-with-transcript-tools.md).

## Context

Core already has Side Threads (`StartSideThread{seed}`, `SessionMeta.side_threads`, `seeds`), each a fresh Agent Session on the Session's Agent connection; no UI, and the chat reducer drops non-main events (`reducer.ts:222`). The right panel is a single `panel` string (`View.tsx:393`) switching between Changes, Terminal and right `render_ui` slots. Selection handling exists (`SelectionComment.tsx`, `data-quotable`). Slash commands are only Agent autocomplete (`commands.ts`).

Subsessions (child Sessions, orchestrated, can write) may come later. Keep the start type, transcript tool addressing and panel tabs generic (ADR 0018), but build nothing for them now.

## 1. Core: how an Agent Session starts

- `api.rs`: `StartSideThread { session_id, seed: Option<String>, excerpt: Option<Excerpt>, source: ThreadStart }` where `ThreadStart = Fork | Seed` (default `Fork`, falls back to `Seed`). `Excerpt { text, thread_id, seq }`. Result `ThreadStarted { thread_id, forked: bool }`.
- Internal `AgentSessionStart = New | Fork { from: ThreadId, upto_seq } | Resume/Load` used by `ensure_agent_session`; `SessionMeta` stores the pending start per Thread (replaces bare `seeds`, migrate with `serde(default)`).
- `acp.rs`: enable `unstable_session_fork` on `agent-client-protocol`; on first prompt of a forked Thread send `session/fork` of the source's Agent Session (same `cwd`, `mcp_servers` with this Thread's MCP token, no `systemPrompt` to keep cache). Log `AgentSessionStarted { boundary: Forked }`. If the source has no live/resumable Agent Session or fork errors: seed with `summary.rs` transcript, log `Initial`.
- `harness_context`: forked Thread gets a short `<harness_context>` addendum ("You are in a Side Thread forked from the Main Thread at Turn N; read-only; transcript tools available"), not the full block again.
- Excerpt goes in front of the first prompt in both modes.
- `prompts/harness.md`: one line about Side Threads and transcript tools.
- Tests (`tests/fake_agent.rs`): fake-agent advertises fork; fork path, fallback path, excerpt in first prompt, Main Thread log untouched.

## 2. Core: transcript tools

- `summary.rs` → split rendering (Turn list with index, prompts, replies, tool titles, optional tool I/O) from the "continue with summary" wrapper.
- `mcp.rs` primitives, kind `read`:
  - `transcript_outline { thread? }`: Turns: index, short prompt, tool count, size.
  - `transcript_read { thread?, from, to, tools?: bool }`.
  - `transcript_search { thread?, query }` → Turn indexes + snippets.
  - `threads_list`: Threads of this Session (id, main/side, title from first prompt, Turn count).
- `thread` is a `ThreadRef { session_id?, thread_id? }` (default: Main Thread of own Session). Other `session_id` refused for now (Subsessions/policy later).
- Results wrapped as data (`<transcript>…</transcript>` + note that contents are untrusted).
- Tests: scoping, range bounds, search.

## 3. Core: read-only Side Threads

- `SessionMeta.thread_writes: HashSet<ThreadId>` (Threads allowed to write); Side Threads start without.
- `permissions.rs` `Context` gets `thread_writable`; `evaluate` denies `edit`, `delete`, `move`, `execute` (and harness `git_commit`/`git_push`) when false, before rules.
- Command `SetThreadWritable { session_id, thread_id, writable }` logged as an Event so Views show it.
- Tests: denied kinds, lifted after toggle.

## 4. `@harness/api`

- `bun run gen-ts`; `client.ts`: `startSideThread({ seed, excerpt, source })`, `prompt`/`cancel` with `thread_id`, `setThreadWritable`.
- Helper `threadsOf(events)` (Main + Side Threads with titles), pure derivation (ADR 0012).
- Mock: fork behaviour.

## 5. Chat Frontend

- **Reducer per Thread:** `reducer.ts` keeps state for every Thread (`threads: Record<ThreadId, ThreadState>`) instead of dropping non-main; Main View reads `threads[mainThreadId]`. Update `reducer.test.ts`.
- **Panel tabs:** replace `panel: string` with `{ tabs: PanelTab[], active }` where `PanelTab = changes | terminal | slot(id) | thread(id)`; persist in sessionStorage as now. Side Thread tabs closable (hide only); reopen from a "Side threads" menu listing `threadsOf`.
- **Side Thread view:** reuse message list + `PromptBox` with `thread_id`; header shows "forked at Turn N" or "fresh", read-only badge with toggle, "Send to main" (last reply or selection → Main composer as a quote chip, reusing `reviewComments` quote path).
- **Entry points:** toolbar button + shortcut (empty Side Thread); `SelectionComment` gets a second action "Ask in side thread" (excerpt = selection + `seq` from `data-quotable`); `/btw <text>` intercepted in `PromptBox` before send (later step, after the rest works).
- `instructions.md`: nothing unless the Agent needs it.

## 6. Verify

- `cargo test -p harness-core`.
- `bun run dev` with Claude and Codex: fork from selection, ask, check Main Thread Agent never sees it, Main reads the Side Thread via `transcript_read` when asked, writes denied then allowed.
- Measure cache: first prompt of a fork on a warm Claude and Codex Session, cache-read vs input tokens; note in `docs/explorations/2026-10-29-acp-fork-and-caching.md`.

## Order

1 → 2 → 3 (core, testable alone) → 4 → 5 → 6. `/btw` last.

## Unresolved questions

1. Fork mid-Turn of Main: allow (fork up to last finished Turn) or block until idle? Suggest: fork from last finished Turn; test adapters.
2. Default `ThreadStart`: Fork whenever possible, or user choice in UI? Suggest: Fork, with a hidden setting.
3. Side Thread Agent/model: inherit only, or pickable? Suggest: inherit (fork needs same Agent); model picker per Thread as today.
4. Read-only toggle: per Side Thread only, or global setting too? Suggest: per Thread now.
5. Include tool I/O in `transcript_read` by default? Suggest: no, opt-in flag.
6. Restore open Side Thread tabs after app restart? Suggest: yes (sessionStorage → localStorage per Session).

## Changed after review (2026-10-31)

- No excerpt in core: selected text goes into the Side Thread's prompt box as a quote chip.
- No read-only layer or toggle (section 3 dropped): a Side Thread starts in the Agent's asking mode, has its own mode picker, and follows the Main Thread's other config (model, effort). See ADR 0018.
- Prompt box folds its options into one dropdown when narrow.
