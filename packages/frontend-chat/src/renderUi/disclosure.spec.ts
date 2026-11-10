import { s } from "jsonv-ts";
import { type Entry, icon } from "./shared";

/** Show and hide: Tabs, Stepper, Popover, Accordion. */

export const specs = {
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
} as const satisfies Record<string, Entry>;
