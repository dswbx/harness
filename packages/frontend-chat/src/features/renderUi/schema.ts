import { fromSchema, type Schema } from "jsonv-ts";
import { components } from "./catalog";
import { type Entry, ICONS } from "./shared";
import type { ComponentType } from "./types";
import { COMPUTED, PLACEMENTS } from "./types";

export const names = Object.keys(components) as ComponentType[];
export const parents = names.filter((n) => (components[n] as Entry).children);
export const andList = (xs: string[]) => `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;
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
export const renderUiJson = {
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

/** The catalog as text for the tool description: agents that drop parts of a schema still see it. */
export function catalogText(): string {
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
