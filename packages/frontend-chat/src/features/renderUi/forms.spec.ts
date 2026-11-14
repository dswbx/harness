import { s } from "jsonv-ts";
import { type Entry, icon, tooltip } from "./shared";

/** Inputs: Choice, Input, Button, Checkbox, Switch. */

export const specs = {
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
} as const satisfies Record<string, Entry>;
