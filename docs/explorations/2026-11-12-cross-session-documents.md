# Cross-session Documents (design draft)

Status: draft for discussion. Builds on ADR 0015 (Session State, placements), ADR 0019 (panel zones), ADR 0023 (file-backed panels).

## Problem

Today every artifact belongs to one Session:

- `render_ui` items live in the Session Log.
- File-backed panels live in `<data dir>/sessions/<id>/panels/`.
- Session State lives in `<data dir>/sessions/<id>/state.json`.

When the Session is deleted, all of it goes. A second Session cannot see it. Example: a "Release checklist" panel that Session A made cannot be opened or edited by Session B tomorrow.

## Proposal in one sentence

A **Document** is a named folder of artifact files that the Harness owns outside any Session; any Session can attach it, show its files as Panels, and let its Agent edit them.

## Model

**Document**: a folder `<data dir>/documents/<doc-id>/` with:

- `document.json`: `{ id, title, created, updated, icon? }`.
- Artifact files: `.md` and `.html` (same types as ADR 0023), subfolders allowed. Example: `overview.md`, `diagrams/flow.md`, `dashboard.html`.
- Optional `state.json`: Document State, same shape and patch rules as Session State, so `.html` files in a Document can keep data that outlives a Session.

A Document has no Agent, no Thread and no Workspace. It is storage plus a viewer.

**Attachment**: a Session links to a Document. Logged as `DocumentAttached { doc, by }` and `DocumentDetached { doc, by }` (additive, ADR 0021). One Session can attach many Documents. One Document can be attached to many Sessions.

Deleting a Session never deletes a Document. Deleting a Document is a user action only.

## Agent side (Harness MCP)

Same pattern as file-backed panels: the Agent writes files with its own Write and Edit tools. New tools only for find and attach:

| Tool | Does |
|---|---|
| `document_list` | All Documents: id, title, updated, file names, attached here or not. |
| `document_create {title}` | New empty Document, attached to this Session. Returns its absolute `dir`. |
| `document_attach {doc}` / `document_detach {doc}` | Link or unlink. Attach returns `dir`. |
| `doc_state_get` / `doc_state_patch` | Document State (only if we keep `state.json`). |

`harness_info` lists attached Documents with `dir` and file names, so the Agent finds them again after compaction. Harness Context names them at the start of each Agent Session.

**Show a Document file as a Panel**: `render_ui` `source` gets a prefix: `source: "doc:<doc-id>/overview.md"`. Same reducer path as ADR 0023 (Markdown node or Html node naming the file). Only attached Documents are allowed.

**Permissions**: extend the ADR 0023 default. An `edit` whose paths all resolve inside the folder of a Document attached to this Session is allowed. Same `resolve_inside` checks. Not attached means the normal policy (ask).

## Core

- `documents.rs`: create, list, read (content + sha256), delete, path checks. Reuse `panels.rs` (`resolve_inside`, `check_name`, `watch`).
- Watcher per Document, started on first read from any View. One `DocumentFileChanged { doc, name }` AppEvent goes to every View that shows it, in every Session. Live only, not logged (same as `PanelSourceChanged`).
- Catalog: Documents list in the SQLite catalog (ADR 0010) for fast listing; the folder is the source of truth.

## Frontend side

1. **Documents Panel** in the chat (default zone: left bottom, near Artifacts). Lists attached Documents and their files. Click opens a file as a Panel. Menu: attach existing, detach, open in Documents view.
2. **Documents view** outside Sessions (sidebar section, like Sessions). Full window: file tree on the left, the rendered file on the right. Lets the user read a Document with no Session. Action "Work on this in a new Session" opens the Composer with the Document already attached.
3. **Save to Document** in the Artifacts Panel: copies a Session artifact (file-backed panel, Mermaid, table, Html root) into a Document as a file. This is how a Session-only artifact becomes a shared one.

## Concurrency

Two Sessions can edit one file at the same time. v1: last write wins, like any file on disk. The View shows the newest content from the watcher. The Agent's Edit tool already fails when the old text is not found, which stops most silent overwrites. Later, if needed: a sha256 `test` on writes, or a lock shown in the Panel header ("Session B is editing").

## History (later)

ADR 0023 accepted "no history" for Session panels. Documents live longer, so history matters more. Cheapest option: make each Document folder a git repo and commit on each debounced change. Not in v1.

## Phases

1. Core: `documents/` folder, `document_*` tools, `doc:` sources, permission default, watcher, `harness_info`.
2. Chat: Documents Panel, `doc:` panels, Save to Document.
3. App: Documents view outside Sessions, "new Session with this Document".
4. Later: Document State, history, conflict guard.

## Open questions

1. Name: "Document" or "Canvas" or "Board"? Glossary already reserves "canvas" as a possible Frontend kind. Suggest: Document.
2. Document State (`state.json`) in v1? Suggest: no, add in phase 4 when an `.html` needs it.
3. Inline `render_ui` trees (`root`, not `source`) in a Document? Suggest: no, files only. Save to Document converts a tree to `.html` or JSON-in-md.
4. Should the user edit Document files by hand in the Documents view? Suggest: v1 read-only plus "open in editor" (existing `editor.rs`).
5. Scope: global, or per repository? Suggest: global list, with optional repository tag for filtering.
6. Auto-attach: when a Session is started from a Document, attach it. Also attach Documents the user names in a prompt? Suggest: only explicit attach in v1.
