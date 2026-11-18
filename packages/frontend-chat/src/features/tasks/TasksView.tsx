import {
   errText,
   localDay,
   openCount,
   storedValue,
   type TaskListSource,
   type TaskPriority,
   type TaskSummary,
   type TasksViewProps,
   useStoredValue,
   useTasks,
} from "@harness/api";
import {
   Button,
   cn,
   Dialog,
   DialogContent,
   DialogDescription,
   DialogFooter,
   DialogHeader,
   DialogTitle,
   DropdownMenu,
   DropdownMenuCheckboxItem,
   DropdownMenuContent,
   DropdownMenuRadioGroup,
   DropdownMenuRadioItem,
   DropdownMenuSeparator,
   DropdownMenuTrigger,
   Input,
   noAutocorrect,
} from "@harness/ui";
import { ChevronDown, ListTodo, Plus, Search, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { OpenSession } from "../../lib/OpenSession";
import { Segmented } from "../../lib/Segmented";
import { useNow } from "../../lib/time";
import type { PanelCtx } from "../../panels/contract";
import { InlineMarkdown } from "../markdown/InlineMarkdown";
import { type ListActions, ListView, type SessionInfo } from "./ListView";
import {
   buildList,
   DEFAULT_FILTER,
   type DueFilter,
   type GroupBy,
   hasFilters,
   NO_SESSION,
   reveal,
   type StatusFilter,
   sessionCount,
   type TaskFilter,
} from "./listModel";
import { PreviewColumn } from "./PreviewColumn";
import { PRIORITY_LABEL } from "./PriorityMenu";
import { QuickAdd } from "./QuickAdd";
import { appTaskApi } from "./taskApi";

type ViewMode = "list" | "tree";

const viewStore = storedValue<ViewMode>({
   key: "harness.tasks.view",
   scope: "app",
   parse: (raw) => (raw === "tree" ? "tree" : "list"),
   serialize: (v) => v,
});

const STATUS_FILTER: Record<StatusFilter, string> = { open: "Open", all: "All", done: "Done" };
const DUE_FILTER: Record<DueFilter, string> = {
   any: "Any",
   overdue: "Overdue",
   today: "Due today or before",
   week: "Due this week",
   none: "No due date",
};
const GROUP_BY: Record<GroupBy, string> = { topic: "Topic", status: "Status", session: "Session" };
const PRIORITIES: TaskPriority[] = ["urgent", "high", "medium", "low", "none"];

/**
 * All tasks (ADR 0028), the host's main pane: a header with the counts, search and New task, a bar of filters,
 * group-by and the List / Tree switch, then the list with the selected task in a docked preview.
 */
export function TasksView({
   client,
   selected,
   onSelect,
   sessions,
   onOpenSession,
   onStartFromTask,
   leading,
}: TasksViewProps) {
   const api = useMemo(() => appTaskApi(client), [client]);
   const source = useMemo<TaskListSource>(
      () => ({ list: () => client.listTasks(), onChanged: (f) => client.tasksChanged(f) }),
      [client],
   );
   const tasks = useTasks(source);
   const today = localDay(new Date(useNow()));
   const view = useStoredValue(viewStore);
   const [filter, setFilter] = useState<TaskFilter>(DEFAULT_FILTER);
   const [groupBy, setGroupBy] = useState<GroupBy>("topic");
   const [flipped, setFlipped] = useState<ReadonlySet<string>>(new Set());
   const [adding, setAdding] = useState(false);
   const [topicFor, setTopicFor] = useState<TaskSummary | null>(null);
   const [error, setError] = useState<string | null>(null);
   const set = (p: Partial<TaskFilter>) => setFilter((f) => ({ ...f, ...p }));

   const sessionInfo = useMemo(
      () => new Map<string, SessionInfo>(sessions.map((s) => [s.id, s])),
      [sessions],
   );
   const list = useMemo(
      () =>
         buildList(tasks ?? [], {
            filter,
            groupBy,
            today,
            flipped,
            sessionTitle: (id) => sessionInfo.get(id)?.title ?? null,
         }),
      [tasks, filter, groupBy, today, flipped, sessionInfo],
   );
   const byId = useMemo(() => new Map((tasks ?? []).map((t) => [t.id, t])), [tasks]);

   // Opened at a task (the host's "Open in All tasks"): unfold its topic and bring its row into view.
   useEffect(() => {
      if (!selected || !byId.has(selected)) return;
      setFlipped((f) => reveal(byId, selected, f));
      requestAnimationFrame(() =>
         document
            .querySelector(`[data-task-row="${CSS.escape(selected)}"]`)
            ?.scrollIntoView?.({ block: "nearest" }),
      );
   }, [selected, byId]);

   const fail = useCallback((e: unknown) => setError(errText(e)), []);
   const actions = useMemo<ListActions>(
      () => ({
         select: (id) => onSelect(id === selected ? null : id),
         toggle: (key) =>
            setFlipped((f) => {
               const next = new Set(f);
               if (!next.delete(key)) next.add(key);
               return next;
            }),
         status: (id, status) => {
            setError(null);
            api.updateTask(id, { status }).catch(fail);
         },
         move: (id, parent) => {
            setError(null);
            api.moveTask(id, parent).catch(fail);
         },
         newTopic: setTopicFor,
         startFromTask: onStartFromTask,
         openSession: onOpenSession,
      }),
      [api, fail, onSelect, selected, onStartFromTask, onOpenSession],
   );
   const host = useMemo<PanelCtx["host"]>(
      () => ({ startFromTask: onStartFromTask }),
      [onStartFromTask],
   );

   // The origin Sessions the tasks have, for the Session filter (titles from the host, else the cached one).
   const origins = useMemo(() => {
      const m = new Map<string, string>();
      for (const t of tasks ?? [])
         if (t.origin_session_id && !m.has(t.origin_session_id))
            m.set(
               t.origin_session_id,
               sessionInfo.get(t.origin_session_id)?.title ?? t.origin_title ?? "Session",
            );
      return [...m].sort((a, b) => a[1].localeCompare(b[1]));
   }, [tasks, sessionInfo]);

   const open = tasks ? openCount(tasks) : 0;
   const fromSessions = tasks ? sessionCount(tasks) : 0;

   return (
      <OpenSession.Provider value={onOpenSession}>
         <div className="flex h-full min-h-0 flex-col bg-background">
            <header
               data-tauri-drag-region
               className="flex h-13 shrink-0 items-center gap-2 border-b px-4"
            >
               {leading}
               <ListTodo className="size-4 shrink-0 text-muted-foreground" />
               <h1 className="text-sm font-medium">Tasks</h1>
               {tasks && (
                  <span className="hidden truncate text-xs text-muted-foreground sm:inline">
                     {open} open · {fromSessions} {fromSessions === 1 ? "session" : "sessions"}
                  </span>
               )}
               <div className="ml-auto flex shrink-0 items-center gap-1.5">
                  <label className="flex h-8 w-56 items-center gap-1.5 rounded-md border px-2 text-muted-foreground focus-within:ring-1 focus-within:ring-ring">
                     <Search className="size-3.5 shrink-0 opacity-80" />
                     <input
                        {...noAutocorrect}
                        value={filter.query}
                        onChange={(e) => set({ query: e.target.value })}
                        onKeyDown={(e) => e.key === "Escape" && set({ query: "" })}
                        placeholder="Search tasks"
                        aria-label="Search tasks"
                        className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/60"
                     />
                  </label>
                  <Button size="sm" onClick={() => setAdding(true)}>
                     <Plus /> New task
                  </Button>
               </div>
            </header>
            <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b px-4 py-2">
               <FilterMenu label={`Status: ${STATUS_FILTER[filter.status].toLowerCase()}`} active>
                  <DropdownMenuRadioGroup
                     value={filter.status}
                     onValueChange={(v) => set({ status: v as StatusFilter })}
                  >
                     {(Object.keys(STATUS_FILTER) as StatusFilter[]).map((s) => (
                        <DropdownMenuRadioItem key={s} value={s}>
                           {STATUS_FILTER[s]}
                        </DropdownMenuRadioItem>
                     ))}
                  </DropdownMenuRadioGroup>
               </FilterMenu>
               <FilterMenu
                  label={
                     filter.priorities.length === 0
                        ? "Priority"
                        : `Priority: ${filter.priorities.map((p) => PRIORITY_LABEL[p]).join(", ")}`
                  }
                  active={filter.priorities.length > 0}
               >
                  {PRIORITIES.map((p) => (
                     <DropdownMenuCheckboxItem
                        key={p}
                        checked={filter.priorities.includes(p)}
                        onSelect={(e) => e.preventDefault()}
                        onCheckedChange={(on) =>
                           set({
                              priorities: on
                                 ? [...filter.priorities, p]
                                 : filter.priorities.filter((x) => x !== p),
                           })
                        }
                     >
                        {PRIORITY_LABEL[p]}
                     </DropdownMenuCheckboxItem>
                  ))}
               </FilterMenu>
               <FilterMenu
                  label={
                     filter.session === null
                        ? "Session"
                        : filter.session === NO_SESSION
                          ? "Session: none"
                          : `Session: ${origins.find(([id]) => id === filter.session)?.[1] ?? "?"}`
                  }
                  active={filter.session !== null}
               >
                  <DropdownMenuRadioGroup
                     value={filter.session ?? ""}
                     onValueChange={(v) => set({ session: v || null })}
                  >
                     <DropdownMenuRadioItem value="">Any</DropdownMenuRadioItem>
                     <DropdownMenuRadioItem value={NO_SESSION}>No session</DropdownMenuRadioItem>
                     {origins.length > 0 && <DropdownMenuSeparator />}
                     {origins.map(([id, title]) => (
                        <DropdownMenuRadioItem key={id} value={id}>
                           <span className="truncate">{title}</span>
                        </DropdownMenuRadioItem>
                     ))}
                  </DropdownMenuRadioGroup>
               </FilterMenu>
               <FilterMenu
                  label={filter.due === "any" ? "Due" : DUE_FILTER[filter.due]}
                  active={filter.due !== "any"}
               >
                  <DropdownMenuRadioGroup
                     value={filter.due}
                     onValueChange={(v) => set({ due: v as DueFilter })}
                  >
                     {(Object.keys(DUE_FILTER) as DueFilter[]).map((d) => (
                        <DropdownMenuRadioItem key={d} value={d}>
                           {DUE_FILTER[d]}
                        </DropdownMenuRadioItem>
                     ))}
                  </DropdownMenuRadioGroup>
               </FilterMenu>
               <Button
                  size="sm"
                  variant="outline"
                  aria-pressed={filter.upstream}
                  className={cn("h-7", filter.upstream && "border-ring/60 bg-accent")}
                  onClick={() => set({ upstream: !filter.upstream })}
               >
                  Has upstream
               </Button>
               {hasFilters(filter) && (
                  <Button
                     size="sm"
                     variant="ghost"
                     className="h-7 text-muted-foreground"
                     onClick={() => setFilter({ ...DEFAULT_FILTER, status: filter.status })}
                  >
                     <X /> Clear
                  </Button>
               )}
               <span className="flex-1" />
               <span className="text-xs text-muted-foreground">Group</span>
               <FilterMenu label={GROUP_BY[groupBy]} disabled={view === "tree"}>
                  <DropdownMenuRadioGroup
                     value={groupBy}
                     onValueChange={(v) => setGroupBy(v as GroupBy)}
                  >
                     {(Object.keys(GROUP_BY) as GroupBy[]).map((g) => (
                        <DropdownMenuRadioItem key={g} value={g}>
                           {GROUP_BY[g]}
                        </DropdownMenuRadioItem>
                     ))}
                  </DropdownMenuRadioGroup>
               </FilterMenu>
               <Segmented
                  value={view}
                  onChange={(v) => viewStore.set(v)}
                  label="View"
                  items={[
                     { value: "list", label: "List" },
                     { value: "tree", label: "Tree" },
                  ]}
               />
            </div>
            {error && (
               <p role="alert" className="px-4 pt-2 text-xs text-destructive">
                  {error}
               </p>
            )}
            <div className="flex min-h-0 flex-1">
               {view === "tree" ? (
                  <div className="grid min-w-0 flex-1 place-items-center text-sm text-muted-foreground">
                     The tree view is not here yet. Use the list.
                  </div>
               ) : (
                  <ListView
                     tasks={tasks ?? []}
                     list={list}
                     groupBy={groupBy}
                     selected={selected}
                     today={today}
                     sessions={sessionInfo}
                     actions={actions}
                     top={
                        adding && (
                           <QuickAdd
                              className="px-4 py-2"
                              label="New task"
                              placeholder="Task title… Enter adds, Esc closes"
                              autoFocus
                              onAdd={(title) =>
                                 api.createTask({ title }).then((t) => onSelect(t.id))
                              }
                              onCancel={() => setAdding(false)}
                           />
                        )
                     }
                     empty={
                        <p className="px-4 py-6 text-sm text-muted-foreground">
                           {!tasks
                              ? "Loading…"
                              : tasks.length === 0
                                ? "No tasks yet. Add one with New task, or ask the Agent in a Session."
                                : "No tasks match the filters."}
                        </p>
                     }
                  />
               )}
               {selected && (
                  <PreviewColumn
                     api={api}
                     id={selected}
                     tasks={tasks}
                     host={host}
                     onClose={() => onSelect(null)}
                     onOpen={onSelect}
                  />
               )}
            </div>
         </div>
         <NewTopicDialog
            task={topicFor}
            onClose={() => setTopicFor(null)}
            onCreate={async (title) => {
               if (!topicFor) return;
               const topic = await api.createTask({ title, parentId: topicFor.parent_id });
               await api.moveTask(topicFor.id, topic.id);
               setTopicFor(null);
            }}
         />
      </OpenSession.Provider>
   );
}

/** A filter bar button that opens its menu. `active`: the filter is set (shown filled). */
function FilterMenu({
   label,
   active,
   disabled,
   children,
}: {
   label: string;
   active?: boolean;
   disabled?: boolean;
   children: ReactNode;
}) {
   return (
      <DropdownMenu>
         <DropdownMenuTrigger asChild disabled={disabled}>
            <Button
               size="sm"
               variant="outline"
               className={cn(
                  "h-7 max-w-64 data-[state=open]:bg-accent",
                  active && "border-ring/60",
               )}
            >
               <span className="truncate">{label}</span>
               <ChevronDown className="size-3 text-muted-foreground" />
            </Button>
         </DropdownMenuTrigger>
         <DropdownMenuContent align="start" className="w-52">
            {children}
         </DropdownMenuContent>
      </DropdownMenu>
   );
}

/** "New topic from this task…": names the topic; the task moves under it. */
function NewTopicDialog({
   task,
   onClose,
   onCreate,
}: {
   task: TaskSummary | null;
   onClose: () => void;
   onCreate: (title: string) => Promise<void>;
}) {
   const [title, setTitle] = useState("");
   const [error, setError] = useState<string | null>(null);
   const [busy, setBusy] = useState(false);
   useEffect(() => {
      if (task) {
         setTitle("");
         setError(null);
      }
   }, [task]);
   const submit = () => {
      const t = title.trim();
      if (!t || busy) return;
      setBusy(true);
      setError(null);
      onCreate(t)
         .catch((e) => setError(errText(e)))
         .finally(() => setBusy(false));
   };
   return (
      <Dialog open={task !== null} onOpenChange={(o) => !o && onClose()}>
         <DialogContent>
            <DialogHeader>
               <DialogTitle>New topic</DialogTitle>
               <DialogDescription>
                  {task && (
                     <>
                        "<InlineMarkdown variant="quiet">{task.title}</InlineMarkdown>" moves under
                        the new topic.
                     </>
                  )}
               </DialogDescription>
            </DialogHeader>
            <form
               onSubmit={(e) => {
                  e.preventDefault();
                  submit();
               }}
            >
               <Input
                  autoFocus
                  aria-label="Topic title"
                  placeholder="Topic title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
               />
               {error && (
                  <p role="alert" className="pt-2 text-xs text-destructive">
                     {error}
                  </p>
               )}
            </form>
            <DialogFooter>
               <Button variant="outline" onClick={onClose}>
                  Cancel
               </Button>
               <Button disabled={!title.trim() || busy} onClick={submit}>
                  Create topic
               </Button>
            </DialogFooter>
         </DialogContent>
      </Dialog>
   );
}
