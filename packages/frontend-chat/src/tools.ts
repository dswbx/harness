import { fromSchema, s, type Schema, type Static } from "jsonv-ts";

/**
 * Frontend Tools of the chat Frontend. Serialized into manifest.json by `bun run gen-manifests`.
 *
 * `render_ui` (ADR 0013, 0015): a tree of `{ type, props, children?, on? }` nodes from the catalog
 * below. Data binding follows json-render's syntax so we can adopt the library later: any prop
 * can be `{ "$state": "/path" }` or `{ "$template": "Score: ${/quiz/score}" }` (read from the
 * Session State), inputs write with `{ "$bindState": "/path" }`, and `on` runs actions
 * (`setState`, `pushState`, `removeState`, plus our `sendMessage`).
 */

const tone = s.string({ enum: ["neutral", "info", "success", "warning", "error"], description: "Accent. Default neutral." });
/** The core copies local image files named here into the Session (ADR 0012, level 1). */
const imageSrc = s.string({ format: "harness-image", description: "Image file path (relative to the workspace, or absolute) or an https URL." });
const image = s.object({
  src: imageSrc,
  alt: s.string({ description: "What the image shows." }),
  caption: s.string().optional(),
});

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
  btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="hsl(${hue} 60% 45%)"/><text x="320" y="212" font-family="sans-serif" font-size="32" fill="white" text-anchor="middle">${label}</text></svg>`);

/** The `render_ui` components. Add components as needed; give each an example. */
export const components = {
  Stack: {
    description: "Lays out children vertically (default) or in a row; children in a row share the width.",
    children: true,
    props: s.object({
      direction: s.string({ enum: ["vertical", "horizontal"] }).optional(),
      gap: s.string({ enum: ["sm", "md", "lg"] }).optional(),
    }),
    example: { node: { type: "Stack", props: { direction: "horizontal" }, children: [
      { type: "Card", props: { title: "Left" }, children: [{ type: "Markdown", props: { text: "Same width" } }] },
      { type: "Card", props: { title: "Right" }, children: [{ type: "Markdown", props: { text: "Same height" } }] },
    ] } },
  },
  Card: {
    description: "A bordered box with an optional title and tone; holds children.",
    children: true,
    props: s.object({ title: s.string().optional(), tone: tone.optional() }),
    example: { node: { type: "Card", props: { title: "Build finished", tone: "success" }, children: [{ type: "Markdown", props: { text: "All **3** checks passed." } }] } },
  },
  Markdown: {
    description: "Markdown text.",
    children: false,
    props: s.object({ text: s.string() }),
    example: { node: { type: "Markdown", props: { text: "**Bold**, `code` and a [link](https://example.com)." } } },
  },
  KeyValue: {
    description: "Label/value rows.",
    children: false,
    props: s.object({ items: s.array(s.object({ label: s.string(), value: s.string() })) }),
    example: { node: { type: "KeyValue", props: { items: [{ label: "Duration", value: "12s" }, { label: "Branch", value: "main" }] } } },
  },
  Table: {
    description: "A table: column headings and rows of cell text.",
    children: false,
    props: s.object({ columns: s.array(s.string()), rows: s.array(s.array(s.string())) }),
    example: { node: { type: "Table", props: { columns: ["Page", "Before", "After"], rows: [["Home", "1.8s", "0.9s"], ["Settings", "1.2s", "0.7s"]] } } },
  },
  Badge: {
    description: "A short label, e.g. a status.",
    children: false,
    props: s.object({ text: s.string(), tone: tone.optional() }),
    example: { node: { type: "Stack", props: { direction: "horizontal", gap: "sm" }, children: [
      { type: "Badge", props: { text: "passing", tone: "success" } },
      { type: "Badge", props: { text: "1 flaky", tone: "warning" } },
      { type: "Badge", props: { text: "draft" } },
    ] } },
  },
  Code: {
    description: "A code block.",
    children: false,
    props: s.object({ code: s.string(), language: s.string().optional() }),
    example: { node: { type: "Code", props: { language: "rust", code: "let s = std::fs::read_to_string(\"data.txt\")?;" } } },
  },
  Image: {
    description: "One image; the user can open it full size.",
    children: false,
    props: image,
    example: { node: { type: "Image", props: { src: demoImage("Screenshot", 210), alt: "Screenshot", caption: "A local file path or an https URL" } } },
  },
  Carousel: {
    description: "Several images, one at a time, with previous/next.",
    children: false,
    props: s.object({ images: s.array(image, { minItems: 1 }) }),
    example: { node: { type: "Carousel", props: { images: [1, 2, 3].map((i) => ({ src: demoImage(`Image ${i}`, 150 + i * 50), alt: `Image ${i}`, caption: `Image ${i} of 3` })) } } },
  },
  Stat: {
    description: "One number or short value with a label, e.g. a score.",
    children: false,
    props: s.object({ label: s.string(), value: s.anyOf([s.string(), s.number()]), hint: s.string().optional(), tone: tone.optional() }),
    example: { node: { type: "Stat", props: { label: "Score", value: { $template: "${/quiz/score} / 5" }, hint: "3 questions left" } }, state: { quiz: { score: 2 } } },
  },
  Progress: {
    description: "A progress bar from 0 to max (default 100).",
    children: false,
    props: s.object({ value: s.number(), max: s.number().optional(), label: s.string().optional() }),
    example: { node: { type: "Progress", props: { label: "Question 2 of 5", value: { $state: "/quiz/done" }, max: 5 } }, state: { quiz: { done: 2 } } },
  },
  Choice: {
    description:
      "Options to pick one from (distinct values); writes the picked value to `value` ($bindState). For a quiz, set `answer` to the correct value: after a pick it shows right/wrong, locks, and writes true/false to `result` ($bindState). `on.change` runs after a pick.",
    children: false,
    props: s.object({
      options: s.array(s.object({ value: s.string(), label: s.string() }), { minItems: 1 }),
      value: s.any(),
      answer: s.string().optional(),
      result: s.any().optional(),
      columns: s.number({ enum: [1, 2] }).optional(),
    }),
    bind: ["value", "result"],
    events: ["change"],
    example: { node: { type: "Stack", children: [
      { type: "Choice", props: {
        value: { $bindState: "/quiz/answers/q1" }, result: { $bindState: "/quiz/results/q1" }, answer: "a",
        options: [{ value: "a", label: "A. Ownership" }, { value: "b", label: "B. Garbage collection" }, { value: "c", label: "C. Reference counting only" }],
      } },
      { type: "Stat", props: { label: "Score", value: { $computed: "count", args: { values: { $state: "/quiz/results" }, eq: true } } } },
    ] }, state: { quiz: { answers: {}, results: {} } } },
  },
  Input: {
    description: "A text field; writes its text to its $bindState path. `on.submit` runs on Enter.",
    children: false,
    props: s.object({ value: s.any(), label: s.string().optional(), placeholder: s.string().optional() }),
    bind: ["value"],
    events: ["submit"],
    example: { node: { type: "Input", props: { label: "Your answer", placeholder: "Type and press Enter", value: { $bindState: "/answers/q2" } } }, state: { answers: {} } },
  },
  Button: {
    description: "A button; `on.press` runs its actions.",
    children: false,
    props: s.object({ label: s.string(), variant: s.string({ enum: ["primary", "secondary", "ghost"] }).optional(), disabled: s.boolean().optional() }),
    events: ["press"],
    example: { node: { type: "Stack", props: { direction: "horizontal", gap: "sm" }, children: [
      { type: "Button", props: { label: "Submit answer" }, on: { press: { action: "sendMessage", params: { text: { $template: "My answer: ${/answers/q1}" } } } } },
      { type: "Button", props: { label: "Pick B", variant: "secondary" }, on: { press: { action: "setState", params: { statePath: "/answers/q1", value: "b" } } } },
      { type: "Badge", props: { text: { $template: "Picked: ${/answers/q1}" } } },
    ] }, state: { answers: { q1: "a" } } },
  },
  Tabs: {
    description: "Tabs: one child per tab, one shown at a time. `value` ($bindState, optional) holds the open tab's index.",
    children: true,
    props: s.object({ tabs: s.array(s.string(), { minItems: 1 }), value: s.any().optional() }),
    bind: ["value"],
    example: { node: { type: "Tabs", props: { tabs: ["Summary", "Details"] }, children: [
      { type: "Markdown", props: { text: "Short summary." } },
      { type: "KeyValue", props: { items: [{ label: "Files", value: "3" }] } },
    ] } },
  },
  Stepper: {
    description:
      "Steps shown one at a time with Back/Next, e.g. the questions of a test: one child per step. `value` ($bindState, optional) holds the step index. `on.finish` runs when the user presses Finish on the last step.",
    children: true,
    props: s.object({ steps: s.array(s.string(), { minItems: 1 }), value: s.any().optional() }),
    bind: ["value"],
    events: ["finish"],
    example: { node: {
      type: "Stepper",
      props: { steps: ["Question 1", "Question 2"] },
      on: { finish: { action: "sendMessage", params: { text: "I finished the test." } } },
      children: [
        { type: "Choice", props: { value: { $bindState: "/t/q1" }, result: { $bindState: "/t/r/q1" }, answer: "b", options: [{ value: "a", label: "Box<T>" }, { value: "b", label: "Option<T>" }] } },
        { type: "Choice", props: { value: { $bindState: "/t/q2" }, result: { $bindState: "/t/r/q2" }, answer: "a", options: [{ value: "a", label: "One &mut or many &" }, { value: "b", label: "Many &mut" }] } },
      ],
    }, state: { t: {} } },
  },
} as const satisfies Record<string, Entry>;

type Components = typeof components;
export type ComponentType = keyof Components;

/** An action an event runs (json-render's built-ins plus `sendMessage`). */
export type UiAction =
  | { action: "setState"; params: { statePath: string; value: unknown } }
  | { action: "pushState"; params: { statePath: string; value: unknown } }
  | { action: "removeState"; params: { statePath: string; index?: number } }
  | { action: "sendMessage"; params: { text: unknown } };
type On = Partial<Record<"press" | "change" | "submit" | "finish", UiAction | UiAction[]>>;

/** A node as the Agent sends it: props may hold `$state`/`$template`/`$bindState` expressions. */
export type RawNode = { type: ComponentType; props?: Record<string, unknown>; children?: RawNode[]; on?: On };
/** A node after binding: plain props, and the state paths its bound props write to. */
export type UiNode = {
  [K in ComponentType]: { type: K; props: Static<Components[K]["props"]>; children?: UiNode[]; on?: On; bindings: Record<string, string> };
}[ComponentType];

/**
 * Built-in `$computed` functions (json-render's syntax; it registers its own by name).
 * `count`: entries of `values` (array or object) equal to `eq` (default true). `length`: all entries.
 * `sum`: numbers in `values`.
 */
export const COMPUTED = ["count", "length", "sum"] as const;

export const PLACEMENTS = ["inline", "top", "bottom", "right"] as const;
export type Placement = (typeof PLACEMENTS)[number];
export type RenderUiInput = { root?: RawNode; id?: string; placement?: Placement; title?: string; remove?: boolean };

const names = Object.keys(components) as ComponentType[];
const node = "#/$defs/node";
const json = (x: Schema) => JSON.parse(JSON.stringify(x)) as { properties?: Record<string, object>; required?: string[] };

/** Props schema: each prop also takes an expression; bound props take `$bindState`. */
function propsSchema(c: Entry) {
  const p = json(c.props);
  const properties = Object.fromEntries(
    Object.entries(p.properties ?? {}).map(([k, v]) => [k, c.bind?.includes(k) ? { $ref: "#/$defs/bind" } : { anyOf: [v, { $ref: "#/$defs/expr" }] }]),
  );
  return { ...p, properties, additionalProperties: false };
}

const actionList = { anyOf: [{ $ref: "#/$defs/action" }, { type: "array", items: { $ref: "#/$defs/action" } }] };

/** One node schema: `type` picks the props schema (`if`/`then`), so errors name the wrong prop. */
const renderUiJson = {
  type: "object",
  properties: {
    id: { type: "string", description: "Names this item: a later call with the same id replaces it. Required for top, bottom and right." },
    placement: { type: "string", enum: PLACEMENTS, description: "Where it shows: inline in the chat (default), or in a live area of the chat: top, bottom, or a tab on the right." },
    title: { type: "string", description: "Label of the right-side tab." },
    remove: { const: true, description: "Remove the item with this id." },
    root: { $ref: node },
  },
  additionalProperties: false,
  allOf: [
    { if: { properties: { remove: { const: true } }, required: ["remove"] }, then: { required: ["id"] }, else: { required: ["root"] } },
    { if: { properties: { placement: { enum: ["top", "bottom", "right"] } }, required: ["placement"] }, then: { required: ["id"] } },
  ],
  $defs: {
    expr: {
      description: 'Read from the Session State: {"$state": "/path"}, {"$template": "Score: ${/quiz/score}"}, or {"$computed": "count"|"length"|"sum", "args": {"values", "eq"?}}.',
      oneOf: [
        { type: "object", properties: { $state: { type: "string" } }, required: ["$state"], additionalProperties: false },
        { type: "object", properties: { $template: { type: "string" } }, required: ["$template"], additionalProperties: false },
        {
          type: "object",
          properties: { $computed: { type: "string", enum: COMPUTED }, args: { type: "object", properties: { values: {}, eq: {} }, required: ["values"], additionalProperties: false } },
          required: ["$computed", "args"],
          additionalProperties: false,
        },
      ],
    },
    bind: { type: "object", properties: { $bindState: { type: "string" } }, required: ["$bindState"], additionalProperties: false, description: 'Two-way binding: {"$bindState": "/path"}.' },
    action: {
      type: "object",
      properties: { action: { type: "string", enum: ["setState", "pushState", "removeState", "sendMessage"] }, params: { type: "object" } },
      required: ["action", "params"],
      additionalProperties: false,
      allOf: [
        { if: { properties: { action: { enum: ["setState", "pushState"] } } }, then: { properties: { params: { type: "object", properties: { statePath: { type: "string" }, value: {} }, required: ["statePath", "value"], additionalProperties: false } } } },
        { if: { properties: { action: { const: "removeState" } } }, then: { properties: { params: { type: "object", properties: { statePath: { type: "string" }, index: { type: "integer" } }, required: ["statePath"], additionalProperties: false } } } },
        { if: { properties: { action: { const: "sendMessage" } } }, then: { properties: { params: { type: "object", properties: { text: { anyOf: [{ type: "string" }, { $ref: "#/$defs/expr" }] } }, required: ["text"], additionalProperties: false } } } },
      ],
    },
    node: {
      type: "object",
      properties: {
        type: { type: "string", enum: names },
        props: { type: "object" },
        children: { type: "array", items: { $ref: node }, description: "Only for Stack, Card, Tabs and Stepper." },
        on: { type: "object", properties: { press: actionList, change: actionList, submit: actionList, finish: actionList }, additionalProperties: false },
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
      const p = json(c.props) as { properties?: Record<string, { enum?: unknown[] }>; required?: string[] };
      const props = Object.entries(p.properties ?? {})
        .map(([k, v]) => `${k}${p.required?.includes(k) ? "" : "?"}${c.bind?.includes(k) ? ": $bindState" : v.enum ? `: ${v.enum.join("|")}` : ""}`)
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
      "Show rich, optionally interactive content to the user: cards, tables, images, a carousel, stats, tabs, steppers, choices, inputs, buttons. " +
      'Input: {"root": node, "placement"?, "id"?, "title"?}. A node is {"type", "props", "children"?, "on"?}; only Stack, Card, Tabs and Stepper take children.\n' +
      "Placement: inline in the chat (default) or a live area: top, bottom, or a tab on the right (needs an id and a title). " +
      'A call with the same id replaces that item; {"id", "remove": true} removes it.\n' +
      'Session State: any prop can be {"$state": "/path"}, {"$template": "Score: ${/quiz/score}"} or {"$computed": "count", "args": {"values": {"$state": "/quiz/results"}, "eq": true}} (also "length" and "sum") and updates when the state changes (change it with state_patch). ' +
      'Choice and Input write the user\'s answer with {"$bindState": "/path"}. ' +
      'on.press/change/submit run actions: {"action": "setState"|"pushState", "params": {"statePath", "value"}}, {"action": "removeState", "params": {"statePath", "index"?}}, ' +
      '{"action": "sendMessage", "params": {"text"}} (sends the text to you as the user\'s next message; text can be a $template). ' +
      "The user's state changes do not reach you by themselves: add a sendMessage when you must react.\n" +
      "For a test or quiz: one right tab (or inline card) with a Stepper of questions; each Choice with `answer` and `result` grades itself, and a Stat with $computed count shows the score.\n" +
      "Use it for results, status, comparisons, screenshots or interactive tasks, instead of a long plain message. Components:\n" +
      catalogText(),
    schema: renderUiJson,
  },
] as const;
