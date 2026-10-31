# Harness

A macOS desktop app that hosts ACP Agents (Claude, Codex, OpenCode, …) behind one UI-agnostic core. The Rust core owns the shared Primitives: Sessions, Threads, the Session Log, Workspaces and git, permissions, Agent installs, and the Harness MCP. Frontends are TypeScript and render purely from the Session Log, so the same Session can be shown as a chat, an event inspector, or something else entirely.

Vocabulary: [GLOSSARY.md](GLOSSARY.md). Decisions: [docs/adr/](docs/adr/). Plan and status per milestone: [docs/plans/v1.md](docs/plans/v1.md). Acceptance checklist: [docs/plans/v1-acceptance.md](docs/plans/v1-acceptance.md).

## What it does

- **Agents from the ACP Registry.** Install, update and remove Agents on a Harness-managed toolchain: pinned Node and uv with sha256-checked downloads. Custom Agents (any command) work too. Sign-in flows (agent or terminal auth) surface in the chat.
- **Sessions with Workspaces.** Pick a folder, optionally a branch and a new Worktree (`harness/<slug>-<id>`). The Session tracks per-Turn file changes and has a diff panel with commit and push. Archiving a Worktree Session commits its WIP and removes the Worktree; deleting refuses unmerged work unless forced.
- **Durable Session Log.** Every Session is an append-only JSONL log. Any number of Views (windows) replay and follow it live and render identically. Agent processes stop when idle, resume after restarts and crashes, and continue with a summary when an Agent can't resume.
- **Permission Policy.** Rules by scope (global, Agent, Session), tool kind, and command prefix or path glob. "Always allow" becomes a Session rule. Plan approvals always ask.
- **Harness MCP.** Agents get the git Primitives and their Frontend's tools (e.g. `render_ui`) over a loopback MCP server with per-session tokens. Agents without HTTP MCP use a stdio shim (`harness mcp-shim`). Your own MCP servers live in the MCP Library, with secrets in the Keychain.
- **macOS niceties.** A dock badge and notifications when a Session needs you, and Sessions open in separate windows.

## Run

Requirements: macOS 13+, Rust (stable), [Bun](https://bun.sh), git. You don't need Node or Python; the Harness downloads its own.

```bash
bun install
bun run dev
```

The Vite dev server uses port 1420, or the next free one if that is taken (so several checkouts can run at once). It also runs in a plain browser (`bun run --cwd app dev`) with a mock transport (no core), which is handy for UI work.

First steps in the app: **Agents** → install Claude or Codex → **New Session** → pick a folder → chat. Sign in when the Agent asks.

## Layout

| Path | What |
|---|---|
| `crates/harness-core` | The core: Commands in, Events out (`src/api.rs`). No Tauri dependency. |
| `crates/harness-tauri` | Tauri adapter: IPC (`execute`, Session and app subscriptions), windows, badge and notifications, `mcp-shim` subcommand. |
| `crates/fake-agent` | Scripted ACP agent (and MCP client) for deterministic tests. |
| `packages/api` | `@harness/api`: generated types, transports (Tauri, mock), client. |
| `packages/ui` | `@harness/ui`: shared components (Tailwind v4, shadcn style). |
| `packages/frontend-chat`, `packages/frontend-inspector` | Frontends: a manifest plus a React module. They may import only `@harness/api` and `@harness/ui`. |
| `app` | The shell: sidebar, Composer, Agents, MCP and permission dialogs, View host. |

## Writing a Frontend

A Frontend is a package with a `manifest.json` (`id`, `name`, `version`, `frontend_tools`) and a React View that gets a `SessionApi`. It is a pure reducer over Events, so replay and live use the same code. Frontend Tools are declared in TS with [jsonv-ts](https://www.npmjs.com/package/jsonv-ts) and written into the manifest by `bun run gen-manifests`. The core validates every call against that JSON Schema before storing it in the Session's `frontend/` directory and emitting `FrontendToolOutput`. See `packages/frontend-chat/src/tools.ts`.

## Test

```bash
cargo test -p harness-core
bun run typecheck
bun run test
HARNESS_LIVE=1 cargo test -p harness-core --test live -- --test-threads=1
```

The first runs unit tests plus integration tests against the fake agent and temp git repos. The second runs TS types plus the import-boundary and manifest checks. The third runs live smoke tests against real Claude and Codex; it needs logins and spends tokens.

Headless runs against a real Agent:

```bash
SMOKE_INSTALL=1 cargo run -q -p harness-core --example smoke -- claude-acp <folder> "<prompt>"
```

## Release

```bash
bun run bundle
```

This builds `target/release/bundle/macos/Harness.app` and a `.dmg`. Signing and notarization are driven by environment variables, so no secrets live in the repo:

| Variable | Purpose |
|---|---|
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Name (TEAMID)`, from your keychain |
| `APPLE_ID`, `APPLE_PASSWORD` (app-specific password), `APPLE_TEAM_ID` | Notarization |

Without them the build is unsigned, which is fine locally: right-click → Open the first time. Hardened runtime is on. The app doesn't use the App Sandbox, because it spawns Agents, git and the toolchain.

## Data

Everything lives under `~/Library/Application Support/dev.dswbx.harness/`:

| Path | Contents |
|---|---|
| `sessions/<id>/` | `session.json`, `log.jsonl`, `frontend/` |
| `worktrees/<id>/` | Worktrees |
| `agents/`, `toolchain/` | Installed Agents and runtimes |
| `agents.json`, `permissions.json`, `mcp.json`, `registry-cache.json` | Agent records, Permission Policy rules, MCP Library, registry cache |

MCP Library secrets are in the Keychain under `dev.dswbx.harness.mcp`.
