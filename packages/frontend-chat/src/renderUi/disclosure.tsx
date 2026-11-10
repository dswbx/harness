import { Button, cn, Popover, PopoverContent, PopoverTrigger } from "@harness/ui";
import { s } from "jsonv-ts";
import { ChevronRight } from "lucide-react";
import { type ReactNode, useContext, useState } from "react";
import type { UiNode } from "../tools";
import { IconOf, type Renderers, runActions, ScopeCtx, useEnv } from "./runtime";
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

/** Index from a bound `value`, else local; writes go to the bound path when there is one. */
function useIndex(
   node: { props: { value?: unknown }; bindings: Record<string, string> },
   count: number,
): [number, (i: number) => void] {
   const env = useEnv();
   const [local, setLocal] = useState(0);
   const path = node.bindings.value;
   const bound = Number(node.props.value);
   const index = Math.max(0, Math.min(count - 1, path && Number.isInteger(bound) ? bound : local));
   const set = (i: number) =>
      path ? void env.patch([{ op: "replace", path, value: i }]) : setLocal(i);
   return [index, set];
}

function Tabs({
   node,
   kids,
}: {
   node: Extract<UiNode, { type: "Tabs" }>;
   kids: React.ReactNode[];
}) {
   const [i, setI] = useIndex(node, node.props.tabs.length);
   return (
      <div className="grid grid-cols-1 gap-3">
         {/* Scrolls sideways only; the bottom line is drawn inside, so the active underline doesn't overflow. */}
         <div
            role="tablist"
            className="flex gap-1 overflow-x-auto overflow-y-hidden shadow-[inset_0_-1px_0_var(--border)]"
         >
            {node.props.tabs.map((t, j) => (
               <button
                  key={j}
                  role="tab"
                  aria-selected={i === j}
                  onClick={() => setI(j)}
                  className={cn(
                     "shrink-0 border-b-2 px-3 py-1.5 text-ui",
                     i === j
                        ? "border-primary font-medium"
                        : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
               >
                  {t}
               </button>
            ))}
         </div>
         <div role="tabpanel">{kids[i]}</div>
      </div>
   );
}

function Stepper({
   node,
   kids,
}: {
   node: Extract<UiNode, { type: "Stepper" }>;
   kids: React.ReactNode[];
}) {
   const env = useEnv();
   const scope = useContext(ScopeCtx);
   const steps = node.props.steps;
   const [i, setI] = useIndex(node, steps.length);
   const last = i === steps.length - 1;
   return (
      <div className="grid grid-cols-1 gap-3">
         <div className="flex items-center gap-2 text-ui-sm text-muted-foreground">
            <span className="tabular-nums">
               Step {i + 1} of {steps.length}
            </span>
            <span className="min-w-0 flex-1 truncate font-medium text-foreground">{steps[i]}</span>
            <div className="flex gap-1">
               {steps.map((_, j) => (
                  <button
                     key={j}
                     aria-label={`Go to step ${j + 1}`}
                     onClick={() => setI(j)}
                     className={cn(
                        "size-2 rounded-full",
                        j === i
                           ? "bg-primary"
                           : "bg-muted-foreground/30 hover:bg-muted-foreground/60",
                     )}
                  />
               ))}
            </div>
         </div>
         <div>{kids[i]}</div>
         <div className="flex justify-between gap-2">
            <Button size="sm" variant="ghost" disabled={i === 0} onClick={() => setI(i - 1)}>
               Back
            </Button>
            {last ? (
               node.on?.finish && (
                  <Button size="sm" onClick={() => void runActions(node.on?.finish, env, scope)}>
                     Finish
                  </Button>
               )
            ) : (
               <Button size="sm" onClick={() => setI(i + 1)}>
                  Next
               </Button>
            )}
         </div>
      </div>
   );
}

const popoverWidth = { sm: "w-60", md: "w-80", lg: "w-[28rem]" } as const;

/** Trigger: a button from `label`, else the first child (wrapped in a plain button, so it is clickable and focusable). */
function UiPopover({
   node,
   kids,
}: {
   node: Extract<UiNode, { type: "Popover" }>;
   kids: ReactNode[];
}) {
   const p = node.props ?? {};
   const [trigger, content] = p.label ? [null, kids] : [kids[0], kids.slice(1)];
   return (
      <Popover>
         <PopoverTrigger asChild>
            {p.label ? (
               <Button
                  size="sm"
                  variant={p.variant === "primary" ? "default" : (p.variant ?? "outline")}
                  className="w-fit"
               >
                  {p.icon && <IconOf name={p.icon} />}
                  {p.label}
               </Button>
            ) : (
               <button
                  type="button"
                  className="w-fit max-w-full cursor-pointer rounded-md text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
               >
                  {trigger}
               </button>
            )}
         </PopoverTrigger>
         <PopoverContent
            className={cn(
               "max-h-[min(28rem,var(--radix-popover-content-available-height))] space-y-2 overflow-y-auto p-3 text-ui",
               popoverWidth[p.width ?? "md"],
            )}
         >
            {p.title && <div className="font-semibold">{p.title}</div>}
            {content}
         </PopoverContent>
      </Popover>
   );
}

function Accordion({
   node,
   kids,
}: {
   node: Extract<UiNode, { type: "Accordion" }>;
   kids: ReactNode[];
}) {
   const [open, setOpen] = useState<number[]>(() => node.props.open ?? []);
   const flip = (i: number) =>
      setOpen(
         open.includes(i) ? open.filter((x) => x !== i) : node.props.multiple ? [...open, i] : [i],
      );
   return (
      <div className="divide-y rounded-lg border">
         {node.props.items.map((title, i) => (
            <div key={i}>
               <button
                  type="button"
                  aria-expanded={open.includes(i)}
                  onClick={() => flip(i)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-ui font-medium hover:bg-accent/50"
               >
                  <ChevronRight
                     className={cn(
                        "size-4 shrink-0 text-muted-foreground transition-transform",
                        open.includes(i) && "rotate-90",
                     )}
                  />
                  <span className="min-w-0 flex-1 truncate">{title}</span>
               </button>
               {open.includes(i) && <div className="px-3 pb-3 pl-9">{kids[i]}</div>}
            </div>
         ))}
      </div>
   );
}

export const renderers = {
   Tabs: ({ node, kids }) => {
      return <Tabs node={node} kids={kids ?? []} />;
   },
   Stepper: ({ node, kids }) => {
      return <Stepper node={node} kids={kids ?? []} />;
   },
   Popover: ({ node, kids }) => {
      return <UiPopover node={node} kids={kids ?? []} />;
   },
   Accordion: ({ node, kids }) => {
      return <Accordion node={node} kids={kids ?? []} />;
   },
} satisfies Renderers;
