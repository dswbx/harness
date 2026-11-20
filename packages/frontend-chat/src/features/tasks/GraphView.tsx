import { isOpen, openBlockers, storedValue, type TaskSummary, useStoredValue } from "@harness/api";
import {
   Button,
   cn,
   DropdownMenu,
   DropdownMenuCheckboxItem,
   DropdownMenuContent,
   DropdownMenuTrigger,
   ScrollArea,
} from "@harness/ui";
import { ChevronDown, MoveUpRight } from "lucide-react";
import {
   type ReactNode,
   type RefObject,
   useEffect,
   useId,
   useLayoutEffect,
   useMemo,
   useRef,
   useState,
} from "react";
import { InlineMarkdown } from "../markdown/InlineMarkdown";
import { dueTone, formatDue } from "./DuePicker";
import { PREVIEW_SPACE } from "./FloatingPreview";
import {
   type GraphGroupBy,
   type GraphLine,
   type GraphLineKind,
   layoutGraph,
   MIN_WIDTH,
} from "./graphLayout";
import { PriorityIcon } from "./PriorityMenu";
import { STATUS_LABEL, StatusIcon } from "./StatusMenu";
import { type Sessions, sessionTitle } from "./sessionTitle";
import { WaitsOnChip } from "./TaskRow";

const NONE: readonly TaskSummary[] = [];

/** Which lines the graph draws. Hidden lines still place the cards (cards do not move when one is turned off). */
export type GraphLines = { blocks: boolean; followUps: boolean; parents: boolean };

const DEFAULT_LINES: GraphLines = { blocks: true, followUps: true, parents: false };

/** A stored Lines choice; a missing or broken field is its default. */
export function parseGraphLines(raw: string | null): GraphLines {
   let v: unknown = null;
   try {
      v = raw === null ? null : JSON.parse(raw);
   } catch {}
   const o = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
   const pick = (k: keyof GraphLines) => (typeof o[k] === "boolean" ? o[k] : DEFAULT_LINES[k]);
   return { blocks: pick("blocks"), followUps: pick("followUps"), parents: pick("parents") };
}

/** The Lines menu's choice, for All tasks and the panel graph. */
const linesStore = storedValue<GraphLines>({
   key: "harness.tasks.graphLines",
   scope: "app",
   parse: parseGraphLines,
});

const LINE_LABEL: Record<keyof GraphLines, string> = {
   blocks: "Blocks",
   followUps: "Follow-ups",
   parents: "Parent lines",
};

/** The toolbar's Lines menu: which kinds of lines the graph draws. */
export function LinesMenu() {
   const lines = useStoredValue(linesStore);
   const on = (Object.keys(LINE_LABEL) as (keyof GraphLines)[]).filter((k) => lines[k]);
   return (
      <DropdownMenu>
         <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" className="h-7 data-[state=open]:bg-accent">
               <span className="truncate">
                  Lines:{" "}
                  {on.length ? on.map((k) => LINE_LABEL[k].toLowerCase()).join(", ") : "none"}
               </span>
               <ChevronDown className="size-3 text-muted-foreground" />
            </Button>
         </DropdownMenuTrigger>
         <DropdownMenuContent align="start" className="w-48">
            {(Object.keys(LINE_LABEL) as (keyof GraphLines)[]).map((k) => (
               <DropdownMenuCheckboxItem
                  key={k}
                  checked={lines[k]}
                  onSelect={(e) => e.preventDefault()}
                  onCheckedChange={(c) => linesStore.set({ ...linesStore.get(), [k]: c === true })}
               >
                  {LINE_LABEL[k]}
               </DropdownMenuCheckboxItem>
            ))}
         </DropdownMenuContent>
      </DropdownMenu>
   );
}

const shows = (lines: GraphLines, kind: GraphLineKind) =>
   kind === "blocks" ? lines.blocks : kind === "follow_up" ? lines.followUps : lines.parents;

/**
 * The container's width, rounded down to 8 px, read once per animation frame while it changes; 0 before the
 * first read (and in a DOM without layout).
 */
function useWidth(ref: RefObject<HTMLElement | null>): number {
   const [width, setWidth] = useState(0);
   useLayoutEffect(() => {
      const el = ref.current;
      if (!el) return;
      const read = () => setWidth(Math.floor(el.clientWidth / 8) * 8);
      read();
      if (typeof ResizeObserver === "undefined") return;
      let frame = 0;
      const ro = new ResizeObserver(() => {
         if (frame) return;
         frame = requestAnimationFrame(() => {
            frame = 0;
            read();
         });
      });
      ro.observe(el);
      return () => {
         ro.disconnect();
         cancelAnimationFrame(frame);
      };
   }, [ref]);
   return width;
}

/** The ids linked to `id` by deps, both ways and through any number of tasks (its whole chain), and `id`. */
function chainOf(lines: readonly GraphLine[], id: string): Set<string> {
   const out = new Set([id]);
   for (const dir of ["from", "to"] as const) {
      const todo = [id];
      const seen = new Set([id]);
      for (let at = todo.pop(); at !== undefined; at = todo.pop())
         for (const l of lines) {
            if (l.kind === "parent") continue;
            const [near, far] = dir === "from" ? [l.to, l.from] : [l.from, l.to];
            if (near === at && !seen.has(far)) {
               seen.add(far);
               out.add(far);
               todo.push(far);
            }
         }
   }
   return out;
}

/**
 * The Graph view (ADR 0029; boards "Main" and "Panel"): task cards in lanes, with lines for their deps, laid out
 * by `layoutGraph` for the container's width. Wide, lanes are bands and a card's column is its rank; narrow, lanes
 * are sections that tasks fill row by row. Below `MIN_WIDTH` it scrolls sideways.
 *
 * Hovering a card shows its lines in blue. `selected` does too, and fades every card and line outside its chain.
 * `preview` floats over the graph area (like the Tree view's), and the graph gets room on its right for it.
 */
export function GraphView({
   tasks,
   all,
   outside = NONE,
   groupBy,
   density,
   selected = null,
   today,
   sessions,
   showSession = false,
   onOpen,
   onOpenOutside,
   preview,
   empty,
}: {
   /** The tasks shown. */
   tasks: readonly TaskSummary[];
   /** All tasks, for "waits on N" and parent lines. */
   all: readonly TaskSummary[];
   /** Tasks not shown that shown ones wait on (other Sessions): dashed cards. */
   outside?: readonly TaskSummary[];
   groupBy: GraphGroupBy<TaskSummary>;
   density: "condensed" | "detail";
   selected?: string | null;
   today: string;
   sessions?: Sessions;
   /** The meta line names the task's origin Session. */
   showSession?: boolean;
   onOpen: (id: string) => void;
   /** A click on an outside card; none: they do not click. */
   onOpenOutside?: (id: string) => void;
   preview?: ReactNode;
   /** Shown instead of the graph when no task shows. */
   empty?: ReactNode;
}) {
   const area = useRef<HTMLDivElement>(null);
   const width = useWidth(area);
   const lines = useStoredValue(linesStore);
   const [hovered, setHovered] = useState<string | null>(null);
   const parents = lines.parents;
   const layout = useMemo(
      () =>
         layoutGraph(tasks, {
            width: width || MIN_WIDTH,
            groupBy,
            density,
            outside,
            parentOf: parents ? (t) => t.parent_id : undefined,
         }),
      [tasks, width, groupBy, density, outside, parents],
   );
   const byId = useMemo(
      () => new Map([...outside, ...tasks].map((t) => [t.id, t])),
      [tasks, outside],
   );

   // Cards glide to a new place when only the width changed, but not when the mode changes (everything moves
   // at once then), and not for other changes (a new group-by, tasks): the lines do not glide with them.
   const inputs = [tasks, groupBy, density, outside, parents, layout.mode];
   const last = useRef(inputs);
   const glide = inputs.every((v, i) => v === last.current[i]);
   useEffect(() => {
      last.current = inputs;
   });

   const chain = useMemo(
      () => (selected && byId.has(selected) ? chainOf(layout.lines, selected) : null),
      [layout.lines, selected, byId],
   );
   const lit = (l: GraphLine) =>
      l.from === hovered || l.to === hovered || l.from === selected || l.to === selected;
   const shown = layout.lines.filter((l) => shows(lines, l.kind));
   // Lit lines on top.
   shown.sort((a, b) => Number(lit(a)) - Number(lit(b)));

   // A task selected elsewhere (the list, a link in the preview): bring its card into view.
   useEffect(() => {
      if (!selected) return;
      const el = area.current?.querySelector<HTMLElement>(
         `[data-graph-card="${CSS.escape(selected)}"]`,
      );
      el?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
   }, [selected]);

   const marker = `graph${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
   const counts = new Map<number, number>();
   for (const c of layout.cards) if (!c.outside) counts.set(c.lane, (counts.get(c.lane) ?? 0) + 1);
   const bands = layout.mode === "aligned" && layout.lanes.some((l) => l.head > 0);

   return (
      <div ref={area} data-graph-area className="relative flex min-h-0 min-w-0 flex-1 flex-col">
         {tasks.length === 0 ? (
            empty
         ) : (
            <ScrollArea horizontal className="min-h-0 flex-1">
               <div
                  className="relative"
                  data-graph-box
                  data-mode={layout.mode}
                  style={{
                     width: layout.width + (preview ? PREVIEW_SPACE : 0),
                     height: layout.height,
                  }}
               >
                  {layout.lanes.map((l) =>
                     l.head === 0 ? null : (
                        <div key={l.key ?? ""}>
                           {bands && (
                              <div
                                 aria-hidden
                                 className="absolute rounded-xl border border-border/60 bg-muted/30"
                                 style={{
                                    left: l.x + 4,
                                    top: l.y - 4,
                                    width: l.w - 8,
                                    height: l.h + 8,
                                 }}
                              />
                           )}
                           <div
                              data-lane={l.label}
                              className="absolute flex items-center gap-1 truncate text-[11px] font-medium tracking-wide text-muted-foreground uppercase"
                              style={{
                                 left: l.x + (bands ? 16 : 14),
                                 top: l.y,
                                 height: l.head,
                                 maxWidth: l.w - 32,
                              }}
                           >
                              <span className="truncate">
                                 <InlineMarkdown variant="quiet">{l.label}</InlineMarkdown>
                              </span>
                              <span className="shrink-0 tabular-nums">
                                 · {counts.get(layout.lanes.indexOf(l)) ?? 0}
                              </span>
                           </div>
                        </div>
                     ),
                  )}
                  <svg
                     aria-hidden
                     width={layout.width}
                     height={layout.height}
                     className="pointer-events-none absolute inset-0"
                  >
                     <defs>
                        {(["line", "lit", "parent"] as const).map((k) => (
                           <marker
                              key={k}
                              id={`${marker}-${k}`}
                              viewBox="0 0 6 6"
                              refX={6}
                              refY={3}
                              markerWidth={6}
                              markerHeight={6}
                              markerUnits="userSpaceOnUse"
                              orient="auto"
                           >
                              <path
                                 d="M0 0L6 3L0 6Z"
                                 className={
                                    k === "lit"
                                       ? "fill-sky-500"
                                       : k === "parent"
                                         ? "fill-border"
                                         : "fill-muted-foreground"
                                 }
                              />
                           </marker>
                        ))}
                     </defs>
                     {shown.map((l) => {
                        const on = lit(l);
                        const faded =
                           chain !== null && !on && !(chain.has(l.from) && chain.has(l.to));
                        const tone = on ? "lit" : l.kind === "parent" ? "parent" : "line";
                        return (
                           <path
                              key={`${l.kind}:${l.from}>${l.to}`}
                              data-line={`${l.from}>${l.to}`}
                              data-kind={l.kind}
                              data-lit={on || undefined}
                              data-faded={faded || undefined}
                              d={l.path}
                              fill="none"
                              strokeWidth={l.kind === "parent" && !on ? 1 : 1.5}
                              strokeDasharray={l.kind === "follow_up" ? "4 3" : undefined}
                              markerEnd={`url(#${marker}-${tone})`}
                              className={cn(
                                 "transition-opacity duration-150",
                                 on
                                    ? "stroke-sky-500"
                                    : l.kind === "parent"
                                      ? "stroke-border"
                                      : "stroke-muted-foreground/70",
                                 faded && "opacity-25",
                              )}
                           />
                        );
                     })}
                  </svg>
                  {layout.cards.map((c) => {
                     const task = byId.get(c.id);
                     if (!task) return null;
                     return (
                        <Card
                           key={c.id}
                           task={task}
                           all={all}
                           outside={c.outside === true}
                           x={c.x}
                           y={c.y}
                           w={layout.cardWidth}
                           h={layout.cardHeight}
                           detail={density === "detail"}
                           glide={glide}
                           selected={c.id === selected}
                           faded={chain !== null && !chain.has(c.id)}
                           today={today}
                           sessions={sessions}
                           showSession={showSession}
                           onOpen={c.outside ? onOpenOutside : onOpen}
                           onHover={(on) => setHovered((h) => (on ? c.id : h === c.id ? null : h))}
                        />
                     );
                  })}
               </div>
            </ScrollArea>
         )}
         {preview}
      </div>
   );
}

function Card({
   task,
   all,
   outside,
   x,
   y,
   w,
   h,
   detail,
   glide,
   selected,
   faded,
   today,
   sessions,
   showSession,
   onOpen,
   onHover,
}: {
   task: TaskSummary;
   all: readonly TaskSummary[];
   outside: boolean;
   x: number;
   y: number;
   w: number;
   h: number;
   detail: boolean;
   glide: boolean;
   selected: boolean;
   faded: boolean;
   today: string;
   sessions?: Sessions;
   showSession: boolean;
   onOpen?: (id: string) => void;
   onHover: (on: boolean) => void;
}) {
   const open = isOpen(task.status);
   const waits = task.deps.length > 0 ? openBlockers(all, task.id) : 0;
   const origin = task.origin_session_id;
   const session =
      origin && (showSession || outside)
         ? sessionTitle(origin, task.origin_title, sessions).title
         : null;
   const meta = [
      waits > 0 && <WaitsOnChip key="waits" count={waits} />,
      task.priority !== "none" && (
         <PriorityIcon key="p" priority={task.priority} className="size-3" />
      ),
      task.due && (
         <span key="due" className={cn("shrink-0", dueTone(task.due, today, open))}>
            {formatDue(task.due, today)}
         </span>
      ),
      outside && (
         <span key="out" className="flex shrink-0 items-center gap-0.5">
            Other session <MoveUpRight className="size-2.5" />
         </span>
      ),
      session && (
         <span key="s" className="truncate">
            {session}
         </span>
      ),
   ].filter(Boolean);
   return (
      <div
         data-graph-card={task.id}
         data-outside={outside || undefined}
         data-faded={faded || undefined}
         aria-current={selected || undefined}
         onPointerEnter={() => onHover(true)}
         onPointerLeave={() => onHover(false)}
         className={cn(
            "absolute top-0 left-0 flex items-center gap-2 rounded-lg border px-2.5 text-[13px] transition-[border-color,opacity] duration-150 hover:border-foreground/25",
            glide && "transition-[transform,border-color,opacity] motion-reduce:transition-none",
            outside ? "border-dashed border-foreground/25 text-muted-foreground" : "bg-card",
            selected && "border-sky-500 ring-1 ring-sky-500 hover:border-sky-500",
            faded && "opacity-40",
         )}
         style={{ transform: `translate(${x}px, ${y}px)`, width: w, height: h }}
      >
         <StatusIcon status={task.status} />
         <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            {/* The title is the card's button; its ::after covers the card, so a click anywhere opens it. */}
            <button
               type="button"
               disabled={!onOpen}
               onClick={() => onOpen?.(task.id)}
               title={outside ? "Open in All tasks" : undefined}
               className={cn(
                  "w-full truncate text-left leading-[18px] outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:underline disabled:cursor-default",
                  !open && "text-muted-foreground line-through",
               )}
            >
               <InlineMarkdown variant="quiet">{task.title}</InlineMarkdown>
            </button>
            {detail && task.excerpt && (
               <span className="truncate text-[11px] leading-4 text-muted-foreground">
                  {task.excerpt}
               </span>
            )}
            <span className="flex h-5 w-full items-center gap-1.5 overflow-hidden text-[11px] whitespace-nowrap text-muted-foreground">
               {meta.length > 0 ? meta : STATUS_LABEL[task.status]}
            </span>
         </div>
      </div>
   );
}
