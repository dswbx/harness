# Task dependencies and properties, shown as a graph

Tasks (ADR 0028) have one relation: the parent. Users also need to say "this task waits on that one" and "do that one after this one". They also want to group tasks by their own words ("component: spark-platform"), not only by topic, status or Session. A tree cannot show this. A graph with lines between cards can. Plan: `docs/plans/task-graph.md`.

**Decision:** two new task fields, and a Graph view in All tasks and in the Tasks & Notes panel.

**Dependencies.** A task has `deps: Vec<TaskDep>`, and each `TaskDep` is `{ id, kind }`. `kind` is `blocks` or `follow_up`.
- `blocks`: this task cannot be done before the other one.
- `follow_up`: this task comes after the other one, but does not wait on it.
- A dependency is stored only on the task that waits. "Blocks" (the other direction) is derived in `@harness/api`.
- The core refuses a dependency that makes a loop, of either kind, and an id that does not exist.
- Deleting a task removes its id from the `deps` of other tasks. Those tasks are written first and the deleted task last, as for children (ADR 0028).

**Properties.** A task has `props: BTreeMap<String, String>`, for example `{ "component": "spark-platform" }`.
- Keys are 1 to 32 characters of `a-z`, `0-9`, `_` and `-`. Values are 1 to 64 characters on one line. A task has at most 16 props.
- Props are free text. There is no schema of keys and no list of allowed values.

**Storage.** Both fields go in `task.json` with `serde(default)`, so old files load as before. There is no migration (ADR 0028). Both fields are in `TaskSummary`, so a view gets all lines from the one task list.

**Description excerpt.** `TaskSummary` also gets `excerpt`: the start of the body as plain text, at most 160 characters. The core builds it, because a summary has no body. Cards show it under the title, so a card needs no separate subtitle field.

**"Blocked" is derived, not stored.** A task with open `blocks` deps shows "waits on N". The stored status does not change. A user can still set the status `blocked` for other reasons.

**Agent tools.** `task_add` and `task_update` take `deps: { add: [{ id, kind? }], remove: [id] }` and `props: { key: value | null }` (null removes a key). The `ensure_own` rule (ADR 0028) is unchanged. A dependency is written only on the waiting task, so the Agent can make its own task wait on any task. `task_get` returns `blocked_by`, `blocks` and `waits_on`.

**Graph layout is our own code, with no library.**
- The layout must fit a given width: 2 columns in a narrow panel, a timeline in a wide window. It must also put each group in its own band. Generic layered layout (elkjs, dagre) chooses its own width and does not keep groups as bands.
- The layout is a pure function in `packages/frontend-chat`, tested like `treeLayout.ts`. Lines go through the gaps between cards, so a line never crosses a card.
- Revisit when graphs pass about 300 tasks or crossings become hard to read. Then try elkjs in a Web Worker.

**Grouping by a prop is Frontend logic** (ADR 0012). Each Frontend can group in its own way. The List view and the Graph view use the same group-by menu.

**Not in v1.** Drag on the graph to move a task to another group. Dependencies between a task and a Session. Typed props (dates, numbers). Filter by prop in `task_list`.

**Consequences.** One task can now point to tasks in other topics and Sessions. The panel shows only its Session's tasks, so it also shows outside blockers as dashed cards. Old Harness versions drop the two fields when they write a task again.
