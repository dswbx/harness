# Harness

Desktop host for ACP Agents with pluggable Frontends. Read first: [GLOSSARY.md](GLOSSARY.md) (use its terms exactly), [docs/adr/](docs/adr/), [docs/plans/v1.md](docs/plans/v1.md), [docs/spikes/](docs/spikes/). [docs/explorations/](docs/explorations/) holds dated notes from explorations: hints, not facts. Check them before you rely on them, and add a note there when you explore something (format in its README).

## Layout

- `crates/harness-core`: UI-agnostic Rust core (no Tauri dependency, ADR 0001). Commands in, Events out (`src/api.rs`).
- `crates/harness-tauri`: thin Tauri adapter: `execute`, `subscribe`/`unsubscribe` (Session Logs), `subscribe_app` (AppEvents), `terminal_attach`/`terminal_detach` (Terminal bytes, ADR 0017); dock badge + notifications for Sessions needing attention; `harness mcp-shim` subcommand.
- `crates/fake-agent`: scripted ACP agent for deterministic tests.
- `packages/api`: `@harness/api`; `src/generated.ts` is generated from Rust, never edit by hand.
- `packages/ui`, `packages/frontend-*`, `app/`: TS side. Frontends import only `@harness/api` and `@harness/ui`.
- `spikes/`: M0 throwaway code, kept for reference only.

## Rules

- Shared Primitives live in Rust; Frontend-specific logic lives in TS (ADR 0002).
- Views render only from the Session Log (ADR 0003). Frontend state is a pure reducer over Events.
- After changing `api.rs`, run `bun run gen-ts` (or `cargo run -q -p harness-core --bin gen-ts -- packages/api/src/generated.ts`).
- Agents come from the ACP Registry (`agents.rs`) on the pinned toolchain (`toolchain.rs`: Node, uv; bump pins with their sha256), or are Custom Agents. No built-in Agents, no system npx.
- Agents inherit a stripped env (`agent_quirks.rs` `stripped_env`: host `CLAUDE*` vars and `ANTHROPIC_BASE_URL`) plus the login-shell PATH.
- Agent-specific ACP handling lives only in `crates/harness-core/src/agent_quirks.rs`, only for vital fixes, mapped to generic Event fields (ADR 0008 addendum). Never in Frontends.
- Before adding logic that reads Events, ask: would a second Frontend have to copy this to show the same truth? Core Event field if it needs core/Agent knowledge, `@harness/api` helper if it is a pure derivation, else the Frontend (ADR 0012).
- UI components: default to shadcn (Radix) for anything shadcn has (select, menu, popover, dialog, tooltip, ...): add it to `@harness/ui` styled like the rest, never a native control or a hand-rolled one.
- Scrolling: every scrolling panel, list, popover and menu uses `ScrollArea` (or `VirtualList`) from `@harness/ui`, the thin scrollbar of the sidebar and chat; with a max height, put it on the root and pass `viewportClassName="max-h-[inherit]"`. Native `overflow-auto` only for code/pre blocks. Popovers and menus cap their height to the space left in the window (`--radix-*-content-available-height`).
- What the Agent should know about the Harness goes in the plain prompt files, not code: `crates/harness-core/prompts/harness.md` and each Frontend's `instructions.md` (ADR 0014). Keep them short.

## Commands

- `cargo test -p harness-core`: unit + fake-agent integration tests.
- `SMOKE_INSTALL=1 cargo run -q -p harness-core --example smoke -- codex-acp <folder> "<prompt>"`: install an Agent from the ACP Registry (managed toolchain) and run it headless. Drop `SMOKE_INSTALL` once installed in that data dir (`SMOKE_DATA`).
- `bun install && bun run dev`: run the app.
- Release: run the Release workflow (`gh workflow run release.yml`) from main. Tags `v{year}.{month}.{n}` on that commit, publishes a universal macOS build; installed apps self-update from it (`crates/harness-tauri/src/updates.rs`). Updater signing key: secret `TAURI_SIGNING_PRIVATE_KEY`.
