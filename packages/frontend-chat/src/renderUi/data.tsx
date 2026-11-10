import type { StatePatchOp } from "@harness/api";
import { cn, Input } from "@harness/ui";
import { s } from "jsonv-ts";
import {
   ArrowDown,
   ArrowUp,
   Ban,
   CheckCircle2,
   CircleDashed,
   Loader2,
   Search,
   XCircle,
} from "lucide-react";
import { useContext, useMemo, useState } from "react";
import { InlineMarkdown as Md } from "../InlineMarkdown";
import { Markdown } from "../Markdown";
import type { UiNode } from "../tools";
import {
   CheckBox,
   IconOf,
   type Renderers,
   runActions,
   ScopeCtx,
   structuredCloneSet,
   type Tone,
   tip,
   tones,
   useEnv,
} from "./runtime";
import { type Entry, icon, mono, tone, tooltip } from "./shared";

/** Lists and tables: Table, List, Timeline. */

/** A Table cell: inline Markdown text, or an object for a tone, monospace or an icon. Sort and filter use `text`. */
const cell = s.anyOf([
   s.string(),
   s.object({
      text: s.string(),
      tone: tone.optional(),
      mono: mono.optional(),
      icon: icon.optional(),
      tooltip: tooltip.optional(),
   }),
]);

export const specs = {
   Table: {
      description:
         "A table: column headings and rows. A row is an array of cells, or {cells, tone} to tint the row. A cell is text, or {text, tone?, mono?, icon?, tooltip?}. `sortable` sorts by a clicked column; `filter` adds a search box (both use the cell text).",
      children: false,
      props: s.object({
         columns: s.array(s.string()),
         rows: s.array(
            s.anyOf([s.array(cell), s.object({ cells: s.array(cell), tone: tone.optional() })]),
         ),
         sortable: s.boolean().optional(),
         filter: s.boolean().optional(),
      }),
      example: {
         node: {
            type: "Table",
            props: {
               sortable: true,
               filter: true,
               columns: ["Suite", "Result", "Time (s)", "Owner"],
               rows: [
                  [
                     "checkout",
                     { text: "passed", tone: "success", icon: "check" },
                     { text: "72", mono: true },
                     "@ana",
                  ],
                  {
                     cells: [
                        "search",
                        { text: "failed", tone: "error", icon: "x" },
                        { text: "48", mono: true },
                        "@li",
                     ],
                     tone: "error",
                  },
                  {
                     cells: [
                        "payments",
                        {
                           text: "flaky",
                           tone: "warning",
                           icon: "alert",
                           tooltip: "Failed 2 of the last 10 runs",
                        },
                        { text: "123", mono: true },
                        "@sam",
                     ],
                     tone: "warning",
                  },
                  [
                     "profile",
                     { text: "passed", tone: "success", icon: "check" },
                     { text: "9", mono: true },
                     "*nobody*",
                  ],
               ],
            },
         },
      },
   },
   List: {
      description:
         "Rich rows: title, description, meta text, icon, badge, tooltip. `status` (done, running, waiting, blocked, failed) shows a status icon in place of `icon`. With `check` ($bindState to an object), each row gets a checkbox that writes `{ [id]: true|false }` there, e.g. a todo list; `on.change` runs after a toggle. Status and check are independent: the checkbox comes first, the status icon after it.",
      children: false,
      props: s.object({
         items: s.array(
            s.object({
               id: s.string(),
               title: s.string(),
               description: s.string().optional(),
               meta: s
                  .string({ description: "Short text on the right, e.g. a time or a size." })
                  .optional(),
               icon: icon.optional(),
               badge: s.string().optional(),
               tone: tone.optional(),
               status: s
                  .string({ enum: ["done", "running", "waiting", "blocked", "failed"] })
                  .optional(),
               tooltip: tooltip.optional(),
            }),
            { minItems: 1 },
         ),
         check: s.any().optional(),
      }),
      bind: ["check"],
      events: ["change"],
      example: {
         node: {
            type: "Stack",
            children: [
               {
                  type: "List",
                  props: {
                     check: { $bindState: "/todos" },
                     items: [
                        {
                           id: "schema",
                           title: "Add the migration",
                           description: "users.email gets a unique index",
                           icon: "database",
                           meta: "5 min",
                        },
                        {
                           id: "api",
                           title: "Update the signup handler",
                           description: "Return 409 on a duplicate email",
                           icon: "code",
                           badge: "next",
                           tone: "info",
                        },
                        { id: "tests", title: "Cover the duplicate case", icon: "test" },
                     ],
                  },
               },
               {
                  type: "List",
                  props: {
                     items: [
                        { id: "ios", title: "Build the iOS app", status: "done", meta: "12 min" },
                        {
                           id: "review",
                           title: "App Store review",
                           status: "running",
                           description: "Submitted 09:20",
                        },
                        {
                           id: "play",
                           title: "Play Store review",
                           status: "waiting",
                           tooltip: "Starts after the App Store review",
                        },
                        {
                           id: "notes",
                           title: "Release notes",
                           status: "blocked",
                           description: "Waiting for the copy from marketing",
                        },
                        {
                           id: "android",
                           title: "Build the Android app",
                           status: "failed",
                           badge: "retry",
                           tone: "error",
                        },
                     ],
                  },
               },
            ],
         },
         state: { todos: { schema: true } },
      },
   },
   Timeline: {
      description:
         "Events in order: title, description, time, tone, icon. E.g. a deploy history or the steps of an investigation.",
      children: false,
      props: s.object({
         items: s.array(
            s.object({
               title: s.string(),
               description: s.string().optional(),
               time: s.string().optional(),
               tone: tone.optional(),
               icon: icon.optional(),
            }),
            { minItems: 1 },
         ),
      }),
      example: {
         node: {
            type: "Timeline",
            props: {
               items: [
                  {
                     title: "Reproduced the bug",
                     description: "Fails on an empty cart",
                     time: "10:02",
                     icon: "bug",
                     tone: "error",
                  },
                  {
                     title: "Found the cause",
                     description: "`total()` divides by the item count",
                     time: "10:14",
                     icon: "search",
                  },
                  { title: "Fix merged", time: "10:31", icon: "git-merge", tone: "success" },
               ],
            },
         },
      },
   },
} as const satisfies Record<string, Entry>;

/** List `status` icons. */
const statusIcons = {
   done: { icon: CheckCircle2, className: "text-emerald-500" },
   running: { icon: Loader2, className: "animate-spin text-sky-500" },
   waiting: { icon: CircleDashed, className: "text-muted-foreground" },
   blocked: { icon: Ban, className: "text-amber-500" },
   failed: { icon: XCircle, className: "text-destructive" },
} as const;

function List({ node }: { node: Extract<UiNode, { type: "List" }> }) {
   const env = useEnv();
   const scope = useContext(ScopeCtx);
   const path = node.bindings.check;
   const checked = (node.props.check ?? {}) as Record<string, unknown>;
   const toggle = async (id: string) => {
      if (!path) return;
      const value = checked[id] !== true;
      const ops: StatePatchOp[] =
         typeof node.props.check === "object" && node.props.check !== null
            ? []
            : [{ op: "replace", path, value: {} }];
      ops.push({
         op: "replace",
         path: `${path}/${id.replace(/~/g, "~0").replace(/\//g, "~1")}`,
         value,
      });
      await env.patch(ops);
      await runActions(
         node.on?.change,
         { ...env, state: structuredCloneSet(env.state, path, { ...checked, [id]: value }) },
         scope,
      );
   };
   return (
      <ul className="divide-y rounded-lg border">
         {node.props.items.map((it) => {
            const done = checked[it.id] === true;
            const t = tones[it.tone ?? "neutral"];
            const status = it.status ? statusIcons[it.status] : undefined;
            const row = (
               <>
                  {path && (
                     <span className="mt-0.5">
                        <CheckBox on={done} label={it.title} />
                     </span>
                  )}
                  {status ? (
                     <status.icon
                        className={cn("mt-0.5 size-4 shrink-0", status.className)}
                        aria-label={it.status}
                     />
                  ) : (
                     it.icon && (
                        <IconOf
                           name={it.icon}
                           className={cn(
                              "mt-0.5 text-muted-foreground",
                              it.tone && it.tone !== "neutral" && t.fg,
                           )}
                        />
                     )
                  )}
                  <span className="min-w-0 flex-1">
                     <span
                        className={cn(
                           "block text-ui",
                           done && "text-muted-foreground line-through",
                        )}
                     >
                        <Md>{it.title}</Md>
                     </span>
                     {it.description && (
                        <span className="block text-ui-sm text-muted-foreground">
                           <Md>{it.description}</Md>
                        </span>
                     )}
                  </span>
                  {it.badge && (
                     <span
                        className={cn(
                           "shrink-0 rounded-full border px-2 py-0.5 text-ui-sm",
                           t.box,
                           t.fg,
                        )}
                     >
                        {it.badge}
                     </span>
                  )}
                  {it.meta && (
                     <span className="shrink-0 text-ui-sm text-muted-foreground tabular-nums">
                        {it.meta}
                     </span>
                  )}
               </>
            );
            return (
               <li key={it.id}>
                  {path
                     ? tip(
                          it.tooltip,
                          <button
                             type="button"
                             onClick={() => void toggle(it.id)}
                             className="flex w-full items-start gap-2.5 px-3 py-2 text-left hover:bg-accent/50"
                          >
                             {row}
                          </button>,
                       )
                     : tip(
                          it.tooltip,
                          <div className="flex items-start gap-2.5 px-3 py-2">{row}</div>,
                          true,
                       )}
               </li>
            );
         })}
      </ul>
   );
}

function Timeline({ node }: { node: Extract<UiNode, { type: "Timeline" }> }) {
   return (
      <ol className="grid grid-cols-1">
         {node.props.items.map((it, i) => {
            const t = tones[it.tone ?? "neutral"];
            const last = i === node.props.items.length - 1;
            return (
               <li key={i} className="flex gap-3">
                  <div className="flex flex-col items-center">
                     <span
                        className={cn(
                           "grid size-6 shrink-0 place-items-center rounded-full border bg-background",
                           it.tone && it.tone !== "neutral" ? t.fg : "text-muted-foreground",
                        )}
                     >
                        {it.icon ? (
                           <IconOf name={it.icon} className="size-3.5" />
                        ) : (
                           <span className="size-1.5 rounded-full bg-current" />
                        )}
                     </span>
                     {!last && <span className="w-px flex-1 bg-border" />}
                  </div>
                  <div className={cn("min-w-0 flex-1", !last && "pb-4")}>
                     <div className="flex items-baseline gap-2">
                        <span className="min-w-0 flex-1 text-ui font-medium">{it.title}</span>
                        {it.time && (
                           <span className="shrink-0 text-ui-sm text-muted-foreground tabular-nums">
                              {it.time}
                           </span>
                        )}
                     </div>
                     {it.description && (
                        <Markdown className="text-ui-sm text-muted-foreground">
                           {it.description}
                        </Markdown>
                     )}
                  </div>
               </li>
            );
         })}
      </ol>
   );
}

type Cell = Extract<UiNode, { type: "Table" }>["props"]["rows"][number] extends infer R
   ? R extends unknown[]
      ? R[number]
      : never
   : never;
type Row = { cells: Cell[]; tone?: Tone };
/** A row is an array of cells or `{ cells, tone }`; a cell is text or `{ text, tone?, mono?, icon? }`. */
const rowOf = (r: unknown): Row =>
   Array.isArray(r) ? { cells: r } : { cells: [], ...(r as Partial<Row>) };
const cellText = (c: unknown) =>
   String((typeof c === "object" && c !== null ? (c as { text?: unknown }).text : c) ?? "");
/** Row tints: lighter than the card tones, so cell tones stay readable. */
const rowTone: Record<Tone, string> = {
   neutral: "",
   info: "bg-sky-500/5",
   success: "bg-emerald-500/5",
   warning: "bg-amber-500/5",
   error: "bg-destructive/5",
};

function TableCell({ cell }: { cell: Cell }) {
   if (typeof cell !== "object" || cell === null) return <Md>{cell}</Md>;
   const t = tones[cell.tone ?? "neutral"];
   return tip(
      cell.tooltip,
      <span
         className={cn(
            "inline-flex items-center gap-1",
            cell.mono && "font-mono",
            cell.tone && cell.tone !== "neutral" && t.fg,
            cell.tooltip && "underline decoration-dotted underline-offset-2",
         )}
      >
         {cell.icon && <IconOf name={cell.icon} className="size-3.5" />}
         <Md>{cellText(cell)}</Md>
      </span>,
      true,
   );
}

/** Table rows as shown: filtered by `q` and sorted by a column, both on the cell text. */
export function tableRows(
   rows: unknown[],
   q: string,
   sort: { col: number; desc: boolean } | null,
): Row[] {
   let out = rows.map(rowOf);
   const needle = q.trim().toLowerCase();
   if (needle)
      out = out.filter((r) => r.cells.some((c) => cellText(c).toLowerCase().includes(needle)));
   if (sort) {
      const num = (x: string) => Number.parseFloat(x.replace(/[^\d.-]/g, ""));
      out = [...out].sort((a, b) => {
         const x = cellText(a.cells[sort.col]),
            y = cellText(b.cells[sort.col]);
         const nx = num(x),
            ny = num(y);
         const c =
            Number.isNaN(nx) || Number.isNaN(ny)
               ? x.localeCompare(y, undefined, { numeric: true })
               : nx - ny;
         return sort.desc ? -c : c;
      });
   }
   return out;
}

function DataTable({ node }: { node: Extract<UiNode, { type: "Table" }> }) {
   const [sort, setSort] = useState<{ col: number; desc: boolean } | null>(null);
   const [q, setQ] = useState("");
   const columns = node.props.columns ?? [];
   const rows = useMemo(
      () => tableRows(node.props.rows ?? [], q, sort),
      [node.props.rows, q, sort],
   );
   const click = (col: number) =>
      setSort(sort?.col === col ? (sort.desc ? null : { col, desc: true }) : { col, desc: false });
   return (
      <div className="grid grid-cols-1 gap-2">
         {node.props.filter && (
            <div className="relative w-full max-w-64">
               <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
               <Input
                  className="h-8 pl-7 text-ui"
                  placeholder="Filter rows"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
               />
            </div>
         )}
         <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-ui">
               <thead className="bg-muted/50 text-left">
                  <tr>
                     {columns.map((c, i) => (
                        <th
                           key={i}
                           className="px-3 py-2 font-medium"
                           aria-sort={
                              sort?.col === i ? (sort.desc ? "descending" : "ascending") : undefined
                           }
                        >
                           {node.props.sortable ? (
                              <button
                                 type="button"
                                 onClick={() => click(i)}
                                 className="inline-flex items-center gap-1 hover:text-foreground"
                              >
                                 <Md>{c}</Md>
                                 {sort?.col === i &&
                                    (sort.desc ? (
                                       <ArrowDown className="size-3" />
                                    ) : (
                                       <ArrowUp className="size-3" />
                                    ))}
                              </button>
                           ) : (
                              <Md>{c}</Md>
                           )}
                        </th>
                     ))}
                  </tr>
               </thead>
               <tbody>
                  {rows.map((r, i) => (
                     <tr key={i} className={cn("border-t", rowTone[r.tone ?? "neutral"])}>
                        {r.cells.map((c, j) => (
                           <td key={j} className="px-3 py-2 align-top">
                              <TableCell cell={c} />
                           </td>
                        ))}
                     </tr>
                  ))}
                  {rows.length === 0 && (
                     <tr>
                        <td
                           colSpan={columns.length}
                           className="px-3 py-3 text-center text-muted-foreground"
                        >
                           No rows
                        </td>
                     </tr>
                  )}
               </tbody>
            </table>
         </div>
      </div>
   );
}

export const renderers = {
   Table: ({ node }) => {
      return <DataTable node={node} />;
   },
   List: ({ node }) => {
      return <List node={node} />;
   },
   Timeline: ({ node }) => {
      return <Timeline node={node} />;
   },
} satisfies Renderers;
