# Tasks and Notes plan

Status: accepted (2026-11-18). ADR 0028 (Tasks and Session Notes) and the glossary entries must exist before step 2 merges.

**Directories:**
- `crates/harness-core`: new `tasks.rs`, `api/tasks.rs`, `host/dispatch/tasks.rs`, `session/note.rs`, MCP tools, prompt text, Create Session.
- `packages/api`: client, react hook, derive helpers, mock, contract.
- `packages/frontend-chat`: `features/tasks/*`, prompt editor changes, tool display.
- `packages/ui`: Checkbox, date picker.
- `app/src`: `tasks/` sidebar entry, Shell selection, Composer task mode.
- `docs/`: ADR 0028, GLOSSARY, this plan.

`crates/harness-tauri` needs no change. Commands go through `execute` and AppEvents go through `subscribe_app`.

Design: canvas https://claude.ai/artifact/DH6G9fehUZCh5ydaKe44LY. Its boards:
- Main: Session view with the Tasks & Notes panel.
- TaskDetail: the task drill-in.
- StartSession: the "Start session from task" dialog.
- AllTasks: the List view with a docked preview.
- AllTasksTree: the Tree view with a floating preview.
- Model: how Sessions, tasks and topics connect.

## Context

Facts from the code (2026-11-18):
- **Shared Artifacts are the model to copy.** Each item has a folder in the data dir (`<data dir>/shared/<id>/meta.json`). An in-memory index is built by a scan at startup. Writes are atomic (`fsutil::write_atomic`) and go through a `write_lock`. `forget_session` runs on Session delete (`crates/harness-core/src/shared.rs`). The store hangs off `Shared` (`crates/harness-core/src/session/shared.rs:31`) and is opened in `Harness::with_options` (`crates/harness-core/src/host/mod.rs:110`). There is no SQLite (ADR 0010 amended, ADR 0024 addendum).
- **Commands are one enum** (`crates/harness-core/src/api/command.rs`). `Harness::execute_inner` (`host/mod.rs:330`) routes each Command to one method in `host/dispatch/<domain>.rs`. After success, `execute` emits list AppEvents (`host/mod.rs:290`, for example `SharedArtifactsChanged`).
- **Live notifications** that are not logged are `AppEvent` variants (`crates/harness-core/src/api/app_event.rs`). `api::types()` (`api/mod.rs:43`) exports the types reachable from `Command`, `CommandResult` and `AppEvent`. `bun run gen-ts` writes them to `packages/api/src/generated.ts`.
- **Agent tools** are rows in `primitives()` (`crates/harness-core/src/mcp/tools.rs:50`). Each row has a Permission Policy kind. `state` and `read` are allowed by default (`permissions.rs:267`). `crates/harness-core/tests/mcp.rs:160` pins the tool list. Agent-facing text goes in `crates/harness-core/prompts/harness.md` (ADR 0014).
- **First-prompt context:** `meta.seeds[thread]` is sent as a `<context>` block before the user's text (`acp/mod.rs:77-108`). `harness_context::facts` lists Session facts (`harness_context.rs:92`). `summary::summarize` makes a fixed-format transcript, capped at 24k chars (`summary.rs:185`).
- **Chat cards for Harness tools** have three parts:
  - a pure parser in `packages/api/src/derive/subSessionTool.ts`,
  - a step kind in `packages/frontend-chat/src/features/toolDisplay/stepView.ts:72`,
  - a body in `toolDisplay/bodies/`.
- **Panels:** each feature has one `definePanel` (`packages/frontend-chat/src/features/artifacts/panel.tsx`). Panels are listed in `shell/panels.ts`, and `shell/panels.test.ts` pins their ids. Host callbacks reach panels through `PanelCtx.host` (`panels/contract.ts:30`). `shell/View.tsx:135` builds it from View props (`app/src/platform/ViewHost.tsx`).
- **Main pane without a Session:**
  - `Selection = {session} | {shared}` in `app/src/shell/Shell.tsx:31`.
  - The Frontend provides `SharedView` (`packages/api/src/contract/frontend.ts:63,145`), found by `sharedView()` in `app/src/platform/frontends.ts`.
  - The sidebar section is `app/src/shared-artifacts/SharedArtifactsSection.tsx`. Its list comes from `useSharedArtifacts` (`packages/api/src/react/hooks.ts:82`).
- **Editor:** `PromptEditor` (`packages/frontend-chat/src/features/prompt/PromptEditor.tsx`) is already used outside the prompt box (`features/review/SelectionComment.tsx`). It exports Markdown (`promptMarkdown.ts:80`). It has no Markdown import and no image node. The PR refs context is optional (`prRefs.tsx:37`).
- **Attachments:** `AttachmentInput` is Data or Path. Files are stored in `<session dir>/attachments/` and read back with `ReadAttachment` (`attachments.rs:110`). UI: `features/prompt/useAttachments.ts` and `chips/AttachmentChips.tsx`.
- **Mock:** every Command needs one handler, or the mock does not compile (`packages/api/src/mock/handlers/types.ts`). Each also needs a row in `mock/commands.test.ts`.
- **UI building blocks:** `@harness/ui` has no Checkbox, Calendar or context menu (`packages/ui/src/primitives`). Pointer drag pattern: `app/src/sessions/useFolderDrag.ts`. List/Tree switch: `lib/Segmented.tsx`. Docked resizable column: `useResizableWidth` + `ResizeHandle`, as in `SharedArtifactView.tsx`.

## 1. Data model and storage

**Global store, one folder per task**, like ADR 0024. Each task is `<data dir>/tasks/<id>/task.json`, with a `files/` folder for assets.
- There is no catalog and there are no migrations. Each file has `v: 1`, and new fields use `serde(default)`.
- The scan skips bad folders with a warning (copy `shared.rs::scan`).
- Ids are `t<n>` (`t1`, `t2`, ...). The next number is the highest found by the scan, plus 1. This is safe because the data dir lock (`fsutil::lock_dir`) allows only one Harness at a time.
- The Agent and the user can type short ids easily.

**Why files, not SQLite** (decided 2026-11-18, goes into ADR 0028):
- Filters run on tasks in memory in both designs. The Tree view and topic counts need all tasks anyway, and a few thousand tasks filter in under 1 ms.
- A new field is a struct field with `serde(default)`. SQLite needs a migration for each one.
- Assets and the note are files in both designs. SQLite would add a second store to keep in step with the asset folders.
- The app has no SQLite today (ADR 0010, amended by ADR 0021). The store pattern in `shared.rs` already exists to copy.
- All file access stays in `tasks.rs`, so a later move to SQLite changes one module and is a one-time import of the JSON files.
- Move to SQLite when one of these is needed: full-text search over bodies and notes, task history queries, custom user fields or saved views, or more than about 10,000 tasks.

New `crates/harness-core/src/api/tasks.rs` (re-exported in `api/mod.rs`):

```rust
enum TaskStatus { Backlog, Todo, InProgress, InReview, Done, Blocked, Cancelled }   // snake_case
enum TaskPriority { None, Low, Medium, High, Urgent }
struct TaskUpstream { url: String, label: Option<String> }
struct TaskAsset { name: String, mime: String, size: u64 }          // file in files/
struct TaskSessionLink { session_id: SessionId, title: String, started_ms: i64 }
enum TaskActivityKind { Created, Moved { from: Option<String>, to: Option<String> },
                        StatusChanged { from: TaskStatus, to: TaskStatus }, SessionStarted { session_id: SessionId } }
struct TaskActivity { at_ms: i64, by: StateWriter, session_id: Option<SessionId>, kind: TaskActivityKind }
struct Task {
  v: u32, id: String, title: String /* one line, Markdown */, body: String /* Markdown */,
  status: TaskStatus, priority: TaskPriority, due: Option<String> /* YYYY-MM-DD, local */,
  upstream: Option<TaskUpstream>, parent_id: Option<String>, order: f64,
  origin_session_id: Option<SessionId>, origin_title: Option<String> /* cached, like SharedCreator */,
  sessions: Vec<TaskSessionLink>, assets: Vec<TaskAsset>,
  created_ms: i64, updated_ms: i64, activity: Vec<TaskActivity> /* last 100 */,
}
struct TaskSummary { /* Task without body and activity */ has_body: bool, ... }
```

Rules in `crates/harness-core/src/tasks.rs` (a `Tasks` store on `Shared`, next to `artifacts`):
- `move_to(id, parent, before)` refuses a parent that is the task itself or one of its descendants. It records `Moved` and never changes `origin_session_id`.
- `order` counts within one set of siblings. A new task gets the highest value + 1. A move with `before` takes the midpoint.
- A "topic" is not stored. It is any task that has children.
- Deleting a task moves its children to its parent. Only the user deletes tasks.
- `forget_session(id)` removes the Session from `sessions`. `origin_session_id` stays, and the UI shows `origin_title` with "(deleted)". `Harness::delete_session` calls it next to `artifacts.forget_session` (`host/mod.rs:216`).

**Session Note: one file in the Session Directory**, like file-backed panels (ADR 0023).
- The note is `<session dir>/note.md`.
- Images go in `<session dir>/attachments/note/`, so the existing `ReadAttachment` serves them.
- Code goes in `crates/harness-core/src/session/note.rs`.
- The note is deleted with its Session.
- The note is not in the Session Log, so replay shows the note as it is now. ADR 0023 accepted the same trade-off.

## 2. Backend API

New `crates/harness-core/src/host/dispatch/tasks.rs` (listed in `dispatch/mod.rs`). Commands:

| Command                                                                                     | Result                                                              |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `ListTasks`                                                                                 | `Tasks { tasks: Vec<TaskSummary> }`                                 |
| `ReadTask { id }`                                                                           | `Task { task }`                                                     |
| `CreateTask { title, body?, parent_id?, session_id?, status?, priority?, due?, upstream? }` | `Task`                                                              |
| `UpdateTask { id, patch: TaskPatch, base_updated_ms? }`                                     | `Task` (conflict error when `body` changed after `base_updated_ms`) |
| `MoveTask { id, parent_id: Option<String>, before: Option<String> }`                        | `Task`                                                              |
| `DeleteTask { id }`                                                                         | `Ok`                                                                |
| `AddTaskAssets { id, files: Vec<AttachmentInput> }` / `RemoveTaskAsset { id, name }`        | `Task`                                                              |
| `ReadTaskAsset { id, name }`                                                                | `(mime, data)`, same shape as the `ReadAttachment` result           |
| `ReadNote { session_id }`                                                                   | `Note { content, hash, updated_ms, images: Vec<String> }`           |
| `WriteNote { session_id, content, base_hash: Option<String> }`                              | `Note` (conflict error when the hash changed)                       |
| `AddNoteImages { session_id, files: Vec<AttachmentInput> }`                                 | `Note`                                                              |

`TaskPatch` has optional fields plus `clear: Vec<TaskField>` (`Due`, `Upstream`). This avoids `Option<Option<T>>` in specta. A status change appends `StatusChanged`.

AppEvents (`api/app_event.rs`):
- `TasksChanged { ids: Vec<String> }`. Sent on every create, update, move, delete or link. The sidebar, the panel and the global view reload the list and re-read the open ids.
- `NoteChanged { session_id }`. Other windows reload the note.

Emit both in `execute` after success (copy the `changes` match at `host/mod.rs:290`). Also emit them from the MCP handlers (copy `run_artifact_attach`).

**Agent tools** (`mcp/tools.rs`):
- `task_add { tasks: [{ title, body?, priority?, due?, status?, parent?, upstream_url?, upstream_label? }] }`, kind `state`. The origin is this Session, with `by: Agent`. It returns ids and titles as JSON, which the chat card reads.
- `task_update { id, status?, title?, body?, priority?, due?, parent? }`, kind `state`. It works only on tasks that were created in this Session or are linked to it. For other tasks it refuses and tells the Agent to ask the user.
- `task_list { scope?: "session" | "all", status?, query? }`, kind `read`. It returns at most 50 rows.
- `task_get { id }`, kind `read`. It returns the fields, subtasks and linked Sessions.
- `harness_info` gets two new fields: `tasks` (this Session's tasks and the task the Session started from) and `note_path`.
- Add one line to `prompts/harness.md`: "Tasks are the user's own work items and are kept across Sessions. Add them with `task_add` only when the user asks or agrees. Keep your own step list in your todo or plan tool."
- Update the tool list in `tests/mcp.rs:160`.

**Start Session from a task:** `CreateSession` gets `task: Option<TaskStart { id, include: TaskContextParts, set_status: Option<TaskStatus> }>`. `TaskContextParts` is `{ summary, body_and_assets, parent_and_siblings, origin_note, origin_transcript }`. After the Session is created, the core does these steps in `host/create.rs`:
1. Adds a `TaskSessionLink` and a `SessionStarted` activity entry.
2. Sets the status, if the dialog asked for it.
3. Writes `SessionMeta.task_id` (`session/meta.rs`).
4. Builds the context text into `meta.seeds[main_thread]`. Task assets go in as file paths. The origin transcript comes from `summary::summarize`.

`harness_context::facts` gets one line: `- Started from task t12 "<title>": update its status with task_update`. `SessionSummary` gets `task_id: Option<String>`, which the panel pin and the sidebar use.

## 3. Frontend

**Shared data (`packages/api`):**
- `src/client/tasks.ts` (functions for the whole app) and `src/client/session/tasks.ts` (the SessionApi part, like `session/shared.ts`). Add the methods to `HarnessClient`.
- `useTasks(source)` in `src/react/hooks.ts`, a copy of `useSharedArtifacts`. Each window keeps one list and reloads it on `TasksChanged`.
- Pure helpers in `src/derive/tasks.ts`: `dueCount`, `openCount`, `childrenOf`, `topicProgress`, `upstreamId(url)` (Linear `ABC-123`, GitHub `#123`) and `isOverdue(due, today)`. They go here because the sidebar and the Frontend both need them (ADR 0012).
- `src/derive/taskTool.ts` parses `task_add` and `task_update` calls. Copy `subSessionTool.ts`.
- Mock: `mock/handlers/tasks.ts` and `mock/fixtures/tasks.ts` (two topics, subtasks, one upstream link, one overdue task), plus rows in `mock/commands.test.ts`.
- Contract (`src/contract/frontend.ts`): add `TasksView?: ComponentType<TasksViewProps>`, and the View props `onOpenTasks?(taskId?)` and `onStartFromTask?(taskId)`.

**Editors (`features/prompt`):**
- Add `$importMarkdown(md)` to `promptMarkdown.ts`. It uses Lexical `$convertFromMarkdownString` with `PROMPT_TRANSFORMERS`. Add `loadMarkdown(md)` to the handle (`editor/handle.ts`).
- Add a `singleLine` prop to `PromptEditor`: Enter submits and block transforms are off. Titles use it.
- The task body and the note use `PromptEditor` with `menuOpen={false}`.
- Autosave hook `features/tasks/useAutosave.ts`:
  - It waits 600 ms after the last change, and also saves on blur and on unmount.
  - It sends `base_hash` or `base_updated_ms`. On a conflict it shows "Changed elsewhere, reload".
- Assets: `features/tasks/AssetStrip.tsx` reuses `fromFile` and `fromPickedPath` (`prompt/attachments.ts`) and the chip style of `AttachmentChips.tsx`. Task assets and note images both use it.

**Session panel** `packages/frontend-chat/src/features/tasks/panel.tsx` (board "Main"):
- `definePanel<TasksModel, string>` with `id: "tasks"`, label "Tasks & Notes", `placement: { edge: "right" }` and `mount: "afterFirstOpen"`. Add the id to `shell/panels.test.ts`. If the panel is opened with a task id, it shows that task's detail.
- Model: `useTasks` filtered to `origin_session_id === api.sessionId`, plus the pinned task (the task whose `sessions` contains this Session), plus `useNote(api)`.
- Components:
  - `TasksPanel.tsx`: the pinned card, `QuickAdd.tsx`, the "Created here" list and the collapsed Done group.
  - `TaskRow.tsx`: status icon, priority, due date, parent chip, subtask count, upstream id and the linked Session dot.
  - `TaskDetail.tsx` (board "TaskDetail"): all fields, subtasks, Sessions and activity. "Start session with this task" calls `ctx.host.startFromTask`.
  - `NoteEditor.tsx`: the single Session Note, typed in place.
  - Field controls: `StatusMenu.tsx`, `PriorityMenu.tsx`, `DuePicker.tsx`, `UpstreamField.tsx`, `ParentPicker.tsx`.
- Add `startFromTask` and `openTasks` to `PanelCtx.host` (`panels/contract.ts`), and wire them in `shell/View.tsx:135`.

**Chat card:** add the step kind `tasks` in `toolDisplay/stepView.ts`. `bodies/TasksBody.tsx` shows "Added 3 tasks" with the rows. A click calls `ctx.open(tasksPanel, id)`.

**Global view** `features/tasks/TasksView.tsx`, exported as `frontend.TasksView` in `src/index.ts`:
- **Header:** `leading`, filters, group-by, and a `Segmented` List/Tree switch. The switch value is stored with `storedValue`. Add its key to `packages/api/src/platform/storageKeys.ts`.
- **List** (`ListView.tsx`, board "AllTasks"):
  - Topic rows with progress, subtasks indented with guide lines, a "No topic" group, and the columns.
  - Row menu (`DropdownMenu`): Move under..., New topic from this task, Start session, Open origin Session.
  - Drag a row onto a topic to nest it, with `useNestDrag.ts`. This is a copy of the pointer pattern in `useFolderDrag.ts`.
  - Grouping and filtering are pure functions in `listModel.ts`.
- **Docked preview** `PreviewColumn.tsx`: it uses `useResizableWidth` and `ResizeHandle`, can be closed, and reuses `TaskDetail`.
- **Tree** (`TreeView.tsx`, board "AllTasksTree"):
  - `treeLayout.ts` is pure. It lays out nodes left to right and computes node boxes, edges, expand state, hidden counts and Hide done.
  - SVG connectors join the nodes. Each node has +/−. The toolbar has Expand all and Collapse all.
  - A note says "N tasks without subtasks hidden" and links to List.
  - `FloatingPreview.tsx` is positioned absolutely inside the tree area only, so the tree does not reflow.

**Host (`app/src`):**
- `Shell.tsx`: `Selection` gets `{ tasks: string | null }`, which is the selected task id. Add `tasksView()` to `platform/frontends.ts`. `ViewHost` passes `onOpenTasks` and `onStartFromTask`.
- `app/src/tasks/TasksEntry.tsx`: one sidebar row between `SessionList` and `SharedArtifactsSection`. It shows "N due" and the open count from `useTasks`.
- **Start dialog** (board "StartSession"): extend `composer/ComposerDialog.tsx` with `task?: { id, title, prompt }`.
  - The title becomes "Start session from task".
  - It has a "Task context" group of Checkboxes, a "Set status" select and a `Textarea` for the prompt.
  - The prompt is prefilled with the task title, the upstream link and the first lines of the body.
  - The folder defaults to the origin Session's `workspace.source_folder`.
  - On create it calls `client.createSession({..., task})`, then `client.sessionApi(id).prompt(text)`.
  - The prompt is a plain Textarea because the app cannot import `PromptEditor` (boundary rule).

**State pattern:** tasks and the note are not in the Session Log, so they do not go through the chat reducer. Commands load them into a `useTasks` hook, and AppEvents trigger a re-read. Shared Artifacts work the same way (`useSharedMetas.ts`).

## 4. Phases

Each phase is one PR and ships alone. Every phase runs `bun run check:rust`, `bun run test`, `bun run typecheck`, `bun run lint`, `bun run check:generated`, and a preview on `app-alt-port`.

1. **ADR and glossary.** Write ADR 0028. Add the GLOSSARY terms Task and Session Note, with a note that they are not the Agent's Task List. No code.
2. **Core store and commands.** Add `api/tasks.rs`, `tasks.rs`, `dispatch/tasks.rs`, the AppEvents and `forget_session`. Then run gen-ts and add the client functions, `useTasks`, `derive/tasks.ts`, mock handlers and fixtures. Tests:
   - cargo, in `tasks.rs`: create; ids after reopen; the scan skips bad folders; a move refuses cycles and keeps the origin; activity entries; delete moves children to the parent; `forget_session`; the `order` midpoint.
   - vitest node: `derive/tasks.test.ts` (due count, upstream id) and a `mock/commands.test.ts` row.
3. **Session Note and panel shell.** Add `session/note.rs` and the note commands, `$importMarkdown`, `NoteEditor`, and `tasksPanel` with only the note. Tests:
   - cargo: write and read; hash conflict; images under `attachments/note/`; the note is removed with its Session.
   - node: Markdown round trip for a set of fixtures (`promptMarkdown.test.ts`).
   - dom: autosave saves on unmount.
   - `panels.test.ts` with the new id.
4. **Tasks in the panel.** Quick add, Created here, the Done group, and `TaskDetail` with all fields, assets and subtasks. Add Checkbox and a date picker to `@harness/ui`. Tests:
   - dom `TasksPanel.test.tsx`: quick add creates the task in this Session; drill-in; Done is collapsed.
   - node: the `listModel` helpers.
5. **Agent tools and chat card.** The four tools, `harness_info`, `harness.md`, `taskTool.ts`, `TasksBody`, and a mock tool call in `app/src/mock/events.ts`. Tests:
   - `tests/mcp.rs`: the tool list; `task_add` sets the origin; `task_update` is refused on an unrelated task.
   - node: `taskTool.test.ts` and a `stepView.test.ts` case.
6. **Global view, List.** The sidebar entry, `Selection.tasks`, `TasksView`, List, filters, group-by, the docked preview, Move under, and drag to nest. Tests:
   - node `listModel.test.ts`: grouping, "No topic", filters.
   - dom: the preview opens and closes, and the list gets narrower; Move under calls `MoveTask`.
7. **Global view, Tree.** `treeLayout.ts`, `TreeView` and the floating preview. Tests:
   - node `treeLayout.test.ts`: only tasks with children show; hidden counts; Expand all; Hide done.
   - dom: the preview covers the tree without moving the nodes.
8. **Start Session from a task.** `TaskStart` on `CreateSession`, the seed builder, the facts line, `SessionSummary.task_id`, the Composer task mode and the pinned task in the panel. Tests:
   - cargo `tests/fake_agent.rs`: the first prompt has only the chosen parts; the link and status are set; the origin note and transcript are included when ticked.
   - node: the Composer args builder (`composer.test.ts`).

## 5. Risks

- **Names.** The glossary says not to use "tasks" for the Agent's Task List. Claude also has its own `TaskCreate`/`TaskUpdate` tools (`docs/explorations/2026-11-15-agent-task-list.md`), so the Agent may confuse `task_add` with its todo tool. The tool descriptions and the `harness.md` line must make the difference clear. Check this with Claude and Codex in a smoke run.
- **ADR 0003** (Views render from the Session Log). Tasks and the note live outside the Log, as Shared Artifacts do. Replaying a Session shows them as they are now. ADR 0028 must say this.
- **Lexical round trip.** Markdown import followed by export may not give back the same text (escapes, nested lists). `PromptEditor` also has prompt-only behavior (slash menu keys, PR chips). Make sure `singleLine` and the new props do not change the prompt box.
- **Missing UI primitives.** Checkbox, Calendar (adds `react-day-picker`) and maybe a context menu go into `@harness/ui` first. There is no library for drag to nest, so copy the pointer pattern.
- **Concurrency.** If two windows edit the same body, the last write wins. The exception is the body and the note, which the `base_updated_ms` and `base_hash` checks protect.
- **Multi-task writes are not atomic.** Delete moves children to the parent and writes one file per child. A crash in the middle leaves each file valid but the tree half changed. Write children first and the deleted task last, so a retry finishes the job.
- **Seed size.** The origin transcript can be up to 24k chars. Show its size in the dialog, as `TranscriptSize` does for side threads.

## Unresolved questions

1. Global or per-repo tasks? Suggest: global store, with a filter by the origin Session's repo.
2. Agent changes status without asking? Suggest: yes, for tasks created in or linked to its Session. No delete tool.
3. Note storage? Suggest: `note.md` in the Session Directory. Not a DB, not the Session Log.
4. Asset storage? Suggest: `tasks/<id>/files/` for tasks, `<session dir>/attachments/note/` for note images.
5. Session deleted? Suggest: its tasks stay. The origin shows the cached title + "(deleted)". Archive changes nothing.
6. Ordering? Suggest: `order: f64` per parent. v1 sorts by status, priority, due date. Manual reorder by drag later.
7. Task ids? Suggest: `t<n>`, easy for people and the Agent to read.
8. Inline images in note/body? Suggest: not in v1. Asset strip below the editor; inline image node later.
9. "Set status while it runs": revert when the Session ends? Suggest: no, set once at start.
10. Agent writes the Session Note? Suggest: read only, via `note_path` in `harness_info`.
11. Delete a task with children? Suggest: children move to its parent.
12. Tasks panel in the Quick Overlay? Suggest: no (`overlay: false`).
