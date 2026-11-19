import {
   codec,
   isOpen,
   storedValue,
   type TaskSummary,
   topicProgress,
   useStoredValue,
} from "@harness/api";
import { Button, cn, ScrollArea } from "@harness/ui";
import { Check, ChevronsDownUp, ChevronsUpDown } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef } from "react";
import { InlineMarkdown } from "../markdown/InlineMarkdown";
import { dueTone, formatDue } from "./DuePicker";
import { PREVIEW_SPACE } from "./FloatingPreview";
import type { SessionInfo } from "./ListView";
import type { TaskFilter } from "./listModel";
import { PriorityIcon } from "./PriorityMenu";
import { StatusIcon } from "./StatusMenu";
import { sessionTitle } from "./sessionTitle";
import {
   collapseAll,
   defaultCollapsed,
   layoutTree,
   revealNode,
   type TreeEdge,
   type TreeNode,
} from "./treeLayout";

/** `collapsed` null: the user has not folded anything yet (the default folds apply). */
type TreeState = { collapsed: string[] | null; hideDone: boolean };

const isTreeState = (v: unknown): v is TreeState => {
   if (typeof v !== "object" || v === null) return false;
   const { collapsed, hideDone } = v as TreeState;
   return (
      (collapsed === null ||
         (Array.isArray(collapsed) && collapsed.every((x) => typeof x === "string"))) &&
      typeof hideDone === "boolean"
   );
};

/** Folded tasks and Hide done, per window. */
const treeStore = storedValue<TreeState>({
   key: "harness.tasks.tree",
   scope: "app",
   parse: codec.json(isTreeState, { collapsed: null, hideDone: false }),
   sync: false,
});

/**
 * The All tasks tree (board "AllTasksTree"): the topics as a mind map, left to right, with their subtasks.
 * Top-level tasks without subtasks do not show (a note links to the list). A large tree starts collapsed.
 * The tree scrolls both ways and is centered when it is shorter than the area. `preview` floats over the tree
 * area (it does not scroll), so the nodes do not move when it opens. While it is open the tree gets room on its
 * right, so every node can be scrolled out from under it.
 */
export function TreeView({
   tasks,
   filter,
   today,
   selected,
   sessions,
   onSelect,
   onShowList,
   preview,
}: {
   /** Null while loading. */
   tasks: readonly TaskSummary[] | null;
   /** The view's filters; the status one is not used (the tree has Hide done). */
   filter: TaskFilter;
   today: string;
   selected: string | null;
   sessions: ReadonlyMap<string, SessionInfo>;
   onSelect: (id: string) => void;
   onShowList: () => void;
   preview?: ReactNode;
}) {
   const state = useStoredValue(treeStore);
   const all = useMemo(() => tasks ?? [], [tasks]);
   const collapsed = useMemo(
      () =>
         state.collapsed
            ? new Set(state.collapsed)
            : defaultCollapsed(all, { filter, today, hideDone: state.hideDone }),
      [state.collapsed, all, filter, today, state.hideDone],
   );
   const layout = useMemo(
      () => layoutTree(all, { filter, today, hideDone: state.hideDone, collapsed }),
      [all, filter, today, state.hideDone, collapsed],
   );
   const byId = useMemo(() => new Map(all.map((t) => [t.id, t])), [all]);
   const setCollapsed = (c: ReadonlySet<string>) => treeStore.set({ ...state, collapsed: [...c] });

   // A task selected elsewhere (the list, a subtask in the preview): unfold to it and bring it into view.
   // Once per selection (also when it first loads), so a tasks reload keeps the user's folds.
   const revealed = useRef<string | null>(null);
   useEffect(() => {
      if (selected === revealed.current) return;
      if (!selected) {
         revealed.current = null;
         return;
      }
      if (!byId.has(selected)) return;
      revealed.current = selected;
      const next = revealNode(byId, selected, collapsed);
      if (next !== collapsed) treeStore.set({ ...treeStore.get(), collapsed: [...next] });
      requestAnimationFrame(() => bringIntoView(selected));
   }, [selected, byId, collapsed]);

   const toggle = (id: string) => {
      const next = new Set(collapsed);
      if (!next.delete(id)) next.add(id);
      setCollapsed(next);
   };

   return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
         <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b px-4 py-2">
            <Button
               size="sm"
               variant="outline"
               className="h-7"
               onClick={() => setCollapsed(new Set())}
            >
               <ChevronsUpDown /> Expand all
            </Button>
            <Button
               size="sm"
               variant="outline"
               className="h-7"
               onClick={() => setCollapsed(collapseAll(all))}
            >
               <ChevronsDownUp /> Collapse all
            </Button>
            <Button
               size="sm"
               variant="outline"
               aria-pressed={state.hideDone}
               className={cn("h-7", state.hideDone && "border-ring/60 bg-accent")}
               onClick={() => treeStore.set({ ...state, hideDone: !state.hideDone })}
            >
               <span
                  aria-hidden
                  className={cn(
                     "grid size-3 place-items-center rounded-[3px] border border-muted-foreground",
                     state.hideDone && "border-foreground bg-foreground text-background",
                  )}
               >
                  {state.hideDone && <Check className="size-2.5!" strokeWidth={3} />}
               </span>
               Hide done
            </Button>
            {layout.loose > 0 && (
               <p className="ml-auto text-xs text-muted-foreground">
                  {layout.loose} top-level {layout.loose === 1 ? "task" : "tasks"} without subtasks
                  hidden.{" "}
                  <button
                     type="button"
                     onClick={onShowList}
                     className="text-sky-600 hover:underline dark:text-sky-400"
                  >
                     Show in List
                  </button>
               </p>
            )}
         </div>
         <div data-tree-area className="relative flex min-h-0 flex-1 flex-col">
            {layout.root ? (
               // Radix sets the root `position: relative` inline, so it fills the area as a flex item. The content
               // is as tall as the viewport at least; the tree sits in its middle (auto margins: never above the
               // top when taller).
               <ScrollArea horizontal className="min-h-0 flex-1" viewportClassName="[&>div]:h-full">
                  <div className="flex h-full flex-col">
                     <div
                        className="relative my-auto shrink-0"
                        data-tree-box
                        style={{
                           width: layout.width + (preview ? PREVIEW_SPACE : 0),
                           height: layout.height,
                        }}
                     >
                        <Edges edges={layout.edges} width={layout.width} height={layout.height} />
                        <div
                           className="absolute flex items-center justify-center rounded-full bg-muted text-xs font-semibold"
                           style={{
                              left: layout.root.x,
                              top: layout.root.y,
                              width: layout.root.w,
                              height: layout.root.h,
                           }}
                        >
                           All topics
                        </div>
                        {layout.nodes.map((n) => (
                           <Node
                              key={n.task.id}
                              node={n}
                              tasks={all}
                              selected={n.task.id === selected}
                              today={today}
                              sessions={sessions}
                              onSelect={onSelect}
                              onToggle={toggle}
                           />
                        ))}
                     </div>
                  </div>
               </ScrollArea>
            ) : (
               <p className="px-4 py-6 text-sm text-muted-foreground">
                  {!tasks
                     ? "Loading…"
                     : tasks.length === 0
                       ? "No tasks yet. Add one with New task, or ask the Agent in a Session."
                       : "No topics to show. A topic is a task with subtasks: nest a task under another in the list."}
               </p>
            )}
            {preview}
         </div>
      </div>
   );
}

/** Scrolls node `id` into view, and out from under the floating preview when it is behind it. */
function bringIntoView(id: string) {
   const el = document.querySelector<HTMLElement>(`[data-tree-node="${CSS.escape(id)}"]`);
   if (!el) return;
   el.scrollIntoView?.({ block: "nearest", inline: "nearest" });
   const area = el.closest("[data-tree-area]");
   const card = area?.querySelector("[data-floating-preview]");
   const viewport = el.closest<HTMLElement>("[data-radix-scroll-area-viewport]");
   if (!card || !viewport) return;
   const behind = el.getBoundingClientRect().right - (card.getBoundingClientRect().left - 12);
   if (behind > 0) viewport.scrollBy?.({ left: behind });
}

/** The connectors, one curve from a parent's right edge to each child's left edge. */
function Edges({ edges, width, height }: { edges: TreeEdge[]; width: number; height: number }) {
   return (
      <svg
         aria-hidden
         width={width}
         height={height}
         className="pointer-events-none absolute inset-0 text-border"
      >
         {edges.map((e) => {
            const mx = (e.x1 + e.x2) / 2;
            return (
               <path
                  key={`${e.from ?? ""}>${e.to}`}
                  d={`M${e.x1} ${e.y1}C${mx} ${e.y1} ${mx} ${e.y2} ${e.x2} ${e.y2}`}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.25}
               />
            );
         })}
      </svg>
   );
}

function Node({
   node,
   tasks,
   selected,
   today,
   sessions,
   onSelect,
   onToggle,
}: {
   node: TreeNode<TaskSummary>;
   tasks: readonly TaskSummary[];
   selected: boolean;
   today: string;
   sessions: ReadonlyMap<string, SessionInfo>;
   onSelect: (id: string) => void;
   onToggle: (id: string) => void;
}) {
   const { task } = node;
   const open = isOpen(task.status);
   const topic = node.depth === 0;
   const progress = node.kids > 0 ? topicProgress(tasks, task.id) : null;
   const origin = task.origin_session_id;
   return (
      <div
         data-tree-node={task.id}
         aria-current={selected || undefined}
         className={cn(
            "absolute flex items-center gap-2.5 rounded-lg border bg-card px-2.5 text-[13px] transition-colors hover:border-foreground/25",
            topic && "border-violet-500/35 bg-muted/60",
            selected && "border-sky-500 ring-1 ring-sky-500 hover:border-sky-500",
            node.context && "opacity-60",
         )}
         style={{ left: node.x, top: node.y, width: node.w, height: node.h }}
      >
         <StatusIcon status={task.status} />
         <div className="flex min-w-0 flex-1 flex-col">
            {/* The title is the node's button; its ::after covers the node, so a click anywhere selects. */}
            <button
               type="button"
               onClick={() => onSelect(task.id)}
               className={cn(
                  "w-full truncate text-left leading-[18px] outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:underline",
                  topic && "font-semibold",
                  !open && "text-muted-foreground line-through",
               )}
            >
               <InlineMarkdown variant="quiet">{task.title}</InlineMarkdown>
            </button>
            <span className="mt-0.5 flex w-full items-center gap-1.5 overflow-hidden text-[11px] whitespace-nowrap text-muted-foreground">
               {progress && progress.total > 0 && (
                  <span
                     className="flex shrink-0 items-center gap-1.5 tabular-nums"
                     title="Subtasks done"
                  >
                     <span className="h-1 w-12 overflow-hidden rounded-full bg-muted">
                        <span
                           className="block h-full bg-emerald-500"
                           style={{ width: `${(progress.done / progress.total) * 100}%` }}
                        />
                     </span>
                     {progress.done}/{progress.total}
                  </span>
               )}
               {task.priority !== "none" && (
                  <PriorityIcon priority={task.priority} className="size-3" />
               )}
               {task.due && (
                  <span className={cn("shrink-0", dueTone(task.due, today, open))}>
                     {formatDue(task.due, today)}
                  </span>
               )}
               {!progress && origin && (
                  <span className="truncate">
                     {sessionTitle(origin, task.origin_title, sessions).title}
                  </span>
               )}
            </span>
         </div>
         {node.kids > 0 && (
            <button
               type="button"
               aria-expanded={node.expanded}
               aria-label={`${node.expanded ? "Collapse" : "Expand"} ${task.title}`}
               onClick={() => onToggle(task.id)}
               className="relative h-6 min-w-8 shrink-0 rounded-full border bg-muted px-1.5 text-[11px] font-medium tabular-nums hover:bg-accent"
            >
               {node.expanded ? "−" : `+${node.hidden}`}
            </button>
         )}
      </div>
   );
}
