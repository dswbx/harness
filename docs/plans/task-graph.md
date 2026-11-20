# Task graph plan

Status: accepted (2026-11-20). Unresolved questions use the suggested answers. ADR 0029 (Task dependencies and properties) and the glossary entries must exist before step 2 merges.

**Directories:**
- `crates/harness-core`: `api/tasks.rs`, `tasks.rs`, `host/dispatch/tasks.rs`, `mcp/tools.rs`, `mcp/task_tools.rs`, `prompts/harness.md`, tests.
- `packages/api`: `generated.ts` (gen-ts), `derive/tasks.ts`, mock data.
- `packages/frontend-chat`: `features/tasks/*` (new `graphLayout.ts`, `GraphView.tsx`, `DepPicker.tsx`, `PropsField.tsx`).
- `packages/ui`: only if a shadcn primitive is missing (Command, Popover).
- `docs/`: ADR 0029, GLOSSARY, this plan.

Design: canvas https://claude.ai/artifact/K1M2HSFpFXGFhdmM6bmhpr. Its boards:
- Main: All tasks, Graph view, grouped by `component`, one task selected.
- Preview: the task preview with Properties, Blocked by, Blocks and the blocker picker.
- Interactions: the group-by menu and drag to link.
- Panel: the Tasks & Notes panel in Graph view, 440 px wide.

## Context

Facts from the code (2026-11-20):
- **Task model** is `Task` in `crates/harness-core/src/api/tasks.rs:88`. The only relation is `parent_id` with `order`. New fields use `serde(default)`; there are no migrations.
- **Store** is `crates/harness-core/src/tasks.rs`. `move_to` refuses parent loops (`descends_from`, line 430). Delete moves children to the parent and writes the deleted task last (line 283).
- **Agent tools** are in `mcp/tools.rs:170-220` (schemas) and `mcp/task_tools.rs` (handlers). `ensure_own` (line 85) limits writes to tasks of this Session. Known defect H15 (`docs/hygiene/ledger.md:140`): `task_update` does not check `parent` against the schema.
- **Views**: `TasksView.tsx` has `ViewMode = "list" | "tree"` (line 58) and a group-by of `topic | status | session` (`listModel.ts:197`). `TreeView.tsx` places HTML cards absolutely and draws lines in one SVG. `treeLayout.ts` is the pure layout, tested in `treeLayout.test.ts`.
- **Panel**: `TasksPanel.tsx` has a density store (`detail | condensed`) and shows this Session's tasks.
- **Rules** (AGENTS.md): use `ScrollArea` for scrolling, shadcn primitives from `@harness/ui`, `storedValue` for web storage. Mock data and tests use made-up names only.

## The layout (responsive)

`layoutGraph(tasks, { width, groupBy, density, focus })` in `graphLayout.ts` is a pure function. It gives cards, lane bands, lines and the total size.

1. **Rank.** A task's rank is the longest path of deps to it (both kinds). Tasks with no deps have rank 0. Deps to tasks that are not shown are dropped from the rank. They show as dashed "outside" cards next to the task (panel only).
2. **Lanes.** One lane per group value. Lanes are sorted by their lowest rank, then by name. Tasks without the key go to a last lane, "No <key>".
3. **Columns from the width.** Sizes: `CARD_MIN 176`, `CARD_MAX 248`, `GAP 32`, `PAD 12`. `cols = floor((width - 2*PAD + GAP) / (CARD_MIN + GAP))`, at least 2.
4. **Two modes, chosen by space:**
   - **Aligned** when `cols >= ranks`. Lanes are horizontal bands. A task's column is its rank, the same in every lane, so lines go left to right. Two tasks of one rank in one lane stack. This is the Main board.
   - **Flow** when `cols < ranks`. Lanes are sections, one under the other, each with a heading. Inside a section, tasks sorted by rank fill rows of `cols` cards, left to right. Lines go right or down. This is the Panel board.
5. **Card width** fills the space: `(width - 2*PAD - (cols-1)*GAP) / cols`, at most `CARD_MAX`. In aligned mode, extra space goes to both sides.
6. **Card height** follows the panel density store: condensed 48 px (status, title, one meta line), detail 64 px (adds one line of the description excerpt between title and meta).
7. **Minimum width** is 2 cards: `2*CARD_MIN + GAP + 2*PAD = 408` px. A narrower container lays out at 408 px and scrolls sideways in its `ScrollArea`. A tall graph scrolls down.
8. **Order inside a lane** reduces crossings: 2 sweeps of the barycenter rule (sort by the mean position of linked cards), with ties by `order`. The result is the same for the same input.
9. **Lines** never cross a card. Each line goes from the source's out side to a gap, along gaps, and into the target's in side. Lines in one gap get their own track (4 px apart). Corners are rounded (6 px). Out and in points spread along a card side when it has more than one line.
10. **Width changes.** A `ResizeObserver` gives the width, rounded to 8 px, once per animation frame. Cards move with a 150 ms transform transition, but not under `prefers-reduced-motion` and not when the mode changes.

## Steps

Each step is one PR with tests. Run `bun run check:rust`, `bun run typecheck` and `bun run test` before each merge.

1. **Docs.** ADR 0029. GLOSSARY: **Dependency** (a task waits on, or follows, another task; kinds blocks and follow-up; _Avoid_: edge, relation, link) and **Property** (a free key-value pair on a task; _Avoid_: label, tag, custom field). This plan.
2. **Core model** (`api/tasks.rs`, `tasks.rs`, dispatch).
   - `TaskDepKind { Blocks, FollowUp }`, `TaskDep { id, kind }`, `Task.deps`, `Task.props`, both in `TaskSummary`.
   - `TaskSummary.excerpt`: the start of the body as plain text, built next to `has_body` (`api/tasks.rs:152`). Markdown marks are removed, code blocks and images are skipped, white space is joined, and the text is cut at a word to at most 160 characters with "…". Empty when the body is empty.
   - `TaskPatch.deps: Option<Vec<TaskDep>>` (replace) and `TaskPatch.props: Option<BTreeMap<String, String>>` (replace).
   - Checks in `tasks.rs`: ids exist, no self dep, no loop (a walk over deps like `descends_from`), no duplicate ids, prop key and value rules from ADR 0029.
   - Delete removes the id from other tasks' deps, then writes the deleted task last.
   - Activity: `DepAdded { id, kind }`, `DepRemoved { id }`, `PropsChanged`.
   - `bun run gen-ts`.
   - Tests: an old `task.json` loads, a loop is refused, delete cleans deps, a bad prop key is refused, the excerpt of a body with a heading, a list, a link and a code block.
3. **Agent tools** (`mcp/tools.rs`, `task_tools.rs`, `prompts/harness.md`).
   - `task_add` and `task_update`: `deps { add: [{ id, kind? }], remove: [id] }`, `props { key: value | null }`. Default kind: `blocks`.
   - `task_get`: `blocked_by`, `blocks`, `waits_on`. `task_list` rows: `waits_on` when above 0.
   - Check input types against the schema, and fix H15 while there.
   - One line in `harness.md`: use deps for order between tasks and props for grouping.
   - Tests in `tests/mcp.rs`.
4. **`@harness/api`** (`derive/tasks.ts`, mock).
   - `blockedBy`, `blocks`, `openBlockers` (waits on N), `wouldLoop(tasks, from, to)`, `propKeys(tasks)`.
   - Mock tasks with made-up deps and props, for the browser mock.
5. **List view and preview.**
   - Group by any prop key: `GroupBy` becomes `"topic" | "status" | "session" | { prop: string }`. The menu lists the fields, then the prop keys in use.
   - `TaskRow`: a "waits on N" chip.
   - `TaskDetail`: Properties (`PropsField`), Blocked by, Blocks. `DepPicker` (Popover + Command) searches tasks, offers blocks or follow-up, and disables a task that would make a loop.
6. **`graphLayout.ts`** with `graphLayout.test.ts`.
   - Tests: ranks; lane order; mode at widths 408, 440, 660 and 1440; no line segment inside a card; no two lines on one track; the same output for the same input; layout at 408 px when the width is 300.
7. **Graph view in All tasks** (`GraphView.tsx`, `TasksView.tsx`).
   - `ViewMode` gets `"graph"` (update the stored value parser).
   - The selected task's direct lines turn blue. Its whole chain stays. Other cards fade.
   - The floating preview from the Tree view.
   - Toolbar: a Lines menu (blocks, follow-ups, parent lines off by default).
8. **Graph view in the panel** (`TasksPanel.tsx`).
   - A List / Graph switch in the panel header, stored per window with `storedValue`.
   - Only this Session's tasks. Outside blockers as dashed cards. A click on one opens All tasks at that task.
   - Hover shows the card's lines in blue. Click opens the task as in the List view.
9. **Drag to link** (can wait).
   - A dot on the card's out side. Drag it onto a card to add a `blocks` dep, with Alt for `follow_up`. A loop target shows "would make a loop".
   - Same pointer code style as `useNestDrag.ts`.
   - The keyboard path is the preview's Blocked by section.

After steps 7 and 8: open the browser mock (`app-alt-port`), check All tasks and the panel at 300, 440, 660 and 1440 px, and check the console.

## Unresolved questions

1. Rank by follow-up deps too, or only blocks? Suggest: both, so follow-ups sit to the right.
2. Parent lines in the graph: off by default with a toggle, or never? Suggest: toggle, off.
3. Props in `task_list` filter now? Suggest: no, wait for a need.
4. Risk/watch: a prop or a status? Suggest: prop (`risk: yes`).
5. Drag to link (step 9) in v1? Suggest: after the rest ships.
