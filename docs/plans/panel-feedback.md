# Panel feedback plan

**Directories:** `crates/harness-core` (new MCP tool, session panels folder, permission rule, file watch), `packages/frontend-chat` (render_ui schema, renderers, view_artifact, file-backed items), `packages/api` (new host calls), `docs/` (ADR 0023, glossary, this plan).

## Context

An agent that kept 7 render_ui panels open over several days reported three costs: it resends 15-20k characters per change, it cannot read a panel back after compaction, and panels go stale. This plan covers the changes we agreed to build, cheapest first. Each step is a separate commit and can ship alone.

Facts from the code (2026-11-12):
- Core already keeps the full latest input per id: `session.rs:465` `frontend_items()`. `harness_info` (`mcp.rs:341`) returns only `{tool, id, placement, title, errors}`.
- Validation errors already carry JSON Pointer paths (`mcp.rs:314`, `frontend_files.rs:21`), but the long tool description is appended after them.
- Accordion and Tabs take titles from `props.items` and body i from `kids[i]` (`disclosure.tsx:57,194`). A `Repeat` child is one kid, so it cannot create items.
- `view_artifact` with `html` renders `UiHtml` with `state={null}` (`ArtifactRequest.tsx:113`). Capture goes through `snapshotFrame` (`toPng.ts:93`).
- Core has no file watcher. Frontend can read only `frontend/` files and `rev:path` via git. Markdown renders with react-markdown + remark-gfm (`Markdown.tsx`).
- Frontend items have `ts` (`artifacts.ts:24`); core items have no time.

## 1. `ui_get` MCP tool

- New tuple in `primitives()` (`mcp.rs:139`), kind `read`. Input `{id}`. Output: the stored input (`root`, `placement`, `title`, `icon`, or `source` after step 5), plus the state values its `$state` paths point to.
- Match arm uses `session.frontend_items()` filtered by tool `render_ui` and id. Unknown id: error that lists known ids.
- Update the tool snapshot in `crates/harness-core/tests/mcp.rs:145` and add a line to `crates/harness-core/prompts/harness.md`: "After compaction, read a panel with ui_get before you change it."
- Test: render two items, replace one, remove one, `ui_get` returns the latest input and errors on the removed id.

## 2. Clearer validation errors

- Put the error list first, the tool description last, and cap it at the first 5 errors.
- Add the node type at the failing path, e.g. `/root/children/2 (Accordion): props.items is required`. Resolve the type by walking the input with the pointer.
- Same format in the client re-check (`reducer.ts:584`).
- Test in `renderUi.test.ts`: a bad nested node gives a path plus node type.

## 3. Html capture bug in `view_artifact`

- Reproduce first: an Html render_ui panel by `id`, and raw `html`. Record which path is blank.
- Likely causes: `state={null}` (bindings draw empty); transparent body with no page background; the 4 s `snapshotFrame` timeout. Fix the one the repro shows. For the `id` path, pass the session state.
- Add a regression test for the cause found (bridge or `toPng` unit level).

## 4. Accordion and Tabs items from state

- New optional prop on Accordion and Tabs: `repeat: {"statePath": "/tickets", "title": "name"}`. With it, the node has one child, a template rendered once per array item with the same `$item` / `$index` scope as `Repeat`. The title of item i is `item[title]` (or a `$template`).
- Static `items` keeps working. Schema: `items` and `repeat` are mutually exclusive.
- Update the render_ui description and the Repeat docs: "Repeat inside Accordion or Tabs gives one item; use `repeat` on the parent."
- Tests: spec validation plus a renderer test with 3 state items, then a `state_patch` that adds a fourth.

## 5. File-backed panels (needs ADR 0023)

- Source files live in the session folder, never in the user's worktree: `<data_dir>/sessions/<id>/panels/`. The core creates the folder. Worktree files as sources are out of scope for now (maybe later, read-only).
- render_ui input gets `source` as an alternative to `root`: `{"id", "placement", "title", "source": "progress.md"}`. `source` is a name relative to the panels folder. Exactly one of `root` or `source`.
- `harness_info` returns `panels_dir` (absolute path), so the agent knows where to write.
- Permissions: new built-in rule in `permissions.rs` (next to line 149) that allows writes inside `<session>/panels/` without a prompt. Today writes outside the session folder get `Ask`. Test the rule, including `..` and symlink escapes.
- v1 renders Markdown only (`.md`). `<details>`/`<summary>` allowed through rehype-sanitize with a small allowlist, no other raw HTML. `.html` sources (same sandbox as Html) are a later step.
- Core: validate that `source` resolves inside the panels folder (no `..`, no symlink escape) and exists. Store the name, not the content. The log keeps only the name, so replay shows the current file.
- Core: new host call `PanelSourceRead {session, name}` with the same path check. It returns content plus a hash.
- Updates: core watches the source files of live items with the `notify` crate and sends a `PanelSourceChanged {id}` notification (not logged). The frontend re-reads and re-renders. Fallback when a watch fails: re-read on window focus.
- Missing or unreadable file: the panel shows "Source missing: <path>" and the item gets an `errors` entry in `harness_info`.
- `ui_get` returns `source` and the current content.
- Prompt line: "For panels you will change often, write Markdown to a file in `panels_dir` and pass its name as `source`. Then change it with Edit. Never put panel files in the worktree."
- Tests: path checks and the permission rule (core), item replay with `source`, watcher sends one event per write (debounced 200 ms), renderer shows `<details>`.

## 6. "Updated N ago" label

- Panel header shows the time of the last change: the item's `ts`, or the file mtime for `source` panels. Relative format, tooltip with the full time.
- `harness_info` items get `updated_ms` so the agent can see old panels too.

## Later, only if needed

- `ui_patch(id, ops)`: JSON Patch on the stored tree with the existing engine (`state.rs`). Build it only if agents still resend large non-Markdown trees after step 5.
- `depends_on` staleness marks, panel groups, archive instead of remove, sources bound to Linear.

## Verify

- `bun run check:rust`, `bun run test`, `bun run typecheck`, `bun run lint`, `bun run check:generated`.
- In the app: one session that creates a Markdown source panel, edits one line with Edit, and checks with `ui_get` and `view_artifact`.

## Unresolved questions

1. File watch: `notify` crate in core, or frontend polling (2 s, by hash)? Suggest: `notify`, polling is the fallback.
2. Accordion/Tabs: new `repeat` prop, or allow `Repeat` as the only child and expand it? Suggest: `repeat` prop, it is explicit.
3. Subfolders in `panels/` (e.g. `source: "upgrade/progress.md"`)? Suggest: allow them.
4. `ui_get` include resolved state values, or only the tree? Suggest: include them, it saves a `state_get` call.
