# Harness

Desktop host for ACP Agents with pluggable Frontends. Read first: [GLOSSARY.md](GLOSSARY.md) (use its terms exactly), [docs/adr/](docs/adr/), [docs/plans/v1.md](docs/plans/v1.md), [docs/spikes/](docs/spikes/). [docs/explorations/](docs/explorations/) holds dated notes from explorations: hints, not facts. Check them before you rely on them, and add a note there when you explore something (format in its README).

## Layout

- `crates/harness-core`: UI-agnostic Rust core (no Tauri dependency, ADR 0001). Commands in, Events out (`src/api/`). Modules by area: `host/` (the `Harness`, Command dispatch), `session/` (one Session, its meta, Workspace and artifacts), `acp/` (Agent process, restore, permission, normalize), `git/`, `github/`, `mcp/` (Harness MCP: Primitives, Frontend Tools, shim), `log.rs` (Session Log), `sub_sessions.rs` (ADR 0026).
- `crates/harness-tauri`: thin Tauri adapter: `execute`, `read_log_page` and `subscribe`/`unsubscribe` (Session Logs, ADR 0029), `subscribe_app` (AppEvents), `terminal_attach`/`terminal_detach` (Terminal bytes, ADR 0017), `save_file` (save dialog, then writes the file); `subscriptions.rs` (what each webview subscribed to, dropped with it); `links.rs` (outside links open in the default browser); `updates.rs`; `harness-frame` scheme (Html frames, ADR 0013); dock badge + notifications for Sessions needing attention; the Quick Overlay window and its global shortcut (`overlay/`, ADR 0022) and its Window Context (`context.rs`); `host_types.rs` (IPC types, generated into `app/src/platform/generated.ts`); `harness mcp-shim` subcommand.
- `crates/fake-agent`: scripted ACP agent for deterministic tests.
- `packages/api`: `@harness/api`; `src/generated.ts` is generated from Rust, never edit by hand. Folders: `transport/`, `client/`, `contract/` (the Frontend contract), `platform/` (storage, files, window), `react/`, `derive/` (pure derivations over Events), `github/`, `mock/` (browser mock). `@harness/api/mock` is the mock and `@harness/api/testing` shared test cases, both for tests and the browser mock only.
- `packages/ui` (`@harness/ui`), `packages/frontend-chat` (`shell/` the chat arrangement, `state/` reducer slices, `panels/` the Panel contract, `features/*`, `lib/`), `packages/frontend-inspector`, `app/` (feature folders under `app/src`): TS side.
- `spikes/`: M0 throwaway code, kept for reference only.

## Rules

- Import boundaries are enforced by `scripts/boundaries.ts` (run by `bun run typecheck`): a Frontend imports only its own files, `@harness/api`, `@harness/ui`, `react` and its declared dependencies; `@harness/ui` imports no `@harness/api` and no Frontend; the `@harness/api` entry does not import the mock; `app/` takes only the `frontend` object from a Frontend's root entry; in `frontend-chat`, `features/`, `state/`, `panels/` and `lib/` never import `shell/`, and `state/`, `panels/` and `lib/` do not import `features/`; Frontends read no raw payloads (`rawInput`, `raw_output`, ...) and name no Agent; web storage goes through `storedValue` and the key registry in `@harness/api`, never `localStorage` directly.
- Fixtures, mock data, tests and docs use made-up data only. Never copy content from real Sessions (Session Logs, panel files, prompts, titles, paths, repo, issue or tool names) into the repo; replay a real log locally with `?replay=<id>` instead.
- Updates must be compatible: the app is published, and no user may lose data because of an update. Data an older build wrote (Session Logs, checkpoints, `session.json`, panel files, config files, web storage) must still load in the new build. When a stored format changes, read the old format too or migrate it, and keep the old data until the new write is done. Never delete or rewrite stored data in a way that drops information. Add a test that loads data in the old format.
- Shared Primitives live in Rust; Frontend-specific logic lives in TS (ADR 0002).
- Views render only from the Session Log (ADR 0003). Frontend state is a pure reducer over Events.
- After changing `api/`, run `bun run gen-ts` (or `cargo run -q -p harness-core --bin gen-ts -- packages/api/src/generated.ts`).
- Agents come from the ACP Registry (`agents.rs`) on the pinned toolchain (`toolchain.rs`: Node, uv; bump pins with their sha256), or are Custom Agents. No built-in Agents, no system npx.
- `Session::stop_processes` (delete, archive) stops a Session's Agent process and job watchers. `Harness::shutdown` (app quit; the Tauri adapter calls it on `ExitRequested`/`Exit`) does that for every Session and also kills Terminals, stops the Harness MCP and flushes Session Logs. It does not cover PR watches or panel watchers. A new per-Session background process belongs in both.
- Agents inherit a stripped env (`agent_quirks.rs` `stripped_env`: host `CLAUDE*` vars and `ANTHROPIC_BASE_URL`) plus the login-shell PATH.
- Agent-specific ACP handling lives only in `crates/harness-core/src/agent_quirks.rs`, only for vital fixes, mapped to generic Event fields (ADR 0008 addendum). Never in Frontends.
- Before adding logic that reads Events, ask: would a second Frontend have to copy this to show the same truth? Core Event field if it needs core/Agent knowledge, `@harness/api` helper if it is a pure derivation, else the Frontend (ADR 0012).
- UI components: default to shadcn (Radix) for anything shadcn has (select, menu, popover, dialog, tooltip, ...): add it to `@harness/ui` (`packages/ui/src/primitives`) styled like the rest, never a native control or a hand-rolled one.
- Scrolling: every scrolling panel, list, popover and menu uses `ScrollArea` (or `VirtualList`) from `@harness/ui`, the thin scrollbar of the sidebar and chat; with a max height, put it on the root and pass `viewportClassName="max-h-[inherit]"`. Native `overflow-auto` only for code/pre blocks. Popovers and menus cap their height to the space left in the window (`--radix-*-content-available-height`).
- Adding a chat Panel: one `definePanel` in `packages/frontend-chat/src/features/<f>/panel.tsx`, listed in `shell/panels.ts` (ADR 0025). Its id is persisted in stored layouts: never rename it (a test pins them).
- What the Agent should know about the Harness goes in the plain prompt files, not code: `crates/harness-core/prompts/harness.md` and each Frontend's `instructions.md` (ADR 0014). Keep them short.

## Preview

- "Preview" means: start the browser mock app (fake backend, fixture Sessions) and show it in the built-in browser pane, so the user can look at a change before they run the real app. Use `preview_start` with `app-alt-port` (port 1431, from `.claude/launch.json`). Do not use `app` (port 1420): the user's own `bun run dev` uses that port.
- After a UI change, open a preview without being asked: go to the changed screen, check the console for errors, and leave the page open for the user.
- The mock has no real git, files or Agent. Backend behavior still needs tests or the real app.
- Profiling: `?replay=<session id>&speed=20` streams a real Session Log (and its panel files) from `~/.harness` into a mock Session; `/stress` in a mock prompt streams a long Turn with 8 subagents; `?scan` loads react-scan. `app-prod-mock` (port 1433) serves a production build of the mock with the same tools.

## Commands

- `cargo test -p harness-core`: unit + fake-agent integration tests.
- `bun run check:rust`: `cargo fmt --check`, clippy with `-D warnings`, workspace tests (what CI runs). `bun run check:generated`: `gen-ts` then fails if generated files (`generated.ts`, host types, manifests) differ from the committed ones.
- `bun run typecheck`: every package, `scripts/`, and the import boundaries and manifest check. `bun run test`: vitest `node` and `dom` projects, then the timing benches in a separate `bench` project, run one file at a time. `bun run dead-code`: knip.
- `SMOKE_INSTALL=1 cargo run -q -p harness-core --example smoke -- codex-acp <folder> "<prompt>"`: install an Agent from the ACP Registry (managed toolchain) and run it headless. Drop `SMOKE_INSTALL` once installed in that data dir (`SMOKE_DATA`).
- `bun install && bun run dev`: run the app. `bun install` also installs the lefthook pre-commit hook (Biome format + lint on staged files).
- `bun run lint` / `bun run format`: Biome check / fix (3-space indent, width 100, `biome.json`).
- Release: run the Release workflow (`gh workflow run release.yml`) from main. Tags `v{year}.{month}.{n}` on that commit, publishes a universal macOS build; installed apps offer it as an opt-in update (`crates/harness-tauri/src/updates.rs`; `?update=<state>` previews the footer in the browser mock). Updater signing key: secret `TAURI_SIGNING_PRIVATE_KEY`.
