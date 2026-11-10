import type { StatePatchOp } from "@harness/api";
import {
   Button,
   cn,
   Input,
   Select,
   SelectContent,
   SelectItem,
   SelectTrigger,
   SelectValue,
   Textarea,
} from "@harness/ui";
import { CheckCircle2, XCircle } from "lucide-react";
import { useContext, useEffect, useState } from "react";
import { InlineMarkdown as Md } from "../InlineMarkdown";
import { Markdown } from "../Markdown";
import type { RawNode, UiNode } from "../tools";
import {
   CheckBox,
   IconOf,
   type Renderers,
   runActions,
   ScopeCtx,
   structuredCloneSet,
   tip,
   tones,
   useEnv,
} from "./runtime";

export * from "./forms.spec";

/** Renderers of this group; its specs (schema, description, example) are in `forms.spec.ts`. */
function Choice({ node }: { node: Extract<UiNode, { type: "Choice" }> }) {
   const env = useEnv();
   const scope = useContext(ScopeCtx);
   const { options, answer } = node.props;
   const picked = node.props.value;
   const graded = answer != null && picked != null && picked !== "";
   const pick = async (value: string) => {
      const path = node.bindings.value;
      if (!path || graded) return;
      const ops: StatePatchOp[] = [{ op: "replace", path, value }];
      let next = structuredCloneSet(env.state, path, value);
      const result = node.bindings.result;
      if (result && answer != null) {
         ops.push({ op: "replace", path: result, value: value === answer });
         next = structuredCloneSet(next, result, value === answer);
      }
      await env.patch(ops);
      await runActions(node.on?.change, { ...env, state: next }, scope);
   };
   // Picked by value: duplicate values would pick several options at once.
   if (new Set(options.map((o) => o.value)).size !== options.length) {
      return (
         <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-ui-sm text-destructive"
         >
            Choice options need distinct values.
         </div>
      );
   }
   const right = graded && picked === answer;
   const verdictOf = (v: string) =>
      !graded ? null : v === answer ? "right" : picked === v ? "wrong" : null;
   const variant = node.props.variant ?? "list";
   const body =
      variant === "select" ? (
         <div className="flex items-center gap-2">
            <Select
               value={picked == null ? "" : String(picked)}
               disabled={graded}
               onValueChange={(v) => void pick(v)}
            >
               <SelectTrigger className="w-auto min-w-48">
                  <SelectValue placeholder="Choose…" />
               </SelectTrigger>
               <SelectContent>
                  {options.map((o) => (
                     <SelectItem key={o.value} value={o.value}>
                        {o.label}
                     </SelectItem>
                  ))}
               </SelectContent>
            </Select>
            {graded &&
               (right ? (
                  <CheckCircle2 className="size-4 text-emerald-500" aria-label="correct" />
               ) : (
                  <XCircle className="size-4 text-destructive" aria-label="wrong" />
               ))}
         </div>
      ) : variant === "buttons" ? (
         <div
            role="radiogroup"
            className="inline-flex w-fit max-w-full flex-wrap rounded-md border p-0.5"
         >
            {options.map((o) => {
               const on = picked === o.value;
               const verdict = verdictOf(o.value);
               return (
                  <button
                     key={o.value}
                     role="radio"
                     aria-checked={on}
                     disabled={graded && !on}
                     onClick={() => void pick(o.value)}
                     className={cn(
                        "rounded px-3 py-1 text-ui transition-colors disabled:cursor-default",
                        verdict === "right"
                           ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                           : verdict === "wrong"
                             ? "bg-destructive/15 text-destructive"
                             : on
                               ? "bg-accent font-medium text-accent-foreground"
                               : "text-muted-foreground hover:text-foreground",
                     )}
                  >
                     {o.label}
                  </button>
               );
            })}
         </div>
      ) : null;
   return (
      <div className="grid grid-cols-1 gap-2">
         {body ?? (
            <div
               role="radiogroup"
               className={cn(
                  "grid grid-cols-1 gap-1.5",
                  node.props.columns === 2 && "sm:grid-cols-2",
               )}
            >
               {options.map((o) => {
                  const on = picked === o.value;
                  const verdict = !graded
                     ? null
                     : o.value === answer
                       ? "right"
                       : on
                         ? "wrong"
                         : null;
                  return (
                     <button
                        key={o.value}
                        role="radio"
                        aria-checked={on}
                        disabled={graded && !on}
                        onClick={() => void pick(o.value)}
                        className={cn(
                           "flex items-center gap-2 rounded-md border px-3 py-2 text-left text-ui transition-colors disabled:cursor-default",
                           verdict === "right"
                              ? "border-emerald-500/60 bg-emerald-500/10"
                              : verdict === "wrong"
                                ? "border-destructive/60 bg-destructive/10"
                                : on
                                  ? "border-primary bg-primary/10 font-medium"
                                  : !graded && "hover:bg-accent hover:text-accent-foreground",
                        )}
                     >
                        <span
                           className={cn(
                              "grid size-4 shrink-0 place-items-center rounded-full border border-muted-foreground/50",
                              on && "border-primary",
                           )}
                        >
                           {on && <span className="size-2 rounded-full bg-primary" />}
                        </span>
                        <span className="min-w-0 flex-1">
                           <Md>{o.label}</Md>
                        </span>
                        {verdict === "right" && (
                           <CheckCircle2
                              className="size-4 shrink-0 text-emerald-500"
                              aria-label="correct"
                           />
                        )}
                        {verdict === "wrong" && (
                           <XCircle
                              className="size-4 shrink-0 text-destructive"
                              aria-label="wrong"
                           />
                        )}
                     </button>
                  );
               })}
            </div>
         )}
         {graded && node.props.explanation && (
            <div
               role="note"
               className={cn(
                  "rounded-md border px-3 py-2",
                  right ? tones.success.box : tones.error.box,
               )}
            >
               <div
                  className={cn(
                     "mb-1 text-ui-sm font-medium",
                     right ? tones.success.fg : tones.error.fg,
                  )}
               >
                  {right ? "Correct" : "Not quite"}
               </div>
               <Markdown>{node.props.explanation}</Markdown>
            </div>
         )}
      </div>
   );
}

function TextInput({ node }: { node: Extract<UiNode, { type: "Input" }> }) {
   const env = useEnv();
   const scope = useContext(ScopeCtx);
   const path = node.bindings.value;
   const stored = node.props.value == null ? "" : String(node.props.value);
   const [text, setText] = useState(stored);
   useEffect(() => setText(stored), [stored]);
   const commit = async (submit: boolean) => {
      if (path && text !== stored) await env.patch([{ op: "replace", path, value: text }]);
      if (submit)
         await runActions(
            node.on?.submit,
            { ...env, state: path ? structuredCloneSet(env.state, path, text) : env.state },
            scope,
         );
   };
   return (
      <label className="grid grid-cols-1 gap-1.5">
         {node.props.label && (
            <span className="text-ui-sm text-muted-foreground">{node.props.label}</span>
         )}
         {node.props.multiline ? (
            <Textarea
               value={text}
               rows={4}
               placeholder={node.props.placeholder}
               onChange={(e) => setText(e.target.value)}
               onBlur={() => void commit(false)}
               onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && void commit(true)}
            />
         ) : (
            <Input
               value={text}
               placeholder={node.props.placeholder}
               onChange={(e) => setText(e.target.value)}
               onBlur={() => void commit(false)}
               onKeyDown={(e) => e.key === "Enter" && void commit(true)}
            />
         )}
      </label>
   );
}

/** A boolean bound to state; writes it, then runs `on.change` with the new state. */
function useToggle(node: {
   props: { value?: unknown };
   bindings: Record<string, string>;
   on?: RawNode["on"];
}) {
   const env = useEnv();
   const scope = useContext(ScopeCtx);
   const on = node.props.value === true;
   const toggle = async () => {
      const path = node.bindings.value;
      if (!path) return;
      await env.patch([{ op: "replace", path, value: !on }]);
      await runActions(
         node.on?.change,
         { ...env, state: structuredCloneSet(env.state, path, !on) },
         scope,
      );
   };
   return [on, toggle] as const;
}

function Toggle({
   node,
   kind,
}: {
   node: Extract<UiNode, { type: "Checkbox" | "Switch" }>;
   kind: "checkbox" | "switch";
}) {
   const [on, toggle] = useToggle(node);
   return (
      <button
         type="button"
         onClick={() => void toggle()}
         className="flex w-fit max-w-full items-start gap-2.5 text-left"
      >
         {kind === "checkbox" ? (
            <span className="mt-0.5">
               <CheckBox on={on} />
            </span>
         ) : (
            <span
               role="switch"
               aria-checked={on}
               className={cn(
                  "mt-0.5 flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition-colors",
                  on ? "bg-primary" : "bg-muted-foreground/30",
               )}
            >
               <span
                  className={cn(
                     "size-3 rounded-full bg-background transition-transform",
                     on && "translate-x-3",
                  )}
               />
            </span>
         )}
         <span className="min-w-0">
            <span className="block text-ui">{node.props.label}</span>
            {node.props.description && (
               <span className="block text-ui-sm text-muted-foreground">
                  {node.props.description}
               </span>
            )}
         </span>
      </button>
   );
}

export const renderers = {
   Choice: ({ node }) => {
      return <Choice node={node} />;
   },
   Input: ({ node }) => {
      return <TextInput node={node} />;
   },
   Button: ({ node, env, scope }) => {
      return tip(
         node.props.tooltip,
         <Button
            size="sm"
            variant={
               node.props.variant === "primary" || !node.props.variant
                  ? "default"
                  : node.props.variant
            }
            disabled={node.props.disabled}
            className="w-fit"
            onClick={() => void runActions(node.on?.press, env, scope)}
         >
            {node.props.icon && <IconOf name={node.props.icon} />}
            {String(node.props.label ?? "")}
         </Button>,
      );
   },
   Checkbox: ({ node }) => {
      return <Toggle node={node} kind="checkbox" />;
   },
   Switch: ({ node }) => {
      return <Toggle node={node} kind="switch" />;
   },
} satisfies Renderers;
