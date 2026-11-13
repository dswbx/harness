import { fromSchema, type Schema, type Static, s } from "jsonv-ts";
import * as charts from "./renderUi/charts.spec";
import * as code from "./renderUi/code.spec";
import * as data from "./renderUi/data.spec";
import * as disclosure from "./renderUi/disclosure.spec";
import * as forms from "./renderUi/forms.spec";
import * as layout from "./renderUi/layout.spec";
import * as media from "./renderUi/media.spec";
import { type Entry, ICONS } from "./renderUi/shared";
import * as text from "./renderUi/text.spec";

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

export { calculatorExample } from "./renderUi/layout.spec";
export { ICONS } from "./renderUi/shared";

/** The catalog is the groups' specs together: `renderUi/` has one file per group, spec and renderer side by side. */

/**
 * Order of the components in the schema and the tool description. Fixed so manifest.json stays
 * stable; a new component needs no entry here (it follows the listed ones, in group order).
 */
const ORDER = [
   "Stack",
   "Card",
   "Markdown",
   "Text",
   "Repeat",
   "KeyValue",
   "Table",
   "Badge",
   "Code",
   "Image",
   "Carousel",
   "Stat",
   "Progress",
   "Choice",
   "Input",
   "Button",
   "Popover",
   "Tabs",
   "Stepper",
   "Diff",
   "List",
   "Checkbox",
   "Switch",
   "Accordion",
   "Timeline",
   "Chart",
   "Grid",
   "Log",
   "Trace",
   "FileLink",
   "PullRequest",
   "Html",
] as string[];
const rank = (n: string) => {
   const i = ORDER.indexOf(n);
   return i < 0 ? ORDER.length : i;
};
const merged = {
   ...layout.specs,
   ...text.specs,
   ...code.specs,
   ...media.specs,
   ...charts.specs,
   ...data.specs,
   ...forms.specs,
   ...disclosure.specs,
};

/** The `render_ui` components. Add one to a group in `renderUi/`, with its example. */
export const components = Object.fromEntries(
   Object.entries(merged).sort(([a], [b]) => rank(a) - rank(b)),
) as typeof merged satisfies Record<string, Entry>;

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
   /** A file-backed panel (ADR 0023): a `.md`, `.html` or `.json` file in the Session's `panels_dir`, instead of `root`. */
   source?: string;
   id?: string;
   placement?: Placement;
   title?: string;
   icon?: (typeof ICONS)[number];
   remove?: boolean;
};

/**
 * A file-backed item (`source`, ADR 0023) as a node that names its file: Markdown for `.md`, Html
 * for `.html`, the internal `SourceTree` for `.json` (a render_ui tree). So every place that shows a `root` (chat rows, live areas, panels, artifacts) shows
 * the file. The renderer reads it; the log keeps only the name, so replay shows the file as it is
 * now. The node schemas have no `source` prop, so only this makes such a node.
 */
export function withSourceRoot(v: RenderUiInput): RenderUiInput {
   if (v.root || typeof v.source !== "string") return v;
   const shared = sharedRef(v.source);
   if (shared) return { ...v, root: sharedNode(shared) };
   if (v.source.endsWith(".json")) return { ...v, root: sourceTreeNode(v.source) };
   const type = v.source.endsWith(".html") ? "Html" : "Markdown";
   return { ...v, root: { type, props: { source: v.source } } };
}

/** The Shared Artifact id in a `source` of `shared:<id>` (ADR 0024), else null. */
export function sharedRef(source: unknown): string | null {
   return typeof source === "string" && source.startsWith("shared:")
      ? source.slice("shared:".length) || null
      : null;
}

/**
 * The internal node that shows a Shared Artifact (ADR 0024): not in the catalog, so only the reducer
 * makes one (the Agent sends `source: "shared:<id>"`). The renderer reads the artifact and shows it by kind.
 */
export const sharedNode = (id: string): RawNode => ({
   type: "Shared" as ComponentType,
   props: { id },
});

/** The Shared Artifact a node shows, when it is the internal `Shared` node. */
export function sharedNodeId(n: RawNode): string | null {
   return (n.type as string) === "Shared" && typeof n.props?.id === "string" ? n.props.id : null;
}

/**
 * The internal node that shows a `.json` panel source: a render_ui tree (`{"root": node}`) read from
 * the file and bound to the Session State. Not in the catalog, so only the reducer makes one.
 */
export const sourceTreeNode = (source: string): RawNode => ({
   type: "SourceTree" as ComponentType,
   props: { source },
});

/** The `.json` source a node shows, when it is the internal `SourceTree` node. */
export function sourceTreeName(n: RawNode): string | null {
   return (n.type as string) === "SourceTree" && typeof n.props?.source === "string"
      ? n.props.source
      : null;
}

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
      source: {
         type: "string",
         pattern: "^(shared:[a-z0-9][a-z0-9-]*|[^/].*\\.(md|html|json))$",
         description:
            'Instead of root: a .md, .html or .json file in panels_dir (see harness_info), e.g. progress.md, upgrade/board.html or review.json ({"root": node}). The panel shows the file and updates when you edit it. Or shared:<id>: a Shared Artifact attached to this Session (see artifact_attach).',
      },
   },
   additionalProperties: false,
   allOf: [
      {
         if: { properties: { remove: { const: true } }, required: ["remove"] },
         then: { required: ["id"] },
         else: { oneOf: [{ required: ["root"] }, { required: ["source"] }] },
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
                  // `repeat` (Accordion, Tabs): exactly one child, the per-item template.
                  ...(props.properties.repeat
                     ? {
                          if: {
                             properties: { props: { required: ["repeat"] } },
                             required: ["props"],
                          },
                          then: {
                             properties: { children: { minItems: 1, maxItems: 1 } },
                             required: ["children"],
                          },
                       }
                     : {}),
               },
            };
         }),
      },
   },
};

export const renderUiSchema: Schema = fromSchema(renderUiJson as never);

const MAX_ERRORS = 5;

/** The deepest object on `pointer` with a string `type`. */
function nodeType(input: unknown, pointer: string): string | undefined {
   let found: string | undefined;
   let cur: unknown = input;
   const tokens = [null, ...pointer.split("/").slice(1)];
   for (const raw of tokens) {
      if (raw !== null) {
         const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
         cur = cur && typeof cur === "object" ? (cur as Record<string, unknown>)[key] : undefined;
      }
      const t = (cur as { type?: unknown } | null | undefined)?.type;
      if (typeof t === "string") found = t;
   }
   return found;
}

/** Validation errors as `path (NodeType): message`: one per path, at most 5, then `(N more)`. */
export function formatErrors(
   errors: readonly { instanceLocation: string; error: string }[],
   input: unknown,
): string[] {
   const seen = new Set<string>();
   const all: string[] = [];
   for (const e of errors) {
      const path = e.instanceLocation.replace(/^#/, "");
      if (seen.has(path)) continue;
      seen.add(path);
      const ty = nodeType(input, path);
      all.push(`${path}${ty ? ` (${ty})` : ""}: ${e.error}`);
   }
   const out = all.slice(0, MAX_ERRORS);
   if (all.length > MAX_ERRORS) out.push(`(${all.length - MAX_ERRORS} more)`);
   return out;
}

/** One `formatErrors` line, short enough for one line in the chat: the allowed values of an enum are cut
 * (the node type list is ~30 names). `/root/type (Diagram): Expected enum: [...]` → `/root/type: "Diagram" is not a known component type`. */
export function shortError(line: string): string {
   const m = /^(\S+?)(?: \((.*)\))?: Expected enum: \[.*\]$/.exec(line);
   if (!m) return line;
   // The bracket names the node's type: the bad value itself only when the path is that `type`.
   const [, path, node] = m;
   if (path!.endsWith("/type") && node) return `${path}: "${node}" is not a known component type`;
   return `${path}${node ? ` (${node})` : ""}: not an allowed value`;
}

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

export const VIEW_ARTIFACT = "view_artifact";

export const frontendTools: {
   name: string;
   description: string;
   schema: unknown;
   replies?: boolean;
}[] = [
   {
      name: VIEW_ARTIFACT,
      description:
         "See an artifact as the user sees it, as a PNG image, to check your work: a diagram, table or render_ui item shown in this conversation, or Mermaid or HTML you pass here, which the user does not see. " +
         "Without arguments: the newest artifact. `id`: a render_ui id (see harness_info) or an artifact key. `kind`: the newest of that kind. " +
         "The result also has Mermaid syntax errors and the script errors of Html frames. Uses the app's current theme. The app window must be open.",
      schema: s.object({
         id: s.string().optional(),
         kind: s.string({ enum: ["ui", "diagram", "table"] }).optional(),
         mermaid: s.string({ description: "Mermaid source to draw" }).optional(),
         html: s
            .string({ description: "HTML to draw, in the same sandboxed frame as render_ui Html" })
            .optional(),
         width: s.number({ description: "Width in CSS pixels (default 900)" }).optional(),
      }),
      replies: true,
   },
   {
      name: RENDER_UI,
      description:
         "Show rich, optionally interactive content to the user: cards, grids, lists, tables, charts, diffs, file links, timelines, traces, logs, images, stats, tabs, steppers, accordions, choices, checkboxes, inputs, buttons. " +
         `Input: {"root": node, "placement"?, "id"?, "title"?, "icon"?}, or "source" instead of "root": the name of a file you wrote in panels_dir (harness_info) that updates when you edit it; use it for panels you change often. A .md file shows as Markdown (<details>/<summary> work), a .html file as an Html node (same frame and bridge), a .json file as a tree: {"root": node}, the same root you would pass here (no local images; check errors in harness_info after edits). A node is {"type", "props", "children"?, "on"?, "visible"?}; only ${andList(parents)} take children.\n` +
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
         'Data from state: Repeat renders its children per item of a state array; inside, {"$item": "field"}, {"$index": true}, "${field}" in a $template, {"$bindItem": "field"}, visible {"$item": "field", "eq"?}; in actions, statePath {"$item": "field"} and removeState index {"$index": true}. When the data changes, patch the state instead of sending the tree again. Repeat inside Accordion or Tabs gives one item; use `repeat` on the parent: {"repeat": {"statePath": "/tickets", "title": "name"}} and one child as the template.\n' +
         "Layout: compose generic parts (Stack with direction, align, justify, wrap, fill; Card variants; Text for short labels, numbers and arrows between parts; Table cells and KeyValue values with a tone) instead of asking for a special component.\n" +
         "Keep related parts in one item: Tabs for parts in any order, a Stepper for steps in order (a setup, a review, a quiz). A Choice whose pick can be checked takes `answer`, `result` and `explanation`.\n" +
         "Html: only for diagrams and custom visuals the catalog cannot show (architecture diagrams, annotated drawings); it runs in a sandboxed frame with the app's theme colors as CSS variables. " +
         'Attributes: data-state="/path" (shows the value as text), data-visible=\'{"$state": "/path", "eq": "x"}\' (same syntax as visible), data-on-click=\'<action or array>\' and data-on-change (run actions), data-bind="/path" on input, select and textarea (two-way; writes on change: blur, Enter or toggle). ' +
         "Scripts get window.harness: `state` (the whole Session State, replaced on each change), `get(path)` (the value at a JSON Pointer, e.g. get('/arch/selected')), `subscribe(fn)` (calls fn(state) at once and after each change; returns an unsubscribe function), `patch(ops)` (JSON Patch ops, e.g. [{op: 'replace', path: '/arch/selected', value: 'api'}]; replace also creates missing keys), `send(text)` (a user message to you), `run(actions)` (render_ui actions, as in on.press). " +
         "Prefer get and subscribe over keeping your own copy. Set data in the state with state_patch first, then draw from it in subscribe; patch the state later instead of sending new HTML. Leave height out: the frame fits its content.\n" +
         "Short text props (table cells and headings, KeyValue, List items, Choice labels, Card descriptions) take inline Markdown: `code`, **bold**, *italic*, links.\n" +
         "Use it for results, status, comparisons, screenshots, decisions you need from the user, or guided tasks, instead of a long plain message.\n" +
         `Icons (the icon prop): ${ICONS.join(", ")}.\nComponents:\n` +
         catalogText(),
      schema: renderUiJson,
   },
];
