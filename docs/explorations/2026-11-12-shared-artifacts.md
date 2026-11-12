# Shared artifacts (design draft)

Status: draft for discussion. Builds on ADR 0015 (Session State, placements), ADR 0019 (panel zones), ADR 0023 (file-backed panels). Visual design: https://claude.ai/artifact/L5kxrWU6iYTjxRKzgv5m9R (private).

## Problem

Today every artifact belongs to one Session: `render_ui` items in the Session Log, file-backed panels in `<data dir>/sessions/<id>/panels/`. When the Session is deleted, they go. Another Session cannot see them. Example: a "Release Q4 checklist" panel that Session A made cannot be opened or edited by Session B tomorrow.

## Proposal

No new concept. An artifact can be **shared**. A shared artifact lives outside any Session. It shows in the app sidebar under Sessions. Any Session can attach it and gets it as a Panel. It can be opened without a Session.

## Model

- **Session artifact**: what exists today. Local to one Session, listed in its Artifacts Panel.
- **Shared artifact**: a folder `<data dir>/shared/<id>/`, never inside a Session Directory. It holds the content (`content.md`, `content.html` or `ui.json` for a `render_ui` tree) and an optional `state.json`. Plus a catalog row (ADR 0010): id, title, kind, created by (Session), created, updated, attachments. The folder is the content; the catalog is for listing and search.
- **Attachment**: a Session links to a shared artifact. Logged as `ArtifactAttached { id, by }` and `ArtifactDetached { id, by }` (additive, ADR 0021). Many to many. Deleting a Session never deletes a shared artifact. Only the user deletes one.

## Make shared

Every artifact kind can be shared. From the Artifacts Panel menu (user) or `artifact_share` (Agent), but only when the user asks for it. The content moves out of the Session into `shared/<id>/`. The Session's `render_ui` item now points at `shared:<id>`, so the Panel stays in its Zone and keeps showing it. The Session is attached automatically.

| Session artifact | Becomes |
|---|---|
| File-backed panel (`.md`, `.html`) | moved out of `panels/` as is |
| `render_ui` tree (any, `Html` too) | `ui.json`: the input of the item's latest call, plus its copied image files |
| Mermaid diagram or table in a message | fenced block as `.md` (a copy; the message keeps its own) |

Today each `render_ui` call is stored as `frontend/tools/render_ui/<call id>.json` (a new UUIDv7 file per call, the whole input with `id` inside) and the same input is in the `FrontendToolOutput` event. An item with an `id` is the sum of its calls; the reducer shows the latest. A shared tree has no call history: one `ui.json`, replaced on each update.

**State goes with the artifact.** The Session State paths the tree binds (`$state`, `$bindState`, `$template`, actions) are copied into the artifact's `state.json`. An Html artifact can read any path through the bridge, so it gets a copy of the whole Session State. From then on, every Session and the no-Session view read and write the artifact's own state, not their Session State. Logged in each attached Session as `StateChanged { artifact, ops, by }`.

## Agent side (Harness MCP)

| Tool | Does |
|---|---|
| `artifact_search {query}` | Shared artifacts matching title or text: id, title, kind, updated, attached here or not. Used when the user names one ("the release checklist"). |
| `artifact_share {id}` | Make a Session artifact (render_ui id) shared. Returns shared id and path. |
| `artifact_attach {id}` | Attach; returns the absolute dir; opens it as a Panel. Never automatic: the Agent calls it when the user names an artifact or asks for it. |
| `artifact_detach {id}` | Detach. |

The Agent edits file kinds with its own Write and Edit tools, like file-backed panels, and shows them with `render_ui source: "shared:<id>"`. For a tree kind it calls `render_ui` with `id: "shared:<id>"` and a new `root`, which replaces `ui.json` (or edits `ui.json` directly). `state_get` and `state_patch` take an optional `artifact` to change an artifact's state. `harness_info` lists attached shared artifacts with their paths, so the Agent finds them after compaction.

**Permissions**: extend the ADR 0023 default. An `edit` whose paths all resolve inside the folder of a shared artifact attached to this Session is allowed. Not attached means the normal policy (ask).

## Core

- `shared.rs`: share (move + catalog row), list, search (catalog FTS over title and content), read (content + sha256), delete, attach, detach. Reuse `panels.rs` path checks and watcher.
- One watcher on `shared/`. A change sends `SharedArtifactChanged { id }` to every View that shows it, in every Session. Live only, not logged (same as `PanelSourceChanged`).

## Frontend side

1. **Artifacts Panel**: two groups, "Shared · attached" and "This Session". Shared items carry a share icon. Local item menu: Make shared. Shared item menu: Detach, Open outside Session. Header: "Attach shared…".
2. **Panel header** of a shared artifact: "shared" badge and "Attached in N sessions".
3. **Sidebar**: a "Shared artifacts" section under Sessions. A dot marks changes since you last looked.
4. **Shared artifact view** (no Session): the rendered artifact (same renderer and sandbox as the Panel; inputs write the artifact's state), "Attached in" list with links to those Sessions, activity, and actions: Attach to Session…, New Session with it, Open in editor, Rename, Delete. Open in editor edits the file in `shared/<id>/` directly; the watcher updates every attached Session.

## Concurrency

v1: last write wins. The Agent's Edit tool fails when the old text is gone, which stops most silent overwrites. Later, if needed: a lock or "Session B is editing" in the Panel header, and history (git in `shared/`).

## Phases

1. Core: store, catalog, tools, `shared:` sources, permission default, watcher, `harness_info`.
2. Chat: Artifacts Panel groups, Make shared, Attach shared…, Panel badge.
3. App: sidebar section and shared artifact view.
4. Later: history, conflict guard, in-app editor.

## Decided

- Every artifact kind can be shared, `render_ui` trees included.
- Shared content lives in `shared/<id>/`, never in a Session. Editing by hand means editing that file.
- State goes with the artifact (`state.json`).
- Attaching is possible for user and Agent, never automatic.

## Open questions

1. Unshare: move back into one Session, or only Detach and Delete? Suggest: only Detach and Delete.
2. Search scope: title only, or full text? Suggest: both, with catalog FTS.
3. In-app editor for `.md` outside a Session? Suggest: later; Open in editor for now.
4. Html artifacts get a copy of the whole Session State. Too much? Suggest: fine for v1; Session State is small.
