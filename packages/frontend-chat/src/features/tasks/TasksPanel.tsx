import {
   errText,
   isOpen,
   localDay,
   openBlockers,
   type SessionApi,
   storedValue,
   type TaskStatus,
   type TaskSummary,
   topicProgress,
   useStoredValue,
} from "@harness/api";
import { Button, ScrollArea, Tooltip } from "@harness/ui";
import {
   ChevronDown,
   ChevronRight,
   List,
   ListChevronsDownUp,
   MoveUpRight,
   Workflow,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Segmented } from "../../lib/Segmented";
import { useNow } from "../../lib/time";
import type { PanelCtx } from "../../panels/contract";
import { PanelHeader } from "../../panels/PanelHeader";
import { GraphView } from "./GraphView";
import { GroupByMenu, groupByStore } from "./GroupByMenu";
import { graphGroup, splitDone } from "./listModel";
import { NoteDock } from "./NoteDock";
import { QuickAdd } from "./QuickAdd";
import { TaskHoverCard } from "./TaskHoverCard";
import { TaskRow } from "./TaskRow";
import { sheetSpace, TaskSheet, underSheet, useHeight } from "./TaskSheet";

type Density = "detail" | "condensed";

/** Rows with their facts under the title (detail) or one line each (condensed); per window. */
const densityStore = storedValue<Density>({
   key: "harness.tasks.panelDensity",
   scope: "app",
   parse: (raw) => (raw === "condensed" ? "condensed" : "detail"),
   serialize: (v) => v,
   sync: false,
});

type PanelView = "list" | "graph";

/** The panel's List / Graph switch, per window. */
const viewStore = storedValue<PanelView>({
   key: "harness.tasks.panelView",
   scope: "app",
   parse: (raw) => (raw === "graph" ? "graph" : "list"),
   serialize: (v) => v,
   sync: false,
});

/** Pixels per nesting level. */
const INDENT = 18;
/** The middle of a row's status icon, from the row's left edge (`px-2` plus half the 20 px button). */
const ICON_X = 18;

/**
 * `tasks` (sorted) as rows, each subtask right under its parent when the parent is in `tasks` too (any depth);
 * a task whose parent is not there (closed, or created in another Session) stays at the top level.
 */
function nestRows<T extends Pick<TaskSummary, "id" | "parent_id">>(
   tasks: readonly T[],
): { task: T; depth: number }[] {
   const ids = new Set(tasks.map((t) => t.id));
   const kids = new Map<string, T[]>();
   for (const t of tasks)
      if (t.parent_id && ids.has(t.parent_id) && t.parent_id !== t.id)
         kids.set(t.parent_id, [...(kids.get(t.parent_id) ?? []), t]);
   const out: { task: T; depth: number }[] = [];
   const seen = new Set<string>();
   const walk = (t: T, depth: number) => {
      if (seen.has(t.id)) return;
      seen.add(t.id);
      out.push({ task: t, depth });
      for (const k of kids.get(t.id) ?? []) walk(k, depth + 1);
   };
   for (const t of tasks) if (!t.parent_id || !ids.has(t.parent_id)) walk(t, 0);
   // A loop of parents has no top: show what is left at the top level.
   for (const t of tasks) walk(t, 0);
   return out;
}

/** The vertical guide of each level above a nested row, and the tick into its status icon (`top`: its middle). */
function Guides({ depth, top }: { depth: number; top: number }) {
   const x = (level: number) => level * INDENT + ICON_X;
   return (
      <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0">
         {Array.from({ length: depth }, (_, i) => (
            <span
               // biome-ignore lint/suspicious/noArrayIndexKey: one line per level, fixed order
               key={i}
               className="absolute inset-y-0 w-px bg-border"
               style={{ left: x(i) }}
            />
         ))}
         <span
            className="absolute h-px bg-border"
            style={{ top, left: x(depth - 1), width: INDENT - 10 }}
         />
      </span>
   );
}

/** A section heading that folds its rows. */
function Group({
   label,
   open,
   onToggle,
   children,
}: {
   label: string;
   open: boolean;
   onToggle: () => void;
   children: ReactNode;
}) {
   const Chevron = open ? ChevronDown : ChevronRight;
   return (
      <section aria-label={label}>
         <button
            type="button"
            aria-expanded={open}
            onClick={onToggle}
            className="flex w-full items-center gap-1.5 px-3.5 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground"
         >
            <Chevron className="size-3" />
            {label}
         </button>
         {open && <div className="flex flex-col px-1.5">{children}</div>}
      </section>
   );
}

/**
 * The panel's list (board "Main"): the task this Session was started from (pinned), quick add, the open tasks
 * created here and the closed ones folded under Done, scrolling above the Session Note docked at the bottom. In each
 * group a subtask sits under its parent (when the parent is in that group too); a done subtask of an open parent goes
 * to Done with a parent chip. Rows show in detail or condensed (a header toggle); hovering one shows its summary.
 *
 * A click on a row or card opens the task in a sheet that floats above the note bar (board "PanelTaskOpen"); the
 * tasks run on behind it, with room at their end to scroll each one above it. The open task is selected and brought
 * into view above the sheet; Esc or its X closes it. While it is open the note is folded; closing it brings the note
 * back as it was.
 */
export function TasksPanel({
   api,
   tasks,
   pinned,
   created,
   host,
   openId,
   onOpen,
}: {
   api: SessionApi;
   /** All tasks (null while loading): parents and subtask counts. */
   tasks: readonly TaskSummary[] | null;
   pinned: TaskSummary | null;
   created: readonly TaskSummary[];
   host: PanelCtx["host"];
   /** The task open in the sheet; null: none. */
   openId: string | null;
   onOpen: (id: string | null) => void;
}) {
   const [showCreated, setShowCreated] = useState(true);
   const [showDone, setShowDone] = useState(false);
   const [error, setError] = useState<string | null>(null);
   const condensed = useStoredValue(densityStore) === "condensed";
   const view = useStoredValue(viewStore);
   const today = localDay(new Date(useNow()));
   const all = tasks ?? [];
   const byId = useMemo(() => new Map((tasks ?? []).map((t) => [t.id, t])), [tasks]);
   const { open, closed } = useMemo(() => splitDone(created), [created]);

   const setStatus = (id: string, status: TaskStatus) => {
      setError(null);
      api.updateTask(id, { status }).catch((e) => setError(errText(e)));
   };
   /** A row with its hover summary; `depth` > 0: indented under its parent, which is shown above it. */
   const row = (t: TaskSummary, depth = 0) => {
      const parent = t.parent_id ? (byId.get(t.parent_id) ?? null) : null;
      const progress = all.some((x) => x.parent_id === t.id) ? topicProgress(all, t.id) : null;
      const line = (
         <TaskRow
            task={t}
            parent={depth === 0 ? parent : null}
            progress={progress}
            waitsOn={t.deps.length > 0 ? openBlockers(all, t.id) : 0}
            today={today}
            sessionId={api.sessionId}
            sessions={host.sessions}
            condensed={condensed}
            selected={t.id === openId}
            onOpen={() => onOpen(t.id)}
            onStatus={(s) => setStatus(t.id, s)}
         />
      );
      return (
         <TaskHoverCard
            key={t.id}
            api={api}
            task={t}
            parent={parent}
            progress={progress}
            today={today}
            sessions={host.sessions}
         >
            {depth === 0 ? (
               <div>{line}</div>
            ) : (
               <div className="relative" style={{ paddingLeft: depth * INDENT }}>
                  <Guides depth={depth} top={condensed ? 14 : 17} />
                  {line}
               </div>
            )}
         </TaskHoverCard>
      );
   };
   /** A group's rows, subtasks indented under their parent when it is in the same group. */
   const rows = (list: readonly TaskSummary[]) =>
      nestRows(list).map(({ task: t, depth }) => row(t, depth));

   // The open task's row or card in view above the sheet (the scroll areas keep `space` free with scroll-padding),
   // again when the space changes (the note folds as the sheet opens, the sheet resizes) or the view switches. The
   // tasks come before the sheet, so the first selected element is theirs.
   const body = useRef<HTMLDivElement>(null);
   const room = useHeight(body);
   const [sheetHeight, setSheetHeight] = useState(0);
   const space = openId ? sheetSpace(sheetHeight) : 0;
   // biome-ignore lint/correctness/useExhaustiveDependencies: `view`: the other view's row or card.
   useEffect(() => {
      if (!openId || !room || !space) return;
      body.current
         ?.querySelector<HTMLElement>('[aria-current="true"]')
         ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
   }, [openId, room, space, view]);

   return (
      <div
         className="flex h-full min-h-0 flex-col"
         onKeyDown={(e) => {
            // Menus, dialogs and tooltips take their own Esc first (and mark it handled).
            if (e.key !== "Escape" || !openId || e.defaultPrevented) return;
            e.preventDefault();
            onOpen(null);
         }}
      >
         <PanelHeader title="Tasks & Notes">
            <span className="flex-1" />
            <Segmented
               value={view}
               onChange={(v) => viewStore.set(v)}
               label="View"
               className="[&>button]:h-6 [&>button]:px-1.5"
               items={[
                  {
                     value: "list",
                     label: (
                        <>
                           <List className="size-3.5" />
                           <span className="sr-only">List</span>
                        </>
                     ),
                  },
                  {
                     value: "graph",
                     label: (
                        <>
                           <Workflow className="size-3.5" />
                           <span className="sr-only">Graph</span>
                        </>
                     ),
                  },
               ]}
            />
            <Tooltip content={condensed ? "Show details" : "Condensed list"} side="bottom">
               <Button
                  size="icon"
                  variant={condensed ? "secondary" : "ghost"}
                  className="size-7 shrink-0"
                  aria-label="Condensed list"
                  aria-pressed={condensed}
                  onClick={() => densityStore.set(condensed ? "detail" : "condensed")}
               >
                  <ListChevronsDownUp />
               </Button>
            </Tooltip>
            {host.openTasks && (
               <Tooltip content="Open all tasks" side="bottom">
                  <Button
                     size="icon"
                     variant="ghost"
                     className="size-7 shrink-0"
                     aria-label="Open all tasks"
                     onClick={() => host.openTasks?.()}
                  >
                     <MoveUpRight />
                  </Button>
               </Tooltip>
            )}
         </PanelHeader>
         <div ref={body} data-tasks-body className="relative flex min-h-0 flex-1 flex-col">
            {view === "graph" ? (
               <PanelGraph
                  api={api}
                  tasks={tasks}
                  pinned={pinned}
                  created={created}
                  condensed={condensed}
                  today={today}
                  host={host}
                  selected={openId}
                  onOpen={onOpen}
                  space={space}
               />
            ) : (
               <ScrollArea className="min-h-0 flex-1" {...underSheet(space)}>
                  {pinned && (
                     <section aria-label="Started from" className="px-2.5 pt-2.5">
                        <div className="px-1 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                           Started from
                        </div>
                        <div className="rounded-lg border bg-card">{row(pinned)}</div>
                     </section>
                  )}
                  <QuickAdd
                     className="px-2.5 pb-1 pt-2.5"
                     label="Add task"
                     placeholder="Add task… Markdown ok"
                     onAdd={(title) => api.createTask({ title })}
                  />
                  {error && (
                     <div role="alert" className="px-3.5 pt-1 text-xs text-destructive">
                        {error}
                     </div>
                  )}
                  <Group
                     label={`Created here · ${open.length}`}
                     open={showCreated}
                     onToggle={() => setShowCreated((o) => !o)}
                  >
                     {tasks && open.length === 0 && (
                        <p className="px-2 py-1 text-xs text-muted-foreground/70">
                           {closed.length ? "All done." : "No tasks created in this Session yet."}
                        </p>
                     )}
                     {rows(open)}
                  </Group>
                  {closed.length > 0 && (
                     <Group
                        label={`Done · ${closed.length}`}
                        open={showDone}
                        onToggle={() => setShowDone((o) => !o)}
                     >
                        {rows(closed)}
                     </Group>
                  )}
                  <div data-sheet-spacer style={{ height: Math.max(8, space) }} />
               </ScrollArea>
            )}
            {openId && (
               <TaskSheet
                  api={api}
                  id={openId}
                  tasks={tasks}
                  host={host}
                  room={room}
                  onHeight={setSheetHeight}
                  onClose={() => onOpen(null)}
                  onOpen={onOpen}
               />
            )}
         </div>
         <NoteDock api={api} taskOpen={openId !== null} onOpenNote={() => onOpen(null)} />
      </div>
   );
}

/**
 * The panel's Graph view (board "Panel"): this Session's open tasks (pinned and created here) as a graph, lanes
 * by the All tasks group-by. Open tasks of other Sessions that they wait on show as dashed cards; a click on one
 * opens All tasks at it.
 */
function PanelGraph({
   api,
   tasks,
   pinned,
   created,
   condensed,
   today,
   host,
   selected,
   onOpen,
   space,
}: {
   api: SessionApi;
   tasks: readonly TaskSummary[] | null;
   pinned: TaskSummary | null;
   created: readonly TaskSummary[];
   condensed: boolean;
   today: string;
   host: PanelCtx["host"];
   selected: string | null;
   onOpen: (id: string) => void;
   /** The space the task sheet covers at the bottom (`sheetSpace`). */
   space: number;
}) {
   const all = tasks ?? EMPTY;
   const groupBy = useStoredValue(groupByStore);
   const shown = useMemo(
      () => [...(pinned ? [pinned] : []), ...created].filter((t) => isOpen(t.status)),
      [pinned, created],
   );
   const outside = useMemo(() => {
      const here = new Set(shown.map((t) => t.id));
      const ids = new Set(
         shown.flatMap((t) => t.deps.filter((d) => d.kind === "blocks").map((d) => d.id)),
      );
      return all.filter((t) => ids.has(t.id) && !here.has(t.id) && isOpen(t.status));
   }, [all, shown]);
   const sessions = host.sessions;
   const lanes = useMemo(
      () =>
         graphGroup(all, groupBy, (id) => {
            const t = all.find((x) => x.origin_session_id === id);
            return sessions?.get(id)?.title ?? t?.origin_title ?? "Session";
         }),
      [all, groupBy, sessions],
   );
   return (
      <div className="flex min-h-0 flex-1 flex-col">
         <QuickAdd
            className="px-2.5 pb-1 pt-2.5"
            label="Add task"
            placeholder="Add task… Markdown ok"
            onAdd={(title) => api.createTask({ title })}
         />
         <div className="flex shrink-0 items-center gap-2 border-b px-3 pb-2 pt-1 text-xs text-muted-foreground">
            <GroupByMenu value={groupBy} tasks={all} prefix="Group: " className="h-6 text-xs" />
            <span className="flex-1" />
            <span className="truncate">
               {shown.length} open{outside.length > 0 && ` · ${outside.length} outside`}
            </span>
         </div>
         <GraphView
            tasks={shown}
            all={all}
            outside={outside}
            groupBy={lanes}
            density={condensed ? "condensed" : "detail"}
            selected={selected}
            today={today}
            sessions={sessions}
            onOpen={onOpen}
            onOpenOutside={host.openTasks}
            bottomSpace={space}
            empty={
               <p className="px-3.5 py-3 text-xs text-muted-foreground/70">
                  {tasks ? "No open tasks in this Session." : "Loading…"}
               </p>
            }
         />
      </div>
   );
}

const EMPTY: readonly TaskSummary[] = [];
