# Tasks and Session Notes live outside the Session Log

Users keep work items (things to do, bugs, ideas) in many places. They want them next to the Sessions that work on them, and they want one list that outlives any Session. They also want one free-form note per Session. The Agent's Task List (its own steps, in the Thread) does not fit: it belongs to one Thread and the Agent owns it. Plan: `docs/plans/tasks-and-notes.md`.

**Decision:** two new things, both outside the Session Log.

- A **Task** is a work item of the user. It is kept across Sessions in one global store.
- A **Session Note** is one Markdown note per Session, typed by the user.

**Task storage: a folder per task in the data dir.** `<data dir>/tasks/<id>/task.json` holds the task. Assets (images, files) go in `<data dir>/tasks/<id>/files/`. Like Shared Artifacts (ADR 0024), the Host keeps an in-memory index built by a scan at startup, and the folder is the truth. A folder with a bad `task.json` is skipped with a warning. Each file has `v: 1`, and new fields use `serde(default)`. There are no migrations. Writes are atomic.

**Ids** are `t<n>` (`t1`, `t2`). The next number is the highest found by the scan, plus 1. The data dir lock allows one Harness at a time, so this is safe. People and the Agent can type short ids.

**Topics.** A task has an optional `parent_id`. A **Topic** is not stored. It is any task that has children. Deleting a task moves its children to its parent. Only the user deletes tasks.

**Origin and links.** A task records the Session it was created in (`origin_session_id`) and caches that Session's title. The origin never changes, also when the task moves to another parent. A task can also be linked to other Sessions (`sessions`), for example by "Start Session from task". When a Session is deleted, `forget_session` removes it from the links. The origin id stays, and the UI shows the cached title with "(deleted)". Archiving a Session changes nothing.

**Session Note.** The note is `<session dir>/note.md`. Images are in `<session dir>/attachments/note/`, so the existing attachment read serves them. The note goes with its Session.

**Outside the Session Log.** Neither tasks nor notes are Events (ADR 0003, ADR 0021). Views load them with commands and reload them on `TasksChanged` and `NoteChanged` AppEvents. Replaying a Session shows tasks and the note as they are now, not as they were. ADR 0024 and ADR 0023 accepted the same for Shared Artifacts and panel files.

**Why files, not SQLite.**
- Filters run in memory in both designs. The Tree view needs all tasks anyway. A few thousand tasks filter in under 1 ms.
- A new field is a struct field with a default. SQLite needs a migration for each one.
- Assets and the note are files in both designs. SQLite would add a second store to keep in step.
- The app has no SQLite (ADR 0010, amended by ADR 0021). The store pattern of Shared Artifacts already exists.
- All file access stays in one module, `tasks.rs`. A later move to SQLite changes that module and imports the JSON files once.
- Revisit when we need full-text search over bodies and notes, history queries, custom fields or saved views, or more than about 10,000 tasks.

**Agent tools (Harness MCP).**
- `task_add {tasks: [...]}`: create tasks. The origin is this Session. Permission kind `state`. Only when the user asks or agrees.
- `task_update {id, ...}`: change status, title, body, priority, due or parent. Kind `state`. It works only on tasks created in this Session or linked to it. For other tasks it refuses and tells the Agent to ask the user.
- `task_list {scope?, status?, query?}` and `task_get {id}`: kind `read`.
- There is no delete tool.
- The Agent reads the Session Note (`harness_info` gives `note_path`). It does not write it.
- The tool descriptions and `prompts/harness.md` (ADR 0014) say that tasks are the user's work items and that the Agent keeps its own steps in its todo or plan tool.

**Start Session from a task** (ADR 0014). `CreateSession` takes an optional `task` with the parts of context to include and an optional status to set. The core links the Session to the task, sets the status, stores `task_id` in the Session meta, and builds the context text into the first-prompt seed. The Harness Context names the task so the Agent can update its status.

**Concurrency: last write wins**, except the task body and the note. They carry `base_updated_ms` or `base_hash`, and a write fails with a conflict when the value changed. Deleting a task writes the children first and the deleted task last, so a retry after a crash finishes the job.

**Not in v1.** Inline images in the note or body (an asset strip is below the editor). Manual ordering by drag. An Agent tool to delete tasks or write the note. Tasks in the Quick Overlay.

**Decided no.** A status set when a Session starts from a task is not reverted when that Session ends.

**Consequences.** Replay shows tasks and notes as they are now. Deleting a Session keeps its tasks. The name "task" is also used by Claude's own todo tools, so the tool text must keep the two apart. This is checked in a smoke run with Claude and Codex.
