import { s } from "jsonv-ts";
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
export const layout = {
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
