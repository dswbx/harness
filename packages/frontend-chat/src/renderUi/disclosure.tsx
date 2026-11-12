import { Button, cn, Popover, PopoverContent, PopoverTrigger } from "@harness/ui";
import { ChevronRight } from "lucide-react";
import { type ReactNode, useContext, useState } from "react";
import type { UiNode } from "../tools";
import { repeatScopes } from "./layout";
import {
   IconOf,
   type RenderCtx,
   type Renderers,
   readItem,
   resolveValue,
   runActions,
   ScopeCtx,
   useEnv,
} from "./runtime";

export * from "./disclosure.spec";

/** Renderers of this group; its specs (schema, description, example) are in `disclosure.spec.ts`. */
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

type Items = { titles: ReactNode[]; kids: ReactNode[] };

/**
 * Titles and bodies of Accordion and Tabs: static (`items`/`tabs` and one child each), or with
 * `repeat` one per item of a state array, the one child rendered in that item's Repeat scope.
 */
function itemsOf(
   { node, raw, kids, env, scope, Node }: RenderCtx<"Accordion"> | RenderCtx<"Tabs">,
   titles: string[] | undefined,
): Items {
   const r = node.props.repeat;
   if (!r) return { titles: titles ?? [], kids: kids ?? [] };
   const scopes = repeatScopes(
      { ...raw, props: { items: { $state: r.statePath } } },
      env.state,
      scope,
   );
   const tpl = raw.children?.[0];
   return {
      titles: scopes.map((s) => {
         const v =
            typeof r.title === "string"
               ? readItem(r.title, s)
               : resolveValue(r.title, env.state, s);
         return v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
      }),
      kids: scopes.map(
         (s) =>
            tpl && (
               <ScopeCtx.Provider key={s.index} value={s}>
                  <Node raw={tpl} />
               </ScopeCtx.Provider>
            ),
      ),
   };
}

function Tabs({ node, items }: { node: Extract<UiNode, { type: "Tabs" }>; items: Items }) {
   const { titles: tabs, kids } = items;
   const [i, setI] = useIndex(node, tabs.length);
   return (
      <div className="grid grid-cols-1 gap-3">
         {/* Scrolls sideways only; the bottom line is drawn inside, so the active underline doesn't overflow. */}
         <div
            role="tablist"
            className="flex gap-1 overflow-x-auto overflow-y-hidden shadow-[inset_0_-1px_0_var(--border)]"
         >
            {tabs.map((t, j) => (
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
   items,
}: {
   node: Extract<UiNode, { type: "Accordion" }>;
   items: Items;
}) {
   const { titles, kids } = items;
   const [open, setOpen] = useState<number[]>(() => node.props.open ?? []);
   const flip = (i: number) =>
      setOpen(
         open.includes(i) ? open.filter((x) => x !== i) : node.props.multiple ? [...open, i] : [i],
      );
   return (
      <div className="divide-y rounded-lg border">
         {titles.map((title, i) => (
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
   Tabs: (ctx) => {
      return <Tabs node={ctx.node} items={itemsOf(ctx, ctx.node.props.tabs)} />;
   },
   Stepper: ({ node, kids }) => {
      return <Stepper node={node} kids={kids ?? []} />;
   },
   Popover: ({ node, kids }) => {
      return <UiPopover node={node} kids={kids ?? []} />;
   },
   Accordion: (ctx) => {
      return <Accordion node={ctx.node} items={itemsOf(ctx, ctx.node.props.items)} />;
   },
} satisfies Renderers;
