import { s, type Static } from "jsonv-ts";

/** Frontend Tools of the chat Frontend. Serialized into manifest.json by `bun run gen-manifests`. */

export const jsonRenderSchema = s.object({
  title: s.string({ description: "Card heading, short." }),
  body: s.string({ description: "Markdown text shown under the title." }).optional(),
  items: s
    .array(
      s.object({
        label: s.string({ description: "Row label, e.g. a field name." }),
        value: s.string({ description: "Row value." }).optional(),
      }),
      { description: "Label/value rows, shown as a list under the body." },
    )
    .optional(),
  tone: s
    .string({ enum: ["info", "success", "warning", "error"], description: "Accent of the card. Default info." })
    .optional(),
});

export type JsonRenderInput = Static<typeof jsonRenderSchema>;

export const JSON_RENDER = "json_render";

export const frontendTools = [
  {
    name: JSON_RENDER,
    description:
      "Show a small structured card in the chat for the user: a title, optional markdown body, optional label/value rows and a tone (info, success, warning, error). Use it for summaries, results or status the user should notice, instead of a long plain message.",
    schema: jsonRenderSchema,
  },
] as const;
