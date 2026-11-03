import { fromSchema, type Schema, type Static, s } from "jsonv-ts";

/**
 * Frontend Tools of the chat Frontend. Serialized into manifest.json by `bun run gen-manifests`.
 *
 * `render_ui` (ADR 0013, 0015): a tree of `{ type, props, children?, on? }` nodes from the catalog
 * below. Data binding follows json-render's syntax so we can adopt the library later: any prop
 * can be `{ "$state": "/path" }` or `{ "$template": "Done: ${/checks/done}" }` (read from the
 * Session State), inputs write with `{ "$bindState": "/path" }`, and `on` runs actions
 * (`setState`, `pushState`, `removeState`, plus our `sendMessage`). Inside a Repeat, json-render's
 * repeat scope: `{ "$item": "field" }`, `{ "$index": true }`, `{ "$bindItem": "field" }`, `${field}`.
 */

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

/** The Html example: a clickable SVG diagram bound to `/html_demo/selected` (gallery, tests). */
function htmlExample() {
   const box = (id: string, x: number, label: string) =>
      `<g class="box" data-box="${id}" data-on-click='{"action":"setState","params":{"statePath":"/html_demo/selected","value":"${id}"}}'><rect x="${x}" y="20" width="120" height="56" rx="8"/><text x="${x + 60}" y="53">${label}</text></g>`;
   const arrow = (x: number) =>
      `<line x1="${x}" y1="48" x2="${x + 36}" y2="48" marker-end="url(#head)"/>`;
   return {
      type: "Html" as const,
      props: {
         title: "Request flow",
         html: [
            "<style>",
            "svg { width: 100%; max-width: 480px; display: block; }",
            ".box rect { fill: var(--card); stroke: var(--border); stroke-width: 1.5; }",
            ".box.on rect { stroke: var(--chart-1); stroke-width: 2.5; }",
            ".box text { fill: var(--foreground); font: 13px var(--font-sans); text-anchor: middle; }",
            "line { stroke: var(--muted-foreground); stroke-width: 1.5; }",
            "#head path { fill: var(--muted-foreground); }",
            "p { margin: 8px 0 0; color: var(--muted-foreground); }",
            "</style>",
            '<svg viewBox="0 0 480 96" role="img" aria-label="Web app calls API, API reads Database">',
            '<defs><marker id="head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z"/></marker></defs>',
            box("web", 2, "Web app"),
            arrow(124),
            box("api", 180, "API"),
            arrow(302),
            box("db", 358, "Database"),
            "</svg>",
            '<p>Selected: <strong data-state="/html_demo/selected"></strong></p>',
            '<p data-visible=\'{"$state":"/html_demo/selected","eq":"api"}\'>The API checks the session, then reads from the database.</p>',
            "<script>harness.subscribe((s) => document.querySelectorAll('[data-box]').forEach((b) => b.classList.toggle('on', b.dataset.box === s?.html_demo?.selected)));</script>",
         ].join("\n"),
      },
   };
}

const tone = s.string({
   enum: ["neutral", "info", "success", "warning", "error"],
   description: "Accent. Default neutral.",
});
/** The core copies local image files named here into the Session (ADR 0012, level 1). */
const imageSrc = s.string({
   format: "harness-image",
   description: "Image file path (relative to the workspace, or absolute) or an https URL.",
});
const image = s.object({
   src: imageSrc,
   alt: s.string({ description: "What the image shows." }),
   caption: s.string().optional(),
});

/** Icons components may show (lucide icons, by these names). */
export const ICONS = [
   "check",
   "x",
   "alert",
   "info",
   "help",
   "file",
   "folder",
   "code",
   "terminal",
   "bug",
   "test",
   "package",
   "git-branch",
   "git-commit",
   "git-pull-request",
   "git-merge",
   "rocket",
   "server",
   "database",
   "globe",
   "lock",
   "key",
   "user",
   "users",
   "clock",
   "calendar",
   "search",
   "link",
   "settings",
   "star",
   "zap",
   "list",
   "message",
   "chart",
] as const;
const icon = s.string({ enum: ICONS, description: "Icon name." });
const tooltip = s.string({
   description:
      "Extra detail shown on hover or keyboard focus. Not on touch screens: never the only place for important information.",
});
const mono = s.boolean({ description: "Monospace, e.g. ids, hashes, durations." });
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

type Example = { node: unknown; state?: unknown };
type Entry = {
   description: string;
   children: boolean;
   props: Schema;
   /** Props that write to the Session State: `{ "$bindState": "/path" }`. */
   bind?: readonly string[];
   /** Events this component fires (`on`). */
   events?: readonly string[];
   /** Shown in the gallery and tested. */
   example: Example;
};

const demoImage = (label: string, hue: number) =>
   "data:image/svg+xml;base64," +
   btoa(
      `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="hsl(${hue} 60% 45%)"/><text x="320" y="212" font-family="sans-serif" font-size="32" fill="white" text-anchor="middle">${label}</text></svg>`,
   );

/** The `render_ui` components. Add components as needed; give each an example. */
export const components = {
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
   Markdown: {
      description:
         "Markdown text. A ```mermaid fence draws a diagram; a ```ansi fence shows terminal colors.",
      children: false,
      props: s.object({ text: s.string() }),
      example: {
         node: {
            type: "Markdown",
            props: {
               text: "**Bold**, `code` and a [link](https://example.com).\n\n```mermaid\nflowchart LR\n  Client --> API --> DB[(Postgres)]\n  API --> Cache\n```",
            },
         },
      },
   },
   Text: {
      description:
         "Short plain text: a label, a number, an arrow or a caption between other components. No Markdown (use Markdown for prose).",
      children: false,
      props: s.object({
         text: s.anyOf([s.string(), s.number()]),
         tone: tone.optional(),
         mono: mono.optional(),
         size: s.string({ enum: ["xs", "sm", "md", "lg"], description: "Default md." }).optional(),
         muted: s.boolean().optional(),
         weight: s.string({ enum: ["normal", "medium", "bold"] }).optional(),
         tooltip: tooltip.optional(),
      }),
      example: {
         node: {
            type: "Stack",
            props: { direction: "horizontal", fill: false, align: "center", gap: "sm" },
            children: [
               {
                  type: "Card",
                  props: { title: "Zürich HB", description: "dep 07:33", variant: "compact" },
               },
               {
                  type: "Stack",
                  props: { align: "center", gap: "sm" },
                  children: [
                     { type: "Text", props: { text: "3h 17m", size: "xs", muted: true } },
                     { type: "Text", props: { text: "→", size: "lg", muted: true } },
                  ],
               },
               {
                  type: "Card",
                  props: {
                     title: "Milano Centrale",
                     description: "arr 10:50 · dep 11:15",
                     variant: "compact",
                  },
               },
               {
                  type: "Stack",
                  props: { align: "center", gap: "sm" },
                  children: [
                     {
                        type: "Text",
                        props: {
                           text: "2h 55m",
                           size: "xs",
                           muted: true,
                           tooltip: "Frecciarossa 9531, coach 6",
                        },
                     },
                     { type: "Text", props: { text: "→", size: "lg", muted: true } },
                  ],
               },
               {
                  type: "Card",
                  props: {
                     title: "Roma Termini",
                     description: "arr 14:10",
                     variant: "compact",
                     tone: "success",
                  },
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
   KeyValue: {
      description: "Label/value rows; a value can take a `tone`, `mono` and a `tooltip`.",
      children: false,
      props: s.object({
         items: s.array(
            s.object({
               label: s.string(),
               value: s.string(),
               tone: tone.optional(),
               mono: mono.optional(),
               tooltip: tooltip.optional(),
            }),
         ),
      }),
      example: {
         node: {
            type: "KeyValue",
            props: {
               items: [
                  { label: "Environment", value: "production", tone: "success" },
                  {
                     label: "Release",
                     value: "v4.2.0",
                     mono: true,
                     tooltip: "Tagged Oct 30 by @ana",
                  },
                  { label: "Error rate", value: "2.4%", tone: "warning" },
                  { label: "Duration", value: "3m 41s" },
               ],
            },
         },
      },
   },
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
   Badge: {
      description: "A short label, e.g. a status.",
      children: false,
      props: s.object({
         text: s.string(),
         tone: tone.optional(),
         icon: icon.optional(),
         tooltip: tooltip.optional(),
      }),
      example: {
         node: {
            type: "Stack",
            props: { direction: "horizontal", gap: "sm" },
            children: [
               {
                  type: "Badge",
                  props: {
                     text: "passing",
                     tone: "success",
                     icon: "check",
                     tooltip: "48 of 48 tests",
                  },
               },
               { type: "Badge", props: { text: "1 flaky", tone: "warning" } },
               { type: "Badge", props: { text: "draft" } },
            ],
         },
      },
   },
   Code: {
      description: "A code block.",
      children: false,
      props: s.object({ code: s.string(), language: s.string().optional() }),
      example: {
         node: {
            type: "Code",
            props: { language: "rust", code: 'let s = std::fs::read_to_string("data.txt")?;' },
         },
      },
   },
   Image: {
      description: "One image; the user can open it full size.",
      children: false,
      props: image,
      example: {
         node: {
            type: "Image",
            props: {
               src: demoImage("Screenshot", 210),
               alt: "Screenshot",
               caption: "A local file path or an https URL",
            },
         },
      },
   },
   Carousel: {
      description: "Several images, one at a time, with previous/next.",
      children: false,
      props: s.object({ images: s.array(image, { minItems: 1 }) }),
      example: {
         node: {
            type: "Carousel",
            props: {
               images: [1, 2, 3].map((i) => ({
                  src: demoImage(`Image ${i}`, 150 + i * 50),
                  alt: `Image ${i}`,
                  caption: `Image ${i} of 3`,
               })),
            },
         },
      },
   },
   Stat: {
      description: "One number or short value with a label, e.g. a count, a total or a status.",
      children: false,
      props: s.object({
         label: s.string(),
         value: s.anyOf([s.string(), s.number()]),
         hint: s.string().optional(),
         tone: tone.optional(),
         tooltip: tooltip.optional(),
      }),
      example: {
         node: {
            type: "Stat",
            props: {
               label: "Tests passing",
               value: { $template: "${/tests/passed} / ${/tests/total}" },
               hint: "2 failing in api/",
            },
         },
         state: { tests: { passed: 46, total: 48 } },
      },
   },
   Progress: {
      description: "A progress bar from 0 to max (default 100).",
      children: false,
      props: s.object({
         value: s.number(),
         max: s.number().optional(),
         label: s.string().optional(),
      }),
      example: {
         node: {
            type: "Progress",
            props: { label: "Files migrated", value: { $state: "/migration/done" }, max: 12 },
         },
         state: { migration: { done: 7 } },
      },
   },
   Choice: {
      description:
         "Options to pick one from (distinct values); writes the picked value to `value` ($bindState). When a pick can be checked, set `answer` to the expected value: after a pick it shows right/wrong, locks, writes true/false to `result` ($bindState) and shows `explanation`. `on.change` runs after a pick.",
      children: false,
      props: s.object({
         options: s.array(s.object({ value: s.string(), label: s.string() }), { minItems: 1 }),
         value: s.any(),
         answer: s.string().optional(),
         result: s.any().optional(),
         explanation: s
            .string({
               description: "Markdown shown after a checked pick: why the expected value is right.",
            })
            .optional(),
         columns: s.number({ enum: [1, 2] }).optional(),
         variant: s
            .string({
               enum: ["list", "buttons", "select"],
               description: "list (default): rows; buttons: a segmented row; select: a dropdown.",
            })
            .optional(),
      }),
      bind: ["value", "result"],
      events: ["change"],
      example: {
         node: {
            type: "Stack",
            children: [
               { type: "Markdown", props: { text: "Where should the preview deploy go?" } },
               {
                  type: "Choice",
                  props: {
                     value: { $bindState: "/deploy/target" },
                     variant: "buttons",
                     options: [
                        { value: "staging", label: "Staging" },
                        { value: "preview", label: "Per-branch preview" },
                     ],
                  },
               },
               {
                  type: "Badge",
                  props: { text: { $template: "Next: deploy to ${/deploy/target}" }, tone: "info" },
                  visible: { $state: "/deploy/target" },
               },
               {
                  type: "Markdown",
                  props: {
                     text: "A pick that can be checked (`answer`, `result`, `explanation`): which call reads a whole file at once?",
                  },
               },
               {
                  type: "Choice",
                  props: {
                     value: { $bindState: "/checks/picks/read" },
                     result: { $bindState: "/checks/results/read" },
                     answer: "string",
                     options: [
                        { value: "string", label: "fs::read_to_string" },
                        { value: "lines", label: "BufReader::lines" },
                     ],
                     explanation:
                        "`read_to_string` returns the whole file as one `String`; `lines` reads it one line at a time.",
                  },
               },
               {
                  type: "Stat",
                  props: {
                     label: "Correct",
                     value: {
                        $computed: "count",
                        args: { values: { $state: "/checks/results" }, eq: true },
                     },
                  },
               },
            ],
         },
         state: { deploy: {}, checks: { picks: {}, results: {} } },
      },
   },
   Input: {
      description:
         "A text field; writes its text to its $bindState path. `multiline` for longer text. `on.submit` runs on Enter (Cmd/Ctrl+Enter when multiline).",
      children: false,
      props: s.object({
         value: s.any(),
         label: s.string().optional(),
         placeholder: s.string().optional(),
         multiline: s.boolean().optional(),
      }),
      bind: ["value"],
      events: ["submit"],
      example: {
         node: {
            type: "Input",
            props: {
               label: "Branch name",
               placeholder: "feat/...",
               value: { $bindState: "/setup/branch" },
            },
         },
         state: { setup: {} },
      },
   },
   Button: {
      description:
         "A button; `on.press` runs its actions. A Grid of only Buttons is a keypad: exactly `columns` wide, keys fill their cells.",
      children: false,
      props: s.object({
         label: s.string(),
         variant: s.string({ enum: ["primary", "secondary", "outline", "ghost"] }).optional(),
         disabled: s.boolean().optional(),
         icon: icon.optional(),
         tooltip: tooltip.optional(),
      }),
      events: ["press"],
      example: {
         node: {
            type: "Stack",
            props: { direction: "horizontal", gap: "sm" },
            children: [
               {
                  type: "Button",
                  props: { label: "Approve plan", icon: "check" },
                  on: {
                     press: {
                        action: "sendMessage",
                        params: { text: { $template: "Approved, go with ${/plan/approach}." } },
                     },
                  },
               },
               {
                  type: "Button",
                  props: { label: "Use a cache instead", variant: "secondary" },
                  on: {
                     press: {
                        action: "setState",
                        params: { statePath: "/plan/approach", value: "cache" },
                     },
                  },
               },
               { type: "Badge", props: { text: { $template: "Approach: ${/plan/approach}" } } },
            ],
         },
         state: { plan: { approach: "index" } },
      },
   },
   Popover: {
      description:
         "A click opens a small floating box with the children: details, a form or actions next to the thing they belong to. The trigger is a button from `label` (+ `icon`, `variant`); without `label`, the first child is the trigger (e.g. a Badge or Text; not a Button) and the other children are the content. State, bindings and actions work inside, also in a Repeat. Closes on a click outside or Escape.",
      children: true,
      props: s.object({
         label: s
            .string({
               description: "Trigger button text. Without it, the first child is the trigger.",
            })
            .optional(),
         icon: icon.optional(),
         variant: s
            .string({
               enum: ["primary", "secondary", "outline", "ghost"],
               description: "Trigger button style. Default outline.",
            })
            .optional(),
         title: s.string({ description: "Heading inside the box." }).optional(),
         width: s
            .string({ enum: ["sm", "md", "lg"], description: "Box width. Default md." })
            .optional(),
      }),
      example: {
         node: {
            type: "Stack",
            props: { direction: "horizontal", fill: false, align: "center", gap: "sm" },
            children: [
               {
                  type: "Popover",
                  props: { title: "Room 4B" },
                  children: [
                     {
                        type: "Badge",
                        props: {
                           text: { $template: "Room 4B · ${/room/status}" },
                           icon: "calendar",
                           tone: "info",
                        },
                     },
                     {
                        type: "KeyValue",
                        props: {
                           items: [
                              { label: "Seats", value: "8" },
                              { label: "Screen", value: "65 in, HDMI" },
                           ],
                        },
                     },
                     {
                        type: "Button",
                        props: { label: "Book 14:00 to 15:00", icon: "check" },
                        on: {
                           press: {
                              action: "setState",
                              params: { statePath: "/room/status", value: "booked" },
                           },
                        },
                     },
                  ],
               },
               {
                  type: "Popover",
                  props: { label: "Filters", icon: "search", width: "sm" },
                  children: [
                     {
                        type: "Input",
                        props: {
                           label: "Floor",
                           placeholder: "e.g. 4",
                           value: { $bindState: "/room/floor" },
                        },
                     },
                     {
                        type: "Checkbox",
                        props: { label: "Has a screen", value: { $bindState: "/room/screen" } },
                     },
                  ],
               },
            ],
         },
         state: { room: { status: "free" } },
      },
   },
   Tabs: {
      description:
         "Tabs: one child per tab, one shown at a time; for parts the user browses in any order. `value` ($bindState, optional) holds the open tab's index.",
      children: true,
      props: s.object({ tabs: s.array(s.string(), { minItems: 1 }), value: s.any().optional() }),
      bind: ["value"],
      example: {
         node: {
            type: "Tabs",
            props: { tabs: ["Summary", "Details"] },
            children: [
               { type: "Markdown", props: { text: "Short summary." } },
               { type: "KeyValue", props: { items: [{ label: "Files", value: "3" }] } },
            ],
         },
      },
   },
   Stepper: {
      description:
         "Steps shown one at a time with Back/Next, e.g. a setup, a review of findings, or a quiz: one child per step. `value` ($bindState, optional) holds the step index. `on.finish` runs when the user presses Finish on the last step.",
      children: true,
      props: s.object({ steps: s.array(s.string(), { minItems: 1 }), value: s.any().optional() }),
      bind: ["value"],
      events: ["finish"],
      example: {
         node: {
            type: "Stepper",
            props: { steps: ["Target", "Branch", "Confirm"] },
            on: {
               finish: {
                  action: "sendMessage",
                  params: {
                     text: { $template: "Set it up: ${/setup/target}, branch ${/setup/branch}." },
                  },
               },
            },
            children: [
               {
                  type: "Choice",
                  props: {
                     value: { $bindState: "/setup/target" },
                     options: [
                        { value: "staging", label: "Staging" },
                        { value: "production", label: "Production" },
                     ],
                  },
               },
               {
                  type: "Input",
                  props: {
                     label: "Branch name",
                     placeholder: "feat/...",
                     value: { $bindState: "/setup/branch" },
                  },
               },
               {
                  type: "Markdown",
                  props: {
                     text: {
                        $template:
                           "Deploy `${/setup/branch}` to **${/setup/target}**. Press Finish to start.",
                     },
                  },
               },
            ],
         },
         state: { setup: { target: "staging", branch: "main" } },
      },
   },
   Diff: {
      description:
         "A code diff, highlighted. Give `patch` (a unified git diff; several files are fine) or `path` with `old` and `new` text. File names open the file in the user's editor.",
      children: false,
      props: s.object({
         patch: s.string().optional(),
         path: s.string().optional(),
         old: s.string().optional(),
         new: s.string().optional(),
      }),
      example: {
         node: {
            type: "Diff",
            props: {
               path: "src/config.ts",
               old: "export const retries = 3;\nexport const timeoutMs = 1000;\n",
               new: "export const retries = 5;\nexport const timeoutMs = 1000;\nexport const backoff = true;\n",
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
   Checkbox: {
      description:
         "One checkbox; writes true/false to `value` ($bindState). `on.change` runs after a toggle.",
      children: false,
      props: s.object({ label: s.string(), description: s.string().optional(), value: s.any() }),
      bind: ["value"],
      events: ["change"],
      example: {
         node: {
            type: "Checkbox",
            props: {
               label: "Also update the docs",
               description: "README and the API reference",
               value: { $bindState: "/opts/docs" },
            },
         },
         state: { opts: {} },
      },
   },
   Switch: {
      description:
         "An on/off switch; writes true/false to `value` ($bindState). `on.change` runs after a toggle.",
      children: false,
      props: s.object({ label: s.string(), description: s.string().optional(), value: s.any() }),
      bind: ["value"],
      events: ["change"],
      example: {
         node: {
            type: "Switch",
            props: { label: "Run the slow tests", value: { $bindState: "/opts/slow" } },
         },
         state: { opts: { slow: true } },
      },
   },
   Accordion: {
      description:
         "Collapsible sections: one child per item, titled by `items`. `multiple` lets several stay open; `open` lists indexes open at first.",
      children: true,
      props: s.object({
         items: s.array(s.string(), { minItems: 1 }),
         multiple: s.boolean().optional(),
         open: s.array(s.number()).optional(),
      }),
      example: {
         node: {
            type: "Accordion",
            props: { items: ["2 errors", "5 warnings"], open: [0] },
            children: [
               {
                  type: "Markdown",
                  props: {
                     text: "- `api/users.ts:42` type mismatch\n- `api/auth.ts:7` unused import",
                  },
               },
               { type: "Markdown", props: { text: "Mostly unused variables in tests." } },
            ],
         },
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
   Chart: {
      description:
         "A chart of `data` (rows of objects; bindable). `x` names the label key, `series` the numeric keys to plot. type: bar, line, area or pie (pie uses the first series).",
      children: false,
      props: s.object({
         type: s.string({ enum: ["bar", "line", "area", "pie"] }),
         data: s.array(s.object({})),
         x: s.string(),
         series: s.array(s.object({ key: s.string(), label: s.string().optional() }), {
            minItems: 1,
         }),
         stacked: s.boolean().optional(),
         height: s.number().optional(),
      }),
      example: {
         node: {
            type: "Chart",
            props: {
               type: "bar",
               x: "route",
               series: [
                  { key: "before", label: "Before (ms)" },
                  { key: "after", label: "After (ms)" },
               ],
               data: [
                  { route: "/", before: 180, after: 95 },
                  { route: "/search", before: 420, after: 160 },
                  { route: "/settings", before: 140, after: 120 },
               ],
            },
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
   Log: {
      description:
         "Terminal or log output with its ANSI colors, in a scrolling box that starts at the end. `title` names it, e.g. the command.",
      children: false,
      props: s.object({ text: s.string(), title: s.string().optional() }),
      example: {
         node: {
            type: "Log",
            props: {
               title: "bun test",
               text: "\u001b[1mbun test\u001b[0m v1.3\n\u001b[32m✓\u001b[0m users > creates a user \u001b[2m[3ms]\u001b[0m\n\u001b[31m✗\u001b[0m users > rejects a duplicate email\n  \u001b[31mexpected 409, got 500\u001b[0m\n\n \u001b[32m1 pass\u001b[0m\n \u001b[31m1 fail\u001b[0m",
            },
         },
      },
   },
   Trace: {
      description:
         "A trace waterfall: spans with `start` and `duration` (same unit, e.g. ms) and an optional `parent` id, drawn as bars on one time axis. E.g. a request's steps or a build's phases.",
      children: false,
      props: s.object({
         spans: s.array(
            s.object({
               id: s.string(),
               name: s.string(),
               start: s.number(),
               duration: s.number(),
               parent: s.string().optional(),
               tone: tone.optional(),
               meta: s.string({ description: "Shown on hover." }).optional(),
            }),
            { minItems: 1 },
         ),
         unit: s.string({ description: "Default ms." }).optional(),
      }),
      example: {
         node: {
            type: "Trace",
            props: {
               spans: [
                  { id: "req", name: "GET /search", start: 0, duration: 420 },
                  { id: "auth", name: "auth", start: 5, duration: 30, parent: "req" },
                  {
                     id: "db",
                     name: "db.query",
                     start: 40,
                     duration: 310,
                     parent: "req",
                     tone: "warning",
                     meta: "full table scan on items",
                  },
                  { id: "render", name: "render", start: 355, duration: 60, parent: "req" },
               ],
            },
         },
      },
   },
   FileLink: {
      description:
         "A link that opens a file of the workspace, at a line, in the user's editor. `path` is relative to the workspace (or absolute inside it).",
      children: false,
      props: s.object({
         path: s.string(),
         line: s.number().optional(),
         label: s.string().optional(),
      }),
      example: {
         node: {
            type: "Stack",
            props: { direction: "horizontal", gap: "sm" },
            children: [
               { type: "FileLink", props: { path: "src/api/users.ts", line: 42 } },
               { type: "FileLink", props: { path: "README.md", label: "Setup notes" } },
            ],
         },
      },
   },
   PullRequest: {
      description:
         "A GitHub pull request: state, title, branches, +/- stats, checks, review. variant: summary (default), card or compact.",
      children: false,
      props: s.object({
         repo: s.string({ description: "owner/name" }),
         number: s.number(),
         title: s.string(),
         state: s.string({ enum: ["open", "draft", "merged", "closed"] }),
         url: s.string({ description: "Link to the PR." }).optional(),
         head: s.string({ description: "Branch name." }).optional(),
         base: s.string({ description: "Branch name." }).optional(),
         author: s.string().optional(),
         updated: s.string({ description: 'E.g. "2m ago".' }).optional(),
         additions: s.number().optional(),
         deletions: s.number().optional(),
         files: s.number().optional(),
         commits: s.number().optional(),
         checks: s
            .object({
               passed: s.number(),
               pending: s.number().optional(),
               failed: s.number().optional(),
            })
            .optional(),
         review: s
            .string({ enum: ["approved", "changes_requested", "required", "none"] })
            .optional(),
         labels: s.array(s.string()).optional(),
         note: s.string({ description: 'E.g. "Merged into main 2h ago".' }).optional(),
         variant: s
            .string({ enum: ["summary", "card", "compact"], description: "Default summary." })
            .optional(),
      }),
      example: {
         node: {
            type: "Stack",
            props: { gap: "sm" },
            children: [
               {
                  type: "PullRequest",
                  props: {
                     repo: "acme/shop",
                     number: 482,
                     title: "Fix empty cart total",
                     state: "open",
                     url: "https://github.com/acme/shop/pull/482",
                     head: "fix/cart-total",
                     base: "main",
                     additions: 42,
                     deletions: 7,
                     files: 3,
                     checks: { passed: 8, pending: 1 },
                     review: "required",
                  },
               },
               {
                  type: "PullRequest",
                  props: {
                     repo: "acme/shop",
                     number: 479,
                     title: "Add order export",
                     state: "merged",
                     head: "feat/export",
                     base: "main",
                     additions: 310,
                     deletions: 12,
                     files: 9,
                     checks: { passed: 9 },
                     review: "approved",
                     variant: "card",
                     author: "dswbx",
                     updated: "2h ago",
                     commits: 4,
                     labels: ["feature"],
                     url: "https://github.com/acme/shop/pull/479",
                     note: "Merged into main 2h ago",
                  },
               },
               {
                  type: "PullRequest",
                  props: {
                     repo: "acme/shop",
                     number: 490,
                     title: "WIP: new checkout",
                     state: "draft",
                     additions: 120,
                     deletions: 30,
                     checks: { passed: 5, failed: 1 },
                     variant: "compact",
                  },
               },
            ],
         },
      },
   },
   Html: {
      description:
         "Free HTML/SVG in a sandboxed frame, for diagrams and custom visuals the catalog cannot show (e.g. an architecture diagram). Prefer catalog components for normal UI. Connects to the Session State with data-* attributes and `window.harness` (see above).",
      children: false,
      props: s.object({
         html: s.string({
            description:
               "Body content: HTML or SVG with inline <style> and <script>. No network; images from data: or https URLs. Theme colors: var(--foreground), --muted-foreground, --card, --border, --primary, --chart-1 to --chart-5.",
         }),
         height: s
            .number({
               minimum: 40,
               maximum: 2000,
               description:
                  "Maximum height in px; taller content scrolls inside the frame. The frame always fits its content, so leave it out unless the content can grow very tall.",
            })
            .optional(),
         title: s.string({ description: "What it shows (frame title)." }).optional(),
      }),
      example: { node: htmlExample(), state: { html_demo: { selected: "" } } },
   },
} as const satisfies Record<string, Entry>;

type Components = typeof components;
export type ComponentType = keyof Components;

/** An action an event runs (json-render's built-ins plus `sendMessage`). */
/** A state path, or `{ $item: "field" }` for a field of the current Repeat item. */
export type StatePath = string | { $item: string };
export type UiAction =
   | { action: "setState"; params: { statePath: StatePath; value: unknown } }
   | { action: "pushState"; params: { statePath: StatePath; value: unknown } }
   | { action: "removeState"; params: { statePath: StatePath; index?: number | { $index: true } } }
   | { action: "sendMessage"; params: { text: unknown } }
   | { action: "js"; params: { statePath: StatePath; code: string } };
type On = Partial<Record<"press" | "change" | "submit" | "finish", UiAction | UiAction[]>>;

/** A node as the Agent sends it: props may hold `$state`/`$template`/`$bindState` expressions. */
/** json-render's visibility conditions: truthy `$state` (or a Repeat's `$item`/`$index`), with `eq`/`neq`/`not`; `$and`/`$or`. */
type Cond = { eq?: unknown; neq?: unknown; not?: boolean };
export type Visible =
   | boolean
   | ({ $state: string } & Cond)
   | ({ $item: string } & Cond)
   | ({ $index: true } & Cond)
   | { $and: Visible[] }
   | { $or: Visible[] };
export type RawNode = {
   type: ComponentType;
   props?: Record<string, unknown>;
   children?: RawNode[];
   on?: On;
   visible?: Visible;
};
/** A node after binding: plain props, and the state paths its bound props write to. */
export type UiNode = {
   [K in ComponentType]: {
      type: K;
      props: Static<Components[K]["props"]>;
      children?: UiNode[];
      on?: On;
      visible?: Visible;
      bindings: Record<string, string>;
   };
}[ComponentType];

/**
 * Built-in `$computed` functions (json-render's syntax; it registers its own by name).
 * `count`: entries of `values` (array or object) equal to `eq` (default true). `length`: all entries.
 * `sum`: numbers in `values`.
 */
export const COMPUTED = ["count", "length", "sum"] as const;

export const PLACEMENTS = ["inline", "top", "bottom", "left", "right"] as const;
export type Placement = (typeof PLACEMENTS)[number];
export type RenderUiInput = {
   root?: RawNode;
   id?: string;
   placement?: Placement;
   title?: string;
   icon?: (typeof ICONS)[number];
   remove?: boolean;
};

const names = Object.keys(components) as ComponentType[];
const parents = names.filter((n) => (components[n] as Entry).children);
const andList = (xs: string[]) => `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;
const node = "#/$defs/node";
const json = (x: Schema) =>
   JSON.parse(JSON.stringify(x)) as { properties?: Record<string, object>; required?: string[] };

/** Props schema: each prop also takes an expression; bound props take `$bindState`. */
function propsSchema(c: Entry) {
   const p = json(c.props);
   const properties = Object.fromEntries(
      Object.entries(p.properties ?? {}).map(([k, v]) => [
         k,
         c.bind?.includes(k) ? { $ref: "#/$defs/bind" } : { anyOf: [v, { $ref: "#/$defs/expr" }] },
      ]),
   );
   return { ...p, properties, additionalProperties: false };
}

const actionList = {
   anyOf: [{ $ref: "#/$defs/action" }, { type: "array", items: { $ref: "#/$defs/action" } }],
};

/** One node schema: `type` picks the props schema (`if`/`then`), so errors name the wrong prop. */
const renderUiJson = {
   type: "object",
   properties: {
      id: {
         type: "string",
         description:
            "Names this item: a later call with the same id replaces it. Required for top, bottom, left and right.",
      },
      placement: {
         type: "string",
         enum: PLACEMENTS,
         description:
            "Where it shows: inline in the chat (default), or in a live area of the chat: top, bottom, or a panel on the left or right side (the user can move it to any other zone).",
      },
      title: { type: "string", description: "Label of the left or right panel." },
      icon: {
         type: "string",
         enum: ICONS,
         description: "Icon of the left or right panel, in the panel strip.",
      },
      remove: { const: true, description: "Remove the item with this id." },
      root: { $ref: node },
   },
   additionalProperties: false,
   allOf: [
      {
         if: { properties: { remove: { const: true } }, required: ["remove"] },
         then: { required: ["id"] },
         else: { required: ["root"] },
      },
      {
         if: {
            properties: { placement: { enum: ["top", "bottom", "left", "right"] } },
            required: ["placement"],
         },
         then: { required: ["id"] },
      },
   ],
   $defs: {
      expr: {
         description:
            'Read from the Session State: {"$state": "/path"}, {"$template": "Done: ${/checks/done}"}, {"$computed": "count"|"length"|"sum", "args": {"values", "eq"?}}, or {"$js": "JavaScript"} (an expression or a function body with return; `state` is the Session State). Inside a Repeat: {"$item": "field"} and {"$index": true}.',
         oneOf: [
            {
               type: "object",
               properties: { $state: { type: "string" } },
               required: ["$state"],
               additionalProperties: false,
            },
            {
               type: "object",
               properties: { $item: { type: "string" } },
               required: ["$item"],
               additionalProperties: false,
            },
            {
               type: "object",
               properties: { $index: { const: true } },
               required: ["$index"],
               additionalProperties: false,
            },
            {
               type: "object",
               properties: { $template: { type: "string" } },
               required: ["$template"],
               additionalProperties: false,
            },
            {
               type: "object",
               properties: { $js: { type: "string" } },
               required: ["$js"],
               additionalProperties: false,
            },
            {
               type: "object",
               properties: {
                  $computed: { type: "string", enum: COMPUTED },
                  args: {
                     type: "object",
                     properties: { values: {}, eq: {} },
                     required: ["values"],
                     additionalProperties: false,
                  },
               },
               required: ["$computed", "args"],
               additionalProperties: false,
            },
         ],
      },
      visible: {
         description:
            'Show the node only when true: {"$state": "/path"} (truthy), with "eq", "neq" or "not": true; inside a Repeat also {"$item": "field"} or {"$index": true}; {"$and": [...]}, {"$or": [...]}; or a boolean.',
         anyOf: [
            { type: "boolean" },
            {
               type: "object",
               properties: {
                  $state: { type: "string" },
                  eq: {},
                  neq: {},
                  not: { type: "boolean" },
               },
               required: ["$state"],
               additionalProperties: false,
            },
            {
               type: "object",
               properties: { $item: { type: "string" }, eq: {}, neq: {}, not: { type: "boolean" } },
               required: ["$item"],
               additionalProperties: false,
            },
            {
               type: "object",
               properties: { $index: { const: true }, eq: {}, neq: {}, not: { type: "boolean" } },
               required: ["$index"],
               additionalProperties: false,
            },
            {
               type: "object",
               properties: { $and: { type: "array", items: { $ref: "#/$defs/visible" } } },
               required: ["$and"],
               additionalProperties: false,
            },
            {
               type: "object",
               properties: { $or: { type: "array", items: { $ref: "#/$defs/visible" } } },
               required: ["$or"],
               additionalProperties: false,
            },
         ],
      },
      bind: {
         description:
            'Two-way binding: {"$bindState": "/path"}; inside a Repeat, {"$bindItem": "field"} for a field of the item.',
         oneOf: [
            {
               type: "object",
               properties: { $bindState: { type: "string" } },
               required: ["$bindState"],
               additionalProperties: false,
            },
            {
               type: "object",
               properties: { $bindItem: { type: "string" } },
               required: ["$bindItem"],
               additionalProperties: false,
            },
         ],
      },
      path: {
         anyOf: [
            { type: "string" },
            {
               type: "object",
               properties: { $item: { type: "string" } },
               required: ["$item"],
               additionalProperties: false,
            },
         ],
         description: 'A state path; inside a Repeat, {"$item": "field"} for a field of the item.',
      },
      action: {
         type: "object",
         properties: {
            action: {
               type: "string",
               enum: ["setState", "pushState", "removeState", "sendMessage", "js"],
            },
            params: { type: "object" },
         },
         required: ["action", "params"],
         additionalProperties: false,
         allOf: [
            {
               if: { properties: { action: { enum: ["setState", "pushState"] } } },
               then: {
                  properties: {
                     params: {
                        type: "object",
                        properties: { statePath: { $ref: "#/$defs/path" }, value: {} },
                        required: ["statePath", "value"],
                        additionalProperties: false,
                     },
                  },
               },
            },
            {
               if: { properties: { action: { const: "removeState" } } },
               then: {
                  properties: {
                     params: {
                        type: "object",
                        properties: {
                           statePath: { $ref: "#/$defs/path" },
                           index: {
                              anyOf: [
                                 { type: "integer" },
                                 {
                                    type: "object",
                                    properties: { $index: { const: true } },
                                    required: ["$index"],
                                    additionalProperties: false,
                                 },
                              ],
                           },
                        },
                        required: ["statePath"],
                        additionalProperties: false,
                     },
                  },
               },
            },
            {
               if: { properties: { action: { const: "js" } } },
               then: {
                  properties: {
                     params: {
                        type: "object",
                        properties: {
                           statePath: { $ref: "#/$defs/path" },
                           code: { type: "string" },
                        },
                        required: ["statePath", "code"],
                        additionalProperties: false,
                     },
                  },
               },
            },
            {
               if: { properties: { action: { const: "sendMessage" } } },
               then: {
                  properties: {
                     params: {
                        type: "object",
                        properties: {
                           text: { anyOf: [{ type: "string" }, { $ref: "#/$defs/expr" }] },
                        },
                        required: ["text"],
                        additionalProperties: false,
                     },
                  },
               },
            },
         ],
      },
      node: {
         type: "object",
         properties: {
            type: { type: "string", enum: names },
            props: { type: "object" },
            children: {
               type: "array",
               items: { $ref: node },
               description: `Only for ${andList(parents)}.`,
            },
            on: {
               type: "object",
               properties: {
                  press: actionList,
                  change: actionList,
                  submit: actionList,
                  finish: actionList,
               },
               additionalProperties: false,
            },
            visible: { $ref: "#/$defs/visible" },
         },
         required: ["type"],
         additionalProperties: false,
         allOf: names.map((n) => {
            const c: Entry = components[n];
            const props = propsSchema(c);
            return {
               if: { properties: { type: { const: n } } },
               then: {
                  properties: { props, ...(c.children ? {} : { children: { maxItems: 0 } }) },
                  ...(props.required?.length ? { required: ["props"] } : {}),
               },
            };
         }),
      },
   },
};

export const renderUiSchema: Schema = fromSchema(renderUiJson as never);

/** The catalog as text for the tool description: agents that drop parts of a schema still see it. */
function catalogText(): string {
   return names
      .map((n) => {
         const c: Entry = components[n];
         const p = json(c.props) as {
            properties?: Record<string, { enum?: unknown[] }>;
            required?: string[];
         };
         const props = Object.entries(p.properties ?? {})
            .map(
               ([k, v]) =>
                  `${k}${p.required?.includes(k) ? "" : "?"}${c.bind?.includes(k) ? ": $bindState" : v.enum && v.enum.length <= 6 ? `: ${v.enum.join("|")}` : ""}`,
            )
            .join(", ");
         const events = c.events ? ` on: ${c.events.join(", ")}.` : "";
         return `- ${n}(${props})${c.children ? " + children" : ""}: ${c.description}${events}`;
      })
      .join("\n");
}

export const RENDER_UI = "render_ui";

export const frontendTools = [
   {
      name: RENDER_UI,
      description:
         "Show rich, optionally interactive content to the user: cards, grids, lists, tables, charts, diffs, file links, timelines, traces, logs, images, stats, tabs, steppers, accordions, choices, checkboxes, inputs, buttons. " +
         `Input: {"root": node, "placement"?, "id"?, "title"?, "icon"?}. A node is {"type", "props", "children"?, "on"?, "visible"?}; only ${andList(parents)} take children.\n` +
         "Placement: inline in the chat (default) or a live area: top, bottom, or a panel at the left or right (needs an id and a title, an icon is optional; right opens in the top right zone, left in the top left; the user can move it). " +
         'A call with the same id replaces that item; {"id", "remove": true} removes it.\n' +
         'Session State: any prop can be {"$state": "/path"}, {"$template": "Branch: ${/setup/branch}"} or {"$computed": "count", "args": {"values": {"$state": "/checks"}, "eq": true}} (also "length" and "sum") and updates when the state changes (change it with state_patch). ' +
         'Choice and Input write the user\'s input with {"$bindState": "/path"}. ' +
         'on.press/change/submit/finish run actions: {"action": "setState"|"pushState", "params": {"statePath", "value"}}, {"action": "removeState", "params": {"statePath", "index"?}}, ' +
         '{"action": "sendMessage", "params": {"text"}} (sends the text to you as the user\'s next message; text can be a $template), ' +
         '{"action": "js", "params": {"statePath", "code"}} (runs JavaScript, an expression or a function body with return, with `state` in scope, and writes its result to statePath; actions in a list see the writes before them). ' +
         "JavaScript ($js, js) runs sandboxed in the app without you, e.g. a calculator or a converter: no DOM, network or timers, 50 ms at most, JSON in and out. " +
         '"visible" shows a node only when the state says so, e.g. {"$state": "/setup/target"} (picked) or {"$state": "/setup/step", "eq": 2}. ' +
         "The user's state changes do not reach you by themselves: add a sendMessage when you must react.\n" +
         'Data from state: Repeat renders its children per item of a state array; inside, {"$item": "field"}, {"$index": true}, "${field}" in a $template, {"$bindItem": "field"}, visible {"$item": "field", "eq"?}; in actions, statePath {"$item": "field"} and removeState index {"$index": true}. When the data changes, patch the state instead of sending the tree again.\n' +
         "Layout: compose generic parts (Stack with direction, align, justify, wrap, fill; Card variants; Text for short labels, numbers and arrows between parts; Table cells and KeyValue values with a tone) instead of asking for a special component.\n" +
         "Keep related parts in one item: Tabs for parts in any order, a Stepper for steps in order (a setup, a review, a quiz). A Choice whose pick can be checked takes `answer`, `result` and `explanation`.\n" +
         "Html: only for diagrams and custom visuals the catalog cannot show (architecture diagrams, annotated drawings); it runs in a sandboxed frame with the app's theme colors as CSS variables. " +
         'Attributes: data-state="/path" (shows the value as text), data-visible=\'{"$state": "/path", "eq": "x"}\' (same syntax as visible), data-on-click=\'<action or array>\' and data-on-change (run actions), data-bind="/path" on input, select and textarea (two-way). ' +
         "Scripts get window.harness: state, get(path), subscribe(fn), patch(ops), send(text), run(actions).\n" +
         "Short text props (table cells and headings, KeyValue, List items, Choice labels, Card descriptions) take inline Markdown: `code`, **bold**, *italic*, links.\n" +
         "Use it for results, status, comparisons, screenshots, decisions you need from the user, or guided tasks, instead of a long plain message.\n" +
         `Icons (the icon prop): ${ICONS.join(", ")}.\nComponents:\n` +
         catalogText(),
      schema: renderUiJson,
   },
] as const;
