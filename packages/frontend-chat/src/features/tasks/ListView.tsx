import {
   isOpen,
   type SessionStatus,
   type TaskStatus,
   type TaskSummary,
   topicProgress,
} from "@harness/api";
import {
   Button,
   cn,
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuLabel,
   DropdownMenuSeparator,
   DropdownMenuTrigger,
   ScrollArea,
} from "@harness/ui";
import {
   ArrowUpToLine,
   ChevronDown,
   CornerDownRight,
   GripVertical,
   Link2,
   MessageSquare,
   MoreHorizontal,
   Play,
   Plus,
} from "lucide-react";
import { type PointerEvent, type ReactNode, useMemo, useState } from "react";
import { InlineMarkdown } from "../markdown/InlineMarkdown";
import { META_CHIP } from "./chips";
import { dayDate, dueTone } from "./DuePicker";
import { canNest, type GroupBy, type ListRow, moveTargets, type TaskList } from "./listModel";
import { PriorityIcon } from "./PriorityMenu";
import { STATUS_LABEL, StatusMenu } from "./StatusMenu";
import { upstreamText } from "./UpstreamField";
import { useNestDrag } from "./useNestDrag";

export type SessionInfo = { title: string; status?: SessionStatus };

/** What a row can do; the view runs it. */
export type ListActions = {
   select: (id: string) => void;
   /** Folds or unfolds a task's subtasks (its id) or a group (`group:<key>`). */
   toggle: (key: string) => void;
   status: (id: string, status: TaskStatus) => void;
   /** Puts the task under `parent` (null: the top level). */
   move: (id: string, parent: string | null) => void;
   /** Asks for a topic name, then puts the task under the new topic. */
   newTopic: (task: TaskSummary) => void;
   startFromTask?: (id: string) => void;
   openSession: (sessionId: string) => void;
};

/**
 * Title, priority, due, origin Session, upstream, menu. Narrow (a preview open, a small window): the origin
 * Session goes first, then the upstream.
 */
const COLS = cn(
   "grid items-center gap-x-3 px-4",
   "grid-cols-[minmax(0,1fr)_1.5rem_4rem_1.75rem]",
   "@xl:grid-cols-[minmax(0,1fr)_1.5rem_4rem_5rem_1.75rem]",
   "@3xl:grid-cols-[minmax(0,1fr)_1.5rem_4rem_12rem_5rem_1.75rem]",
);
/** Indent per level, px. */
const INDENT = 20;

const DOT: Record<SessionStatus, string> = {
   working: "bg-sky-500",
   needs_attention: "bg-amber-500",
   idle: "bg-muted-foreground/40",
};

/** `Nov 23` (with the year when it is not this year's). */
function shortDue(day: string, today: string): string {
   const sameYear = day.slice(0, 4) === today.slice(0, 4);
   return dayDate(day).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      ...(sameYear ? {} : { year: "numeric" }),
   });
}

/**
 * The All tasks list (board "AllTasks"): column header, then the groups. By topic each topic heads its group,
 * with its subtasks indented on guide lines; then "No topic". Closed tasks fold into a group at the end. A row
 * dragged onto another row (or onto "No topic") moves there.
 */
export function ListView({
   tasks,
   list,
   groupBy,
   selected,
   today,
   sessions,
   actions,
   top,
   empty,
}: {
   tasks: readonly TaskSummary[];
   list: TaskList<TaskSummary>;
   groupBy: GroupBy;
   selected: string | null;
   today: string;
   sessions: ReadonlyMap<string, SessionInfo>;
   actions: ListActions;
   /** Above the groups (the New task line). */
   top?: ReactNode;
   /** Shown when no group and no closed task shows. */
   empty: ReactNode;
}) {
   const [closedOpen, setClosedOpen] = useState(false);
   const { drag, start } = useNestDrag(actions.move, (id, target) => canNest(tasks, id, target));
   const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
   const line = (row: ListRow<TaskSummary>, topic = false) => (
      <TaskLine
         key={row.task.id}
         row={row}
         topic={topic}
         foldable={groupBy === "topic" && row.kids > 0}
         tasks={tasks}
         selected={row.task.id === selected}
         dragging={drag?.id === row.task.id}
         dropping={drag?.target === row.task.id}
         today={today}
         sessions={sessions}
         actions={actions}
         onPointerDown={(e) => start(row.task.id, e)}
      />
   );
   const nothing = list.groups.length === 0 && list.closed.length === 0;

   return (
      <div className="@container relative flex min-h-0 min-w-0 flex-1 flex-col">
         <div
            className={cn(
               COLS,
               "h-8 shrink-0 border-b text-[11px] font-medium tracking-wide text-muted-foreground uppercase",
            )}
         >
            <span className="pl-[22px]">Title</span>
            <span>Pri</span>
            <span>Due</span>
            <span className="hidden @3xl:block">Created in</span>
            <span className="hidden @xl:block">Upstream</span>
            <span />
         </div>
         <ScrollArea className="min-h-0 flex-1">
            {top}
            {nothing && !top && empty}
            {list.groups.map((g) =>
               g.head ? (
                  <section key={g.key} aria-label={`Topic ${g.label}`}>
                     {line(g.head, true)}
                     {g.rows.map((r) => line(r))}
                  </section>
               ) : (
                  <section key={g.key} aria-label={groupLabel(groupBy, g.key, g.label)}>
                     <GroupHeader
                        label={groupLabel(groupBy, g.key, g.label)}
                        count={g.count}
                        folded={g.folded}
                        hint={
                           groupBy === "topic" ? "drag a row onto a topic to nest it" : undefined
                        }
                        // "No topic" takes a dragged row to the top level.
                        nestTarget={groupBy === "topic" ? "" : undefined}
                        dropping={drag?.target === ""}
                        onToggle={() => actions.toggle(`group:${g.key}`)}
                     />
                     {g.rows.map((r) => line(r))}
                  </section>
               ),
            )}
            {list.closed.length > 0 && (
               <section aria-label="Done and cancelled">
                  <button
                     type="button"
                     aria-expanded={closedOpen}
                     onClick={() => setClosedOpen(!closedOpen)}
                     className="flex h-9 w-full items-center gap-2 px-4 text-xs text-muted-foreground hover:text-foreground"
                  >
                     <ChevronDown
                        className={cn("size-3.5 transition-transform", !closedOpen && "-rotate-90")}
                     />
                     Done and cancelled · {list.closed.length}
                  </button>
                  {closedOpen &&
                     list.closed.map((t) =>
                        line({ task: t, depth: 0, kids: 0, expanded: false, context: false }),
                     )}
               </section>
            )}
         </ScrollArea>
         {drag && (
            <div
               aria-hidden
               className="pointer-events-none fixed z-50 max-w-72 truncate rounded-md border bg-popover px-2.5 py-1 text-xs shadow-md"
               style={{ left: drag.x + 12, top: drag.y + 10 }}
            >
               {byId.get(drag.id)?.title ?? drag.id}
               {drag.target !== null && (
                  <span className="text-muted-foreground">
                     {" → "}
                     {drag.target === "" ? "Top level" : (byId.get(drag.target)?.title ?? "")}
                  </span>
               )}
            </div>
         )}
      </div>
   );
}

function groupLabel(groupBy: GroupBy, key: string, label: string): string {
   return groupBy === "status" ? (STATUS_LABEL[key as TaskStatus] ?? label) : label;
}

function GroupHeader({
   label,
   count,
   folded,
   hint,
   nestTarget,
   dropping,
   onToggle,
}: {
   label: string;
   count: number;
   folded: boolean;
   hint?: string;
   nestTarget?: string;
   dropping: boolean;
   onToggle: () => void;
}) {
   return (
      <div
         data-nest-target={nestTarget}
         className={cn(
            COLS,
            "min-h-10 border-b bg-muted/40",
            dropping &&
               "bg-sky-500/10 outline-1 -outline-offset-1 outline-sky-500/60 outline-dashed",
         )}
      >
         <button
            type="button"
            aria-expanded={!folded}
            onClick={onToggle}
            className="col-span-full flex min-w-0 items-center gap-2 text-left text-[13px]"
         >
            <ChevronDown
               className={cn(
                  "size-3.5 shrink-0 text-muted-foreground transition-transform",
                  folded && "-rotate-90",
               )}
            />
            <span className="font-semibold text-foreground/80">{label}</span>
            <span className="truncate text-[11px] text-muted-foreground">
               {count}
               {hint && ` · ${hint}`}
            </span>
         </button>
      </div>
   );
}

function TaskLine({
   row,
   topic,
   foldable,
   tasks,
   selected,
   dragging,
   dropping,
   today,
   sessions,
   actions,
   onPointerDown,
}: {
   row: ListRow<TaskSummary>;
   topic: boolean;
   /** Shows the fold button (its subtasks are rows of this list). */
   foldable: boolean;
   tasks: readonly TaskSummary[];
   selected: boolean;
   dragging: boolean;
   dropping: boolean;
   today: string;
   sessions: ReadonlyMap<string, SessionInfo>;
   actions: ListActions;
   onPointerDown: (e: PointerEvent) => void;
}) {
   const { task, depth } = row;
   const open = isOpen(task.status);
   const progress = row.kids > 0 ? topicProgress(tasks, task.id) : null;
   return (
      <div
         data-task-row={task.id}
         data-nest-target={task.id}
         aria-current={selected || undefined}
         onPointerDown={onPointerDown}
         className={cn(
            COLS,
            "group/row relative border-b border-border/50 text-[13px] hover:bg-accent/40",
            topic ? "min-h-11 bg-muted/40" : "min-h-9",
            selected &&
               "bg-sky-500/10 shadow-[inset_3px_0_0_var(--color-sky-400)] hover:bg-sky-500/15",
            dragging && "opacity-50",
            dropping &&
               "bg-sky-500/10 outline-1 -outline-offset-1 outline-sky-500/60 outline-dashed",
         )}
      >
         <div className="relative flex min-w-0 items-center gap-2 self-stretch">
            {depth > 0 && <Guides depth={depth} />}
            <span className="flex shrink-0 items-center" style={{ paddingLeft: depth * INDENT }}>
               {foldable ? (
                  <button
                     type="button"
                     aria-label={`${row.expanded ? "Fold" : "Unfold"} ${task.title}`}
                     aria-expanded={row.expanded}
                     onClick={() => actions.toggle(task.id)}
                     className="grid size-3.5 place-items-center rounded text-muted-foreground hover:text-foreground"
                  >
                     <ChevronDown
                        className={cn(
                           "size-3.5 transition-transform",
                           !row.expanded && "-rotate-90",
                        )}
                     />
                  </button>
               ) : (
                  <GripVertical className="size-3.5 text-muted-foreground/50 opacity-0 group-hover/row:opacity-100" />
               )}
            </span>
            <StatusMenu
               status={task.status}
               variant="icon"
               onChange={(s) => actions.status(task.id, s)}
            />
            <button
               type="button"
               data-drag
               onClick={() => actions.select(task.id)}
               className={cn(
                  "min-w-0 truncate text-left outline-none hover:underline hover:decoration-foreground/30 focus-visible:underline",
                  topic && "font-semibold",
                  (!open || row.context) && "text-muted-foreground",
                  !open && "line-through",
               )}
            >
               <InlineMarkdown variant="quiet">{task.title}</InlineMarkdown>
            </button>
            {progress && progress.total > 0 && (
               <span
                  className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground tabular-nums"
                  title="Subtasks done"
               >
                  {topic && (
                     <span className="h-1 w-12 overflow-hidden rounded-full bg-muted">
                        <span
                           className="block h-full bg-emerald-500"
                           style={{ width: `${(progress.done / progress.total) * 100}%` }}
                        />
                     </span>
                  )}
                  {progress.done}/{progress.total}
               </span>
            )}
            {task.sessions.length > 0 && (
               <span className={cn(META_CHIP, "shrink-0")} title="Sessions started from it">
                  <Link2 className="size-2.5" />
                  {task.sessions.length} {task.sessions.length === 1 ? "session" : "sessions"}
               </span>
            )}
         </div>
         <span className="flex">
            {task.priority !== "none" && <PriorityIcon priority={task.priority} />}
         </span>
         <span
            className={cn("truncate text-xs text-muted-foreground", dueTone(task.due, today, open))}
         >
            {task.due ? shortDue(task.due, today) : "—"}
         </span>
         <span className="hidden min-w-0 @3xl:flex">
            <Origin task={task} sessions={sessions} />
         </span>
         <span className="hidden min-w-0 truncate text-xs @xl:block">
            {task.upstream ? (
               <a
                  href={task.upstream.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sky-600 hover:underline dark:text-sky-400"
               >
                  {upstreamText(task.upstream)}
               </a>
            ) : (
               <span className="text-muted-foreground">—</span>
            )}
         </span>
         <RowMenu task={task} tasks={tasks} sessions={sessions} actions={actions} />
      </div>
   );
}

/** The vertical guide of each level above the row, and the tick into it. */
function Guides({ depth }: { depth: number }) {
   const x = (level: number) => level * INDENT + 7;
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
            className="absolute top-1/2 h-px bg-border"
            style={{ left: x(depth - 1), width: INDENT - 9 }}
         />
      </span>
   );
}

function Origin({
   task,
   sessions,
}: {
   task: TaskSummary;
   sessions: ReadonlyMap<string, SessionInfo>;
}) {
   const id = task.origin_session_id;
   if (!id) return <span className="truncate text-xs text-muted-foreground/70">No session</span>;
   const s = sessions.get(id);
   return (
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
         <span
            className={cn(
               "size-1.5 shrink-0 rounded-full",
               s ? DOT[s.status ?? "idle"] : "border border-muted-foreground/50",
            )}
         />
         <span className="truncate">
            {s ? s.title : `${task.origin_title ?? "Session"} (deleted)`}
         </span>
      </span>
   );
}

function RowMenu({
   task,
   tasks,
   sessions,
   actions,
}: {
   task: TaskSummary;
   tasks: readonly TaskSummary[];
   sessions: ReadonlyMap<string, SessionInfo>;
   actions: ListActions;
}) {
   const origin = task.origin_session_id;
   return (
      <DropdownMenu>
         <DropdownMenuTrigger asChild>
            <Button
               size="icon"
               variant="ghost"
               aria-label={`Actions for ${task.title}`}
               className="size-6 opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 data-[state=open]:bg-accent data-[state=open]:opacity-100"
            >
               <MoreHorizontal />
            </Button>
         </DropdownMenuTrigger>
         <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
               Move under…
            </DropdownMenuLabel>
            {moveTargets(tasks, task.id).map((t) => (
               <DropdownMenuItem key={t.id} onSelect={() => actions.move(task.id, t.id)}>
                  <CornerDownRight />
                  <span className="truncate">
                     <InlineMarkdown variant="quiet">{t.title}</InlineMarkdown>
                  </span>
               </DropdownMenuItem>
            ))}
            {task.parent_id && (
               <DropdownMenuItem onSelect={() => actions.move(task.id, null)}>
                  <ArrowUpToLine /> Top level
               </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => actions.newTopic(task)}>
               <Plus /> New topic from this task…
            </DropdownMenuItem>
            {(actions.startFromTask || origin) && <DropdownMenuSeparator />}
            {actions.startFromTask && (
               <DropdownMenuItem onSelect={() => actions.startFromTask?.(task.id)}>
                  <Play /> Start session with task
               </DropdownMenuItem>
            )}
            {origin && (
               <DropdownMenuItem
                  disabled={!sessions.has(origin)}
                  onSelect={() => actions.openSession(origin)}
               >
                  <MessageSquare /> Open origin session
               </DropdownMenuItem>
            )}
         </DropdownMenuContent>
      </DropdownMenu>
   );
}
