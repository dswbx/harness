# File-backed panels: render_ui `source` names a Markdown file in the Session Directory

An Agent kept 7 `render_ui` panels open for days. Each change resent the whole tree (15-20k characters), it could not read a panel back after compaction, and panels went stale. Most of these panels were prose and checklists: Markdown the Agent already knows how to edit.

**Decision:** `render_ui` takes `source` as an alternative to `root` (exactly one of them): the name of a Markdown file in the Session's `panels/` folder (`<data dir>/sessions/<id>/panels/`, subfolders allowed, `.md` only in v1; `.html` added later, see the addendum). The Agent writes the file with its own Write tool and changes it with Edit; the panel follows the file.

**Files live in the Session Directory, never in the Workspace.** They are Session state, not project files: no stray files in the user's repository, no diff noise, and they go when the Session is deleted. `harness_info` returns `panels_dir` (absolute) so the Agent knows where to write. Worktree files as sources are out of scope (maybe later, read-only).

**Edits there need no permission.** A built-in default in `permissions.rs`: an `edit` whose paths all resolve inside `panels/` is allowed. Paths are resolved for real (`panels.rs` `resolve_inside`): `..` is refused, symlinks are followed (also of the parent folders of a file that does not exist yet), and a dangling symlink is refused, because a write would follow it out. User rules still win over the default. Commands (`execute`) still ask: a shell could write anywhere.

**The log keeps the name, not the content.** The core checks the name (inside `panels/`, exists) when the call comes in and stores the input as is. Replay shows the file as it is now, not as it was; that is the point, and the price (no history of a panel's content). The chat reducer turns a `source` item into a Markdown node that names the file, so chat rows, live areas, Panels and Artifacts need no second code path.

**Reads and changes go through the core.** `PanelSourceRead {session, name}` returns content and a sha256 (same path check). The first read starts a `notify` watch on `panels/` (recursive) for that Session; it stops when the Session is deleted. Writes are debounced (200 ms of quiet) into one `PanelSourceChanged {session, name}` AppEvent per file: live only, not logged, since Views render from the log and the log does not change. The View re-reads on that event and on window focus (the fallback when the watch fails).

**Markdown with `<details>`.** The panel uses the chat's Markdown renderer with raw HTML on, cut down by rehype-sanitize to the default (GitHub) schema plus `<details open>` and `<summary>`: no scripts, styles, frames or event handlers. Messages keep raw HTML off. `.html` sources: see the addendum.

**Missing file.** The panel shows "Source missing: <name>"; `harness_info` lists the error on the item, and `ui_get` returns the current `content` (or the error) with the stored input.

## Addendum: `.html` sources

`source` may also end in `.html`. The reducer turns such an item into an Html node that names the file (`{type: "Html", props: {source}}`; the Html schema has no `source` prop, so only a `source` item makes one). It renders in the same sandboxed frame as an inline Html node: same CSP, same state bridge, same actions and error reports; only the document comes from the file. Name checks, the watcher, reads, `ui_get`, `harness_info`, the permission default and the change dot treat both types the same. A file change gives a new document, so the frame reloads (its own script state is lost; Session State is not); an unchanged hash keeps the frame as it is. Use `.md` for text, `.html` for interactive or custom-styled panels.

## Addendum: `.json` sources

Agents kept choosing `.md` panels with `<details>` over render_ui components, because a file can be changed with Edit and a `root` must be sent again whole. So `source` may also end in `.json`: a render_ui tree as `{"root": node}`, the format of a Shared Artifact's `ui.json`. The reducer turns such an item into the internal `SourceTree` node (not in the catalog, like `Shared`); the renderer reads the file, checks it with the render_ui schema and renders it bound to the Session State, like a `root`. A bad file shows its errors in the panel.

The core checks the tree with the Frontend's render_ui schema when the call comes in (the call fails, as for a bad `root`) and on each `harness_info` (the errors are listed on the item), so the Agent sees a broken edit. Local image paths are refused: only a `root` copies images (`frontend_files`); `https:` and `data:image/` work. `artifact_share` moves the file as the artifact's `ui.json` (kind `ui`) with the state it binds.
