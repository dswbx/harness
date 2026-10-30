import { fromSchema, s, type Schema, type Static } from "jsonv-ts";

/** Frontend Tools of the chat Frontend. Serialized into manifest.json by `bun run gen-manifests`. */

const tone = s.string({ enum: ["neutral", "info", "success", "warning", "error"], description: "Accent. Default neutral." });
/** The core copies local image files named here into the Session (ADR 0012, level 1). */
const imageSrc = s.string({ format: "harness-image", description: "Image file path (relative to the workspace, or absolute) or an https URL." });
const image = s.object({
  src: imageSrc,
  alt: s.string({ description: "What the image shows." }),
  caption: s.string().optional(),
});

/** The `render_ui` components: props, and whether they take children. Add components as needed. */
export const components = {
  Stack: {
    description: "Lays out children vertically (default) or in a row.",
    children: true,
    props: s.object({
      direction: s.string({ enum: ["vertical", "horizontal"] }).optional(),
      gap: s.string({ enum: ["sm", "md", "lg"] }).optional(),
    }),
  },
  Card: {
    description: "A bordered box with an optional title and tone; holds children.",
    children: true,
    props: s.object({ title: s.string().optional(), tone: tone.optional() }),
  },
  Markdown: {
    description: "Markdown text.",
    children: false,
    props: s.object({ text: s.string() }),
  },
  KeyValue: {
    description: "Label/value rows.",
    children: false,
    props: s.object({ items: s.array(s.object({ label: s.string(), value: s.string() })) }),
  },
  Table: {
    description: "A table: column headings and rows of cell text.",
    children: false,
    props: s.object({ columns: s.array(s.string()), rows: s.array(s.array(s.string())) }),
  },
  Badge: {
    description: "A short label, e.g. a status.",
    children: false,
    props: s.object({ text: s.string(), tone: tone.optional() }),
  },
  Code: {
    description: "A code block.",
    children: false,
    props: s.object({ code: s.string(), language: s.string().optional() }),
  },
  Image: {
    description: "One image; the user can open it full size.",
    children: false,
    props: image,
  },
  Carousel: {
    description: "Several images, one at a time, with previous/next.",
    children: false,
    props: s.object({ images: s.array(image, { minItems: 1 }) }),
  },
} as const;

type Components = typeof components;
export type ComponentType = keyof Components;
export type UiNode = {
  [K in ComponentType]: { type: K; props: Static<Components[K]["props"]>; children?: UiNode[] };
}[ComponentType];
export type RenderUiInput = { root: UiNode };

const names = Object.keys(components) as ComponentType[];
const node = "#/$defs/node";

/** One node schema: `type` picks the props schema (`if`/`then`), so errors name the wrong prop. */
const renderUiJson = {
  type: "object",
  properties: { root: { $ref: node } },
  required: ["root"],
  additionalProperties: false,
  $defs: {
    node: {
      type: "object",
      properties: {
        type: { type: "string", enum: names },
        props: { type: "object" },
        children: { type: "array", items: { $ref: node }, description: "Only for Stack and Card." },
      },
      required: ["type"],
      additionalProperties: false,
      allOf: names.map((n) => {
        const c = components[n];
        const props = JSON.parse(JSON.stringify(c.props));
        return {
          if: { properties: { type: { const: n } } },
          then: {
            properties: { props: { ...props, additionalProperties: false }, ...(c.children ? {} : { children: { maxItems: 0 } }) },
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
      const c = components[n];
      const p = JSON.parse(JSON.stringify(c.props)) as { properties?: Record<string, { type?: string; enum?: string[] }>; required?: string[] };
      const props = Object.entries(p.properties ?? {})
        .map(([k, v]) => `${k}${p.required?.includes(k) ? "" : "?"}${v.enum ? `: ${v.enum.join("|")}` : ""}`)
        .join(", ");
      return `- ${n}(${props})${c.children ? " + children" : ""}: ${c.description}`;
    })
    .join("\n");
}

export const RENDER_UI = "render_ui";

export const frontendTools = [
  {
    name: RENDER_UI,
    description:
      "Show rich content to the user in the chat: cards, tables, images, an image carousel, and more. " +
      'Input: {"root": node}. A node is {"type", "props", "children"?}; only Stack and Card take children. ' +
      "Use it for results, status, comparisons or screenshots the user should see, instead of a long plain message. Components:\n" +
      catalogText(),
    schema: renderUiJson,
  },
] as const;
