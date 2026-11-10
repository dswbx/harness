import { cn } from "@harness/ui";
import { s } from "jsonv-ts";
import { InlineMarkdown as Md } from "../InlineMarkdown";
import type { RawNode, UiNode } from "../tools";
import { uiIcons } from "../uiIcons";
import {
   isVisible,
   itemPath,
   type RenderCtx,
   type Renderers,
   resolveValue,
   type Scope,
   ScopeCtx,
   tones,
} from "./runtime";
import { type Entry, icon, tone } from "./shared";

/** Layout: Stack, Repeat, Grid, Card. */

/** A keypad Grid with `js` actions: a calculator that works without the Agent (the Grid example, mock, tests). */
export function calculatorExample() {
   const calc = "const e = state.calc?.expr ?? '';";
   const solve =
      "try { const v = Function('return (' + (e || '0') + ')')(); return { expr: Number.isFinite(v) ? String(+v.toFixed(10)) : 'Error' }; } catch { return { expr: 'Error' }; }";
   const key = (
      label: string,
      code: string,
      variant: "primary" | "secondary" | "outline" = "outline",
   ) => ({
      type: "Button" as const,
      props: { label, variant },
      on: {
         press: { action: "js" as const, params: { statePath: "/calc", code: `${calc} ${code}` } },
      },
   });
   const put = (label: string, s = label, variant?: "primary") =>
      key(label, `return { expr: (e === 'Error' ? '' : e) + '${s}' };`, variant);
   return {
      type: "Card" as const,
      props: { title: "Calculator" },
      children: [
         {
            type: "Stat" as const,
            props: {
               label: "Result",
               value: {
                  $js: "(state.calc?.expr || '0').replace(/\\*/g, '×').replace(/\\//g, '÷')",
               },
            },
         },
         {
            type: "Grid" as const,
            props: { columns: 4 },
            children: [
               key("⌫", "return { expr: e.slice(0, -1) };", "secondary"),
               key("AC", "return { expr: '' };", "secondary"),
               key(
                  "%",
                  `const r = (() => { ${solve} })(); return { expr: r.expr === 'Error' ? 'Error' : String(Number(r.expr) / 100) };`,
                  "secondary",
               ),
               put("÷", "/", "primary"),
               put("7"),
               put("8"),
               put("9"),
               put("×", "*", "primary"),
               put("4"),
               put("5"),
               put("6"),
               put("−", "-", "primary"),
               put("1"),
               put("2"),
               put("3"),
               put("+", "+", "primary"),
               key("±", "return { expr: e ? '-(' + e + ')' : '-' };"),
               put("0"),
               put("."),
               key("=", solve, "primary"),
            ],
         },
      ],
   };
}

/** Stack's layout props; Repeat lays out its copies with the same ones. */
const layout = {
   direction: s.string({ enum: ["vertical", "horizontal"] }).optional(),
   gap: s.string({ enum: ["sm", "md", "lg"] }).optional(),
   align: s
      .string({
         enum: ["start", "center", "end", "stretch"],
         description: "Cross axis. Default: stretch (vertical), center (horizontal).",
      })
      .optional(),
   justify: s
      .string({
         enum: ["start", "center", "end", "between"],
         description: "Main axis. Default start.",
      })
      .optional(),
   wrap: s
      .boolean({ description: "Horizontal: wrap to a new line when narrow. Default true." })
      .optional(),
   fill: s
      .boolean({
         description:
            "Horizontal: children share the width (default true); false: each keeps its own width.",
      })
      .optional(),
};

export const specs = {
   Stack: {
      description:
         "Lays out children vertically (default) or in a row. In a row, children share the width (badges, buttons, Text keep theirs); `fill: false` lets each keep its own width. `align`/`justify` place them, `wrap: false` keeps one line.",
      children: true,
      props: s.object(layout),
      example: {
         node: {
            type: "Stack",
            children: [
               {
                  type: "Stack",
                  props: { direction: "horizontal", justify: "between", fill: false },
                  children: [
                     { type: "Text", props: { text: "Order #1042", size: "lg", weight: "bold" } },
                     {
                        type: "Badge",
                        props: { text: "shipped", tone: "success", icon: "package" },
                     },
                  ],
               },
               {
                  type: "Stack",
                  props: { direction: "horizontal" },
                  children: [
                     {
                        type: "Card",
                        props: { title: "Ship to", variant: "compact" },
                        children: [
                           {
                              type: "Markdown",
                              props: { text: "Mara Keller, Lindenstrasse 4, Bern" },
                           },
                        ],
                     },
                     {
                        type: "Card",
                        props: { title: "Items", variant: "compact" },
                        children: [
                           { type: "Markdown", props: { text: "2× Espresso cups, 1× Milk jug" } },
                        ],
                     },
                  ],
               },
            ],
         },
      },
   },
   Card: {
      description:
         "A bordered box with an optional header (title, description, icon) and tone; holds children. variant: default, compact (less padding, e.g. small boxes in a row) or plain (no border or background: a titled section).",
      children: true,
      props: s.object({
         title: s.string().optional(),
         description: s.string().optional(),
         tone: tone.optional(),
         icon: icon.optional(),
         variant: s.string({ enum: ["default", "compact", "plain"] }).optional(),
      }),
      example: {
         node: {
            type: "Stack",
            children: [
               {
                  type: "Card",
                  props: { title: "Shakshuka", description: "4 servings · 30 min", icon: "star" },
                  children: [
                     {
                        type: "Markdown",
                        props: { text: "Eggs poached in a spiced tomato and pepper sauce." },
                     },
                  ],
               },
               {
                  type: "Card",
                  props: { title: "Contains eggs", tone: "warning", variant: "compact" },
               },
               {
                  type: "Card",
                  props: { title: "Method", variant: "plain" },
                  children: [
                     {
                        type: "Markdown",
                        props: {
                           text: "1. Soften onion and peppers.\n2. Add tomatoes, simmer 10 min.\n3. Crack in the eggs, cover until set.",
                        },
                     },
                  ],
               },
            ],
         },
      },
   },
   Repeat: {
      description:
         'Renders its children once per item of a state array (`items`: {"$state": "/path"}), laid out like a Stack. Inside, {"$item": "field"} reads the item ("" the whole item), {"$index": true} its index, a $template takes "${field}", {"$bindItem": "field"} writes to it, and visible takes {"$item": "field", "eq"?}. `key` names an item field that identifies it; `empty` is shown when there are no items.',
      children: true,
      props: s.object({
         items: s.array(s.any()),
         key: s.string().optional(),
         empty: s.string().optional(),
         ...layout,
      }),
      example: {
         node: {
            type: "Repeat",
            props: { items: { $state: "/tickets" }, key: "id", gap: "sm", empty: "No tickets." },
            children: [
               {
                  type: "Card",
                  props: {
                     title: { $item: "title" },
                     description: { $template: "${id} · ${customer}" },
                     variant: "compact",
                  },
                  children: [
                     {
                        type: "Stack",
                        props: { direction: "horizontal", fill: false, align: "center", gap: "sm" },
                        children: [
                           {
                              type: "Checkbox",
                              props: { label: "Resolved", value: { $bindItem: "done" } },
                           },
                           {
                              type: "Badge",
                              props: { text: "high priority", tone: "error" },
                              visible: { $item: "priority", eq: "high" },
                           },
                           {
                              type: "Button",
                              props: { label: "Remove", variant: "ghost" },
                              on: {
                                 press: {
                                    action: "removeState",
                                    params: { statePath: "/tickets", index: { $index: true } },
                                 },
                              },
                           },
                        ],
                     },
                  ],
               },
            ],
         },
         state: {
            tickets: [
               {
                  id: "T-311",
                  title: "Refund not received",
                  customer: "Mara K.",
                  priority: "high",
                  done: false,
               },
               {
                  id: "T-312",
                  title: "Cannot change my email",
                  customer: "Tom B.",
                  priority: "normal",
                  done: true,
               },
               {
                  id: "T-315",
                  title: "App crashes on login",
                  customer: "Ines R.",
                  priority: "high",
                  done: false,
               },
            ],
         },
      },
   },
   Grid: {
      description:
         "Children in up to `columns` equal columns (default 3); fewer when the area is narrow. E.g. a row of Stats. Only Buttons: a keypad, always `columns` wide.",
      children: true,
      props: s.object({ columns: s.number({ enum: [2, 3, 4, 5, 6] }).optional() }),
      example: {
         node: {
            type: "Stack",
            children: [
               {
                  type: "Grid",
                  props: { columns: 3 },
                  children: [
                     { type: "Stat", props: { label: "Tests", value: "48", hint: "2 skipped" } },
                     { type: "Stat", props: { label: "Coverage", value: "81%", tone: "success" } },
                     {
                        type: "Stat",
                        props: { label: "Build", value: "42s", tone: "warning", hint: "+6s" },
                     },
                  ],
               },
               calculatorExample(),
            ],
         },
         state: { calc: { expr: "" } },
      },
   },
} as const satisfies Record<string, Entry>;

type Layout = Extract<UiNode, { type: "Stack" }>["props"];
/** In a row, these keep their own width; other children share it. */
const ownWidth = new Set<string>(["Badge", "Button", "Checkbox", "Switch", "FileLink", "Text"]);

/**
 * Stack classes: the container, and the cell that wraps a child sharing a row's width (null: it
 * keeps its own). A row's children share it equally (same height, unless `align` says otherwise)
 * and wrap when narrower than 12rem; `fill: false` lets all keep their width.
 */
export function stackClasses(p: Layout, type: string): { box: string; cell: string | null } {
   const gap = { sm: "gap-1.5", md: "gap-3", lg: "gap-5" }[p.gap ?? "md"];
   const align =
      p.align &&
      { start: "items-start", center: "items-center", end: "items-end", stretch: "items-stretch" }[
         p.align
      ];
   const justify =
      p.justify &&
      {
         start: "justify-start",
         center: "justify-center",
         end: "justify-end",
         between: "justify-between",
      }[p.justify];
   if (p.direction !== "horizontal")
      return { box: cn("flex min-w-0 flex-col", gap, align, justify), cell: null };
   const wrap = p.wrap !== false;
   return {
      box: cn(
         "flex min-w-0 flex-row",
         wrap ? "flex-wrap" : "flex-nowrap",
         align ?? "items-center",
         justify,
         gap,
      ),
      cell:
         p.fill === false || ownWidth.has(type)
            ? null
            : cn(
                 "flex flex-1 basis-0 flex-col [&>*]:flex-1",
                 wrap ? "min-w-48" : "min-w-0",
                 (!p.align || p.align === "stretch") && "self-stretch",
              ),
   };
}

/** Stack's layout (also a Repeat's copies). Each entry renders in its own Repeat scope. */
function StackLayout({
   p,
   entries,
   Node,
}: {
   p: Layout;
   Node: RenderCtx["Node"];
   entries: { key: string | number; raw: RawNode; scope?: Scope }[];
}) {
   return (
      <div className={stackClasses(p, "").box}>
         {entries.map((e) => {
            const cell = stackClasses(p, e.raw.type).cell;
            const el = (
               <ScopeCtx.Provider key={cell ? undefined : e.key} value={e.scope}>
                  <Node raw={e.raw} />
               </ScopeCtx.Provider>
            );
            return cell ? (
               <div key={e.key} className={cell}>
                  {el}
               </div>
            ) : (
               el
            );
         })}
      </div>
   );
}

/** A Repeat's items with their scopes: each item's path under the array's state path (`/tickets/2`). */
export function repeatScopes(raw: RawNode, state: unknown, scope?: Scope): Scope[] {
   const src = raw.props?.items;
   const items = resolveValue(src, state, scope);
   if (!Array.isArray(items)) return [];
   const o = (src ?? {}) as { $state?: unknown; $item?: unknown };
   const base =
      typeof o.$state === "string"
         ? o.$state
         : typeof o.$item === "string"
           ? itemPath(o.$item, scope)
           : undefined;
   return items.map((item, index) => ({
      item,
      index,
      path: base == null ? undefined : `${base}/${index}`,
   }));
}

export const renderers = {
   Stack: ({ node, raw, env, scope, Node }) => {
      // Hidden children leave no gap or empty cell; keys stay their original index.
      const shown = (raw.children ?? [])
         .map((c, i) => ({ key: i, raw: c, scope }))
         .filter((e) => isVisible(e.raw.visible, env.state, scope));
      return <StackLayout p={node.props ?? {}} entries={shown} Node={Node} />;
   },
   Card: ({ node, kids }) => {
      const t = tones[node.props?.tone ?? "neutral"];
      const Icon = (node.props?.icon && uiIcons[node.props.icon]) || t.icon;
      const variant = node.props?.variant ?? "default";
      const body = (kids?.length ?? 0) > 0;
      // compact: less padding, smaller heading; plain: no box, a titled section.
      const head =
         variant === "plain"
            ? "pb-2"
            : variant === "compact"
              ? cn("bg-muted/40 px-2.5 py-1.5", body && "border-b")
              : "border-b bg-muted/40 px-3 py-2.5";
      return (
         <div
            className={cn(
               "min-w-0",
               variant !== "plain" &&
                  cn(
                     "overflow-hidden rounded-lg border",
                     t === tones.neutral ? "bg-card/50" : t.box,
                  ),
            )}
         >
            {node.props?.title && (
               <div className={head}>
                  <div
                     className={cn(
                        "flex items-center gap-2 font-semibold text-foreground",
                        variant === "compact" && "text-ui-sm",
                     )}
                  >
                     {Icon && (
                        <Icon
                           className={cn(
                              "size-4 shrink-0",
                              node.props.tone && node.props.tone !== "neutral"
                                 ? t.fg
                                 : "text-muted-foreground",
                           )}
                        />
                     )}
                     <span className="min-w-0">{node.props.title}</span>
                  </div>
                  {node.props.description && (
                     <div className="mt-0.5 text-ui-sm text-muted-foreground">
                        <Md>{node.props.description}</Md>
                     </div>
                  )}
               </div>
            )}
            {body && (
               <div
                  className={cn(
                     "space-y-2",
                     variant === "plain" ? "" : variant === "compact" ? "p-2.5" : "p-3",
                  )}
               >
                  {kids}
               </div>
            )}
         </div>
      );
   },
   Repeat: ({ node, raw, env, scope, Node }) => {
      const scopes = repeatScopes(raw, env.state, scope);
      if (!scopes.length)
         return node.props.empty ? (
            <div className="text-ui-sm text-muted-foreground">{node.props.empty}</div>
         ) : null;
      const { key } = node.props;
      // Each item renders all children in order; hidden ones leave no gap.
      const entries = scopes.flatMap((s) => {
         const id =
            key && typeof s.item === "object" && s.item !== null
               ? String((s.item as Record<string, unknown>)[key] ?? s.index)
               : s.index;
         return (raw.children ?? [])
            .map((c, j) => ({ key: `${id}:${j}`, raw: c, scope: s }))
            .filter((e) => isVisible(e.raw.visible, env.state, e.scope));
      });
      return <StackLayout p={node.props} entries={entries} Node={Node} />;
   },
   Grid: ({ node, raw, env, scope, Node }) => {
      const n = node.props.columns ?? 3;
      const shown = (raw.children ?? [])
         .map((c, i) => [c, i] as const)
         .filter(([c]) => isVisible(c.visible, env.state, scope));
      // Only Buttons: a keypad, exactly `columns` wide, keys filling their cells.
      if (shown.length && shown.every(([c]) => c.type === "Button")) {
         return (
            <div
               className="grid gap-2 [&_button]:h-10 [&_button]:w-full"
               style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}
            >
               {shown.map(([c, i]) => (
                  <Node key={i} raw={c} />
               ))}
            </div>
         );
      }
      return (
         <div
            className="grid gap-3"
            style={{
               gridTemplateColumns: `repeat(auto-fill, minmax(max(10rem, calc((100% - ${n - 1} * 0.75rem) / ${n})), 1fr))`,
            }}
         >
            {shown.map(([c, i]) => (
               <Node key={i} raw={c} />
            ))}
         </div>
      );
   },
} satisfies Renderers;
