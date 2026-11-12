# Shared Artifacts: any artifact can leave its Session and be attached by others

Every artifact belonged to one Session: `render_ui` items in the Session Log and `frontend/tools/render_ui/`, file-backed panels in `panels/` (ADR 0023), their data in Session State (ADR 0015). Another Session could not open them, and they went with the Session. Users want to keep working on one artifact (a release checklist, an architecture map) across Sessions, and to look at it without a Session. Design exploration: `docs/explorations/2026-11-12-shared-artifacts.md`.

**Decision:** an artifact can be made **shared**. No new kind of object: a Shared Artifact is an artifact that lives outside any Session. Any Session can attach it and gets it as a Panel. The app sidebar lists Shared Artifacts under Sessions, and one can be opened without a Session.

**Storage: a folder in the data dir, never in a Session Directory.** `<data dir>/shared/<id>/` holds the content and an optional `state.json`. The content is `content.md`, `content.html` or `ui.json` (a `render_ui` input). `meta.json` in the same folder holds the id, title, kind, created by (Session), created, updated, and the attached Sessions. The Host keeps an in-memory index of all `meta.json` files for listing and search (see the addendum). The folder is the truth; the index is rebuilt from the folders at startup. A Shared Artifact is deleted only by the user, never with a Session.

**Every kind can be shared.** "Make shared" moves the content out of the Session:

| Session artifact | Shared content |
|---|---|
| File-backed panel (`.md`, `.html`) | the file, moved out of `panels/` |
| `render_ui` tree (any root, `Html` too) | `ui.json`: the input of the item's latest call, plus its copied image files (`frontend/files/`) |
| Mermaid diagram or table in a message | the fenced block as `content.md`; a copy, the message keeps its own |

A Session `render_ui` item is stored as one file per call (`frontend/tools/render_ui/<call id>.json`, UUIDv7) and the reducer shows the latest call for an `id`. A shared tree has no call history: one `ui.json`, replaced on each update. The Harness then logs a new `render_ui` output for the same item id with `source: "shared:<id>"` (earlier calls stay in the log, ADR 0021), so the Panel keeps its Zone and shows the shared content. The sharing Session is attached at once.

**State goes with the artifact.** On sharing, the Session State paths the tree uses (`$state`, `$bindState`, `$template`, `$computed`, `visible` and actions) are copied into the artifact's `state.json`. An `Html` artifact can read any path through the state bridge, so it gets a copy of the whole Session State. From then on, every View of the artifact, in any Session or none, reads and writes the artifact's state, not its Session State. A change is logged once, in the Session that made it, as `ArtifactStateChanged { id, ops, by }`, and sent live to every View that shows the artifact (see the addendum).

**Attachments.** A Session links to a Shared Artifact with `ArtifactAttached { id, by }` and unlinks with `ArtifactDetached { id, by }` (additive, ADR 0021). Many to many. Attaching is always an explicit act of the user or the Agent, never automatic: naming an artifact in a prompt does not attach it.

**Agent tools (Harness MCP).**

- `artifact_search {query}`: Shared Artifacts matching title or text, with id, title, kind, updated and whether this Session has it attached. The Agent uses it when the user names one.
- `artifact_share {id}`: share a Session artifact (a `render_ui` id). Only when the user asks. Returns the shared id and its folder.
- `artifact_attach {id}` / `artifact_detach {id}`: attach returns the folder and opens the artifact as a Panel.
- `render_ui` takes `source: "shared:<id>"` for an attached file kind, and `id: "shared:<id>"` with a new `root` to replace an attached tree's `ui.json`.
- `state_get` and `state_patch` take an optional `artifact` to read or change an artifact's state.
- `harness_info` lists attached Shared Artifacts with their folders, so the Agent finds them again after compaction. Harness Context names them at the start of each Agent Session.

**Edits need no permission when attached.** The ADR 0023 default is extended: an `edit` whose paths all resolve inside the folder of a Shared Artifact attached to this Session is allowed, with the same `resolve_inside` checks (no `..`, symlinks followed, dangling symlinks refused). A Shared Artifact that is not attached falls under the normal policy. User rules still win. Commands still ask.

**Changes reach every View.** One `notify` watch on `shared/`, started when the Host starts, debounced 200 ms per file into `SharedArtifactChanged { id }`. Live only, not logged (as `PanelSourceChanged`). Every View that shows the artifact re-reads it, in every Session and in the no-Session view. Edits from outside the Harness (an editor) arrive the same way, so "Open in editor" is the way to edit by hand.

**Frontend.**

- The chat's Artifacts Panel has two groups, "Shared · attached" and "This Session". Session items get "Make shared" in their menu; shared items get "Detach" and "Open outside Session". The header gets "Attach shared…".
- The Panel of a Shared Artifact shows a "shared" badge and "Attached in N Sessions".
- The app sidebar gets a "Shared artifacts" section under Sessions, with a dot for changes since the user last looked.
- The Shared Artifact view (no Session) renders the artifact with the same renderer and sandbox as the Panel; inputs write the artifact's state. It shows where it is attached (links to those Sessions) and recent activity, and offers Attach to Session…, New Session with it, Open in editor, Rename and Delete.

**Concurrency: last write wins.** Several Sessions can change one artifact at the same time, like any file. The Agent's Edit tool fails when the old text is gone, which stops most silent overwrites. State patches are atomic per patch, as in ADR 0015. No locks in v1.

**Not in v1.** Unsharing (moving an artifact back into one Session): only Detach and Delete. History of a Shared Artifact (later, maybe git in `shared/`). An in-app editor outside a Session. A guard against concurrent edits.

**Consequences.** Replaying a Session that attached a Shared Artifact shows the artifact as it is now, not as it was; ADR 0023 accepted the same for panels. Deleting a Shared Artifact leaves its attached items showing "Shared artifact missing". Copying the whole Session State into an `Html` artifact can copy unrelated data; Session State is small, so we accept it.

## Addendum: no catalog, a new Event kind for artifact state

Building this showed that the SQLite catalog does not exist. ADR 0021 says `session.json` is the catalog and no SQLite store was built. These points change the design above.

- **No catalog.** Each Shared Artifact has `shared/<id>/meta.json`. The Host keeps an in-memory index. It builds the index at startup: it scans `shared/`, the same way it scans `sessions/`. A folder with a bad or missing `meta.json` is skipped with a warning.
- **Search.** Search is a case-insensitive substring match on the title and the content. The Harness reads at most 1 MB of each content file. Title matches come first, then the most recently updated. A search returns at most 20 results. Each result has a short snippet.
- **`ArtifactStateChanged { id, ops, by }` is a new Event kind.** It replaces the `artifact` field on `StateChanged`. An older reducer would apply a `StateChanged` with an unknown field to the Session State. It ignores an unknown Event kind.
- **Artifact state is not replayed from Session Logs.** The Session that makes a change logs it once. Other Sessions do not log it. Every View reads the current state with `SharedArtifactRead`, and reads it again when the artifact changes. ADR 0023 accepted the same trade-off for panel files.
- **Attachments are stored twice.** The Session Log (`ArtifactAttached`, `ArtifactDetached`) is the truth. `meta.attached` is a cache for "Attached in N Sessions" and the list of Sessions. Deleting a Session removes it from `meta.attached`.
- **The watch starts with the Host.** The sidebar needs change events before any View reads an artifact, so the watch on `shared/` starts when the Host starts.
- **`artifact_share` asks no permission.** The Agent uses it only when the user asks. Its permission kind is `state`, which the default allows.
- **`meta.json` is never edited without asking.** The edit default for attached artifacts excludes `meta.json`. The Harness alone writes it.
