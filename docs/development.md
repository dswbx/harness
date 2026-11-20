# Development

Terms: [GLOSSARY.md](../GLOSSARY.md). Decisions: [adr/](adr/). Plan and status per milestone: [plans/v1.md](plans/v1.md). Acceptance checklist: [plans/v1-acceptance.md](plans/v1-acceptance.md). Rules for contributors and Agents: [AGENTS.md](../AGENTS.md).

## Run

Requirements: macOS 13+, Rust (stable), [Bun](https://bun.sh), git. You do not need Node or Python: the Harness downloads its own.

```bash
bun install
bun run dev
```

The Vite dev server uses port 1420. When that port is in use, it takes the next free one, so several checkouts can run at the same time. The app also runs in a plain browser (`bun run --cwd app dev`) with a mock transport and no core. Use this for UI work.

First steps in the app: **Agents** → install Claude or Codex → **New Session** → pick a folder → chat. Sign in when the Agent asks.

## Layout

| Path                                                    | What                                                                                                                                                 |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crates/harness-core`                                   | The core: Commands in, Events out (`src/api/`). No Tauri dependency.                                                                                 |
| `crates/harness-tauri`                                  | Tauri adapter: IPC (`execute`, Session and app subscriptions), windows, badge and notifications, `mcp-shim` subcommand.                              |
| `crates/fake-agent`                                     | Scripted ACP agent (and MCP client) for deterministic tests.                                                                                         |
| `packages/api`                                          | `@harness/api`: generated types, transports (Tauri, mock), client.                                                                                   |
| `packages/ui`                                           | `@harness/ui`: shared components (Tailwind v4, shadcn style).                                                                                        |
| `packages/frontend-chat`, `packages/frontend-inspector` | Frontends: a manifest plus a React module. They import only their own files, `@harness/api`, `@harness/ui`, `react` and their declared dependencies. |
| `app`                                                   | The shell: sidebar, Composer, Agents, MCP and permission dialogs, View host.                                                                         |

## Writing a Frontend

A Frontend is a package with a `manifest.json` (`id`, `name`, `version`, `frontend_tools`) and a React View that gets a `SessionApi`. It is a pure reducer over Events, so replay and live use run the same code.

Declare Frontend Tools in TypeScript with [jsonv-ts](https://www.npmjs.com/package/jsonv-ts). `bun run gen-manifests` writes them into the manifest. The core checks every call against that JSON Schema. Then it stores the call in the Session's `frontend/` folder and emits `FrontendToolOutput`. Example: `packages/frontend-chat/src/features/renderUi/tools.ts`.

## Test

```bash
cargo test -p harness-core
bun run typecheck
bun run test
HARNESS_LIVE=1 cargo test -p harness-core --test live -- --test-threads=1
```

- `cargo test -p harness-core`: unit tests, plus integration tests against the fake agent and temporary git repositories.
- `bun run typecheck`: TypeScript types, plus the import-boundary and manifest checks.
- `bun run test`: vitest tests, then the timing benches.
- `HARNESS_LIVE=1 ...`: live smoke tests against real Claude and Codex. They need sign-ins and use tokens.

Headless run against a real Agent:

```bash
SMOKE_INSTALL=1 cargo run -q -p harness-core --example smoke -- claude-acp <folder> "<prompt>"
```

## README screenshots

```bash
bunx playwright install webkit
bun run screenshots
```

The first command is needed once per machine. The second builds the app in mock mode, drives it with Playwright (WebKit, the same engine as the app on macOS), and writes `docs/images/readme/<name>-dark.png` and `docs/images/readme/<name>-light.png`. The clock is frozen, so two runs give the same images. The shots are defined in `screenshots/shots.ts`, one entry per shot. The macOS window frame is drawn by `screenshots/frame.ts`.

Some shots use magic prompts of the browser mock: `/quiz`, `/artifacts`, `/prs`, `/permission` and `/card`. A magic prompt makes the mock Agent reply with fixed content. `packages/api/src/mock/index.ts` lists all magic prompts.

## Release

Published releases come from the Release workflow. Run it from main (`gh workflow run release.yml`). It tags `v{year}.{month}.{n}` on that commit and publishes a universal macOS build. The build is ad-hoc signed and not notarized. Installed apps offer the new release as an opt-in update (`crates/harness-tauri/src/updates.rs`). The secret `TAURI_SIGNING_PRIVATE_KEY` signs the updater files.

To build locally:

```bash
bun run bundle
```

This builds `target/release/bundle/macos/Harness.app` and a `.dmg`. Environment variables control signing and notarization, so the repository holds no secrets:

| Variable                                                              | Purpose                                                                   |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `APPLE_SIGNING_IDENTITY`                                              | For example `Developer ID Application: Name (TEAMID)`, from your keychain |
| `APPLE_ID`, `APPLE_PASSWORD` (app-specific password), `APPLE_TEAM_ID` | Notarization                                                              |

Without them the build is unsigned. This is fine for local use: macOS blocks the first open, and you allow it in **System Settings → Privacy & Security**. Hardened runtime is on. The app does not use the App Sandbox, because it starts Agents, git and the toolchain.

## Data

All data is in `~/.harness/`. Dev builds use `~/.harness-dev/`. `HARNESS_HOME` overrides both. `bun run dev:copy-data` replaces the dev data with a copy of the real data (without Worktrees).

| Path                                                                 | Contents                                                            |
| -------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `sessions/<id>/`                                                     | `session.json`, `log.jsonl`, `frontend/`                            |
| `worktrees/<id>/`                                                    | Worktrees                                                           |
| `agents/`, `toolchain/`                                              | Installed Agents and runtimes                                       |
| `agents.json`, `permissions.json`, `mcp.json`, `registry-cache.json` | Agent records, Permission Policy rules, MCP Library, registry cache |

MCP Library secrets are in the Keychain under `dev.dswbx.harness.mcp`.
