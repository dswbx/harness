# Shared artifacts (design draft)

Status: draft for discussion. Builds on ADR 0015 (Session State, placements), ADR 0019 (panel zones), ADR 0023 (file-backed panels). Visual design: https://claude.ai/artifact/L5kxrWU6iYTjxRKzgv5m9R (private).

## Problem

Today every artifact belongs to one Session: `render_ui` items in the Session Log, file-backed panels in `<data dir>/sessions/<id>/panels/`. When the Session is deleted, they go. Another Session cannot see them. Example: a "Release Q4 checklist" panel that Session A made cannot be opened or edited by Session B tomorrow.

## Proposal

No new concept. An artifact can be **shared**. A shared artifact lives outside any Session. It shows in the app sidebar under Sessions. Any Session can attach it and gets it as a Panel. It can be opened without a Session.

## Model

- **Session artifact**: what exists today. Local to one Session, listed in its Artifacts Panel.
- **Shared artifact**: one file (`.md` or `.html`) in `<data dir>/shared/<id>.<ext>`, plus a catalog row (ADR 0010): id, title, kind, created by (Session), created, updated, attachments. The file is the content; the catalog is for listing and search.
- **Attachment**: a Session links to a shared artifact. Logged as `ArtifactAttached { id, by }` and `ArtifactDetached { id, by }` (additive, ADR 0021). Many to many. Deleting a Session never deletes a shared artifact. Only the user deletes one.

## Make shared

From the Artifacts Panel menu (user) or `artifact_share` (Agent). The file moves from the Session's `panels/` into `shared/`. The Session's `render_ui` item now points at `shared:<id>`, so the Panel stays in its Zone and keeps showing it. The Session is attached automatically.

| Session artifact | Becomes |
|---|---|
| File-backed panel (`.md`, `.html`) | moved as is |
| Inline `Html` root | its HTML as `.html` |
| Mermaid diagram or table in a message | fenced block as `.md` (a copy; the message keeps its own) |
| Other `render_ui` tree | open question 1 |

## Agent side (Harness MCP)

| Tool | Does |
|---|---|
| `artifact_search {query}` | Shared artifacts matching title or text: id, title, kind, updated, attached here or not. Used when the user names one ("the release checklist"). |
| `artifact_share {id}` | Make a Session artifact (render_ui id) shared. Returns shared id and path. |
| `artifact_attach {id}` | Attach; returns the absolute path; opens it as a Panel. |
| `artifact_detach {id}` | Detach. |

The Agent edits a shared artifact with its own Write and Edit tools, like file-backed panels. `render_ui` accepts `source: "shared:<id>"` for an attached one. `harness_info` lists attached shared artifacts with their paths, so the Agent finds them after compaction.

**Permissions**: extend the ADR 0023 default. An `edit` whose path resolves to the file of a shared artifact attached to this Session is allowed. Not attached means the normal policy (ask).

## Core

- `shared.rs`: share (move + catalog row), list, search (catalog FTS over title and content), read (content + sha256), delete, attach, detach. Reuse `panels.rs` path checks and watcher.
- One watcher on `shared/`. A change sends `SharedArtifactChanged { id }` to every View that shows it, in every Session. Live only, not logged (same as `PanelSourceChanged`).

## Frontend side

1. **Artifacts Panel**: two groups, "Shared · attached" and "This Session". Shared items carry a share icon. Local item menu: Make shared. Shared item menu: Detach, Open outside Session. Header: "Attach shared…".
2. **Panel header** of a shared artifact: "shared" badge and "Attached in N sessions".
3. **Sidebar**: a "Shared artifacts" section under Sessions. A dot marks changes since you last looked.
4. **Shared artifact view** (no Session): the rendered file (same renderer and sandbox as the Panel), "Attached in" list with links to those Sessions, activity, and actions: Attach to Session…, New Session with it, Open in editor, Rename, Delete.

## Concurrency

v1: last write wins. The Agent's Edit tool fails when the old text is gone, which stops most silent overwrites. Later, if needed: a lock or "Session B is editing" in the Panel header, and history (git in `shared/`).

## Phases

1. Core: store, catalog, tools, `shared:` sources, permission default, watcher, `harness_info`.
2. Chat: Artifacts Panel groups, Make shared, Attach shared…, Panel badge.
3. App: sidebar section and shared artifact view.
4. Later: history, conflict guard, Shared State for Html artifacts.

## Open questions

1. Can other `render_ui` trees (not Html, not a file) be shared? Suggest: not in v1; hide Make shared for them.
2. Unshare: move back into one Session, or only Detach and Delete? Suggest: only Detach and Delete.
3. Search scope: title only, or full text? Suggest: both, with catalog FTS.
4. Edit by hand outside a Session? Suggest: read-only plus Open in editor.
5. Auto-attach when the user names one in a prompt? Suggest: no; the Agent searches and attaches.
6. Shared State (`state.json`) for Html artifacts? Suggest: later.
