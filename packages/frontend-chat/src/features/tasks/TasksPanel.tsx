import {
   errText,
   localDay,
   type SessionApi,
   type TaskStatus,
   type TaskSummary,
   topicProgress,
} from "@harness/api";
import { Button, ScrollArea, Tooltip } from "@harness/ui";
import { ChevronDown, ChevronRight, MoveUpRight } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { useNow } from "../../lib/time";
import type { PanelCtx } from "../../panels/contract";
import { PanelHeader } from "../../panels/PanelHeader";
import { splitDone } from "./listModel";
import { NoteEditor } from "./NoteEditor";
import { QuickAdd } from "./QuickAdd";
import { TaskRow } from "./TaskRow";

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

/** The vertical guide of each level above a nested row, and the tick into its status icon. */
function Guides({ depth }: { depth: number }) {
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
            className="absolute top-[17px] h-px bg-border"
            style={{ left: x(depth - 1), width: INDENT - 10 }}
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
 * created here, the closed ones folded under Done, then the Session Note. In each group a subtask sits under its
 * parent (when the parent is in that group too); a done subtask of an open parent goes to Done with a parent chip.
 */
export function TasksPanel({
   api,
   tasks,
   pinned,
   created,
   host,
   onOpen,
}: {
   api: SessionApi;
   /** All tasks (null while loading): parents and subtask counts. */
   tasks: readonly TaskSummary[] | null;
   pinned: TaskSummary | null;
   created: readonly TaskSummary[];
   host: PanelCtx["host"];
   onOpen: (id: string) => void;
}) {
   const [showCreated, setShowCreated] = useState(true);
   const [showDone, setShowDone] = useState(false);
   const [error, setError] = useState<string | null>(null);
   const today = localDay(new Date(useNow()));
   const all = tasks ?? [];
   const byId = useMemo(() => new Map((tasks ?? []).map((t) => [t.id, t])), [tasks]);
   const { open, closed } = useMemo(() => splitDone(created), [created]);

   const setStatus = (id: string, status: TaskStatus) => {
      setError(null);
      api.updateTask(id, { status }).catch((e) => setError(errText(e)));
   };
   const row = (t: TaskSummary, nested = false) => (
      <TaskRow
         key={t.id}
         task={t}
         parent={!nested && t.parent_id ? (byId.get(t.parent_id) ?? null) : null}
         progress={all.some((x) => x.parent_id === t.id) ? topicProgress(all, t.id) : null}
         today={today}
         sessionId={api.sessionId}
         onOpen={() => onOpen(t.id)}
         onStatus={(s) => setStatus(t.id, s)}
      />
   );
   /** A group's rows, subtasks indented under their parent when it is in the same group. */
   const rows = (list: readonly TaskSummary[]) =>
      nestRows(list).map(({ task: t, depth }) =>
         depth === 0 ? (
            row(t)
         ) : (
            <div key={t.id} className="relative" style={{ paddingLeft: depth * INDENT }}>
               <Guides depth={depth} />
               {row(t, true)}
            </div>
         ),
      );

   return (
      <div className="flex h-full min-h-0 flex-col">
         <PanelHeader title="Tasks & Notes">
            <span className="flex-1" />
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
         <ScrollArea className="min-h-0 flex-1">
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
            <div className="mt-2 border-t">
               <NoteEditor key={api.sessionId} api={api} />
            </div>
         </ScrollArea>
      </div>
   );
}
