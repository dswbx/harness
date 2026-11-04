import type { SessionApi } from "@harness/api";
import {
   Button,
   Card,
   CardContent,
   CardHeader,
   CardTitle,
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuTrigger,
   Trace,
   TraceDescription,
   TraceDetail,
   TraceIcon,
   TraceLine,
   TraceTitle,
   TraceVerb,
} from "@harness/ui";
import { ChevronDown, ClipboardList, ShieldQuestion } from "lucide-react";
import { useState } from "react";
import { errorMessage } from "./errors";
import { Markdown } from "./Markdown";
import { type Item, permissionTitle, planOf } from "./reducer";

type Perm = Extract<Item, { type: "permission" }>;

/** Harness tools whose pending approval shows as a step of the Trace, not a card. */
const STEP_TOOLS = new Set(["git_commit", "git_push"]);
export const isStepApproval = (item: Perm) =>
   !!item.stepId && !!item.harnessTool && STEP_TOOLS.has(item.harnessTool);

/** The answers to a permission request. An always-allow option is a split button: also "Always allow globally". */
export function PermissionActions({ item, api }: { item: Perm; api: SessionApi }) {
   const [error, setError] = useState<string | null>(null);
   const answer = (optionId: string | null, global = false) => {
      setError(null);
      api.resolvePermission(item.requestId, optionId, global).catch((e) =>
         setError(errorMessage(e)),
      );
   };
   return (
      <>
         <div className="flex flex-wrap gap-2">
            {item.options.map((o) =>
               o.kind === "allow_always" && item.toolCall.kind !== "switch_mode" ? (
                  <div key={o.option_id} className="flex">
                     <Button
                        size="sm"
                        variant="outline"
                        className="rounded-r-none"
                        onClick={() => answer(o.option_id)}
                     >
                        {o.name}
                     </Button>
                     <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                           <Button
                              size="sm"
                              variant="outline"
                              className="rounded-l-none border-l-0 px-1.5"
                              aria-label="More always-allow options"
                           >
                              <ChevronDown className="size-3.5" />
                           </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start">
                           <DropdownMenuItem onSelect={() => answer(o.option_id, true)}>
                              Always allow globally
                           </DropdownMenuItem>
                        </DropdownMenuContent>
                     </DropdownMenu>
                  </div>
               ) : (
                  <Button
                     key={o.option_id}
                     size="sm"
                     variant={o.kind.startsWith("allow") ? "default" : "outline"}
                     onClick={() => answer(o.option_id)}
                  >
                     {o.name}
                  </Button>
               ),
            )}
            <Button size="sm" variant="ghost" onClick={() => answer(null)}>
               Dismiss
            </Button>
         </div>
         {error && (
            <p role="alert" className="whitespace-pre-wrap text-xs text-destructive">
               {error}
            </p>
         )}
      </>
   );
}

/** A pending git commit / push: a Trace line in amber with the answers below, where the step will be. */
function PermissionStep({ item, api }: { item: Perm; api: SessionApi }) {
   const verb = permissionTitle(item.toolCall, item.harnessTool, true) ?? "Permission requested";
   const message = item.toolCall.rawInput?.message;
   const detail =
      item.harnessTool === "git_commit" && typeof message === "string"
         ? (message.trim().split("\n")[0] ?? "")
         : "";
   return (
      <Trace className="text-ui-step">
         <TraceLine className="text-amber-500">
            <TraceIcon className="text-amber-500">
               <ShieldQuestion />
            </TraceIcon>
            <TraceTitle>
               <TraceVerb className="text-amber-500">{verb}</TraceVerb>
               {detail && <TraceDetail>{detail}</TraceDetail>}
            </TraceTitle>
            <TraceDescription className="text-amber-500">waiting for you</TraceDescription>
         </TraceLine>
         <div className="mb-1 ml-[calc(--spacing(2)-1px)] flex min-w-0 flex-col gap-2 border-l border-amber-500/50 pl-4">
            <PermissionActions item={item} api={api} />
         </div>
      </Trace>
   );
}

/** Inline permission prompt. A switch_mode request carrying a plan renders as a Plan card (Plan Mode approval). */
export function PermissionCard({ item, api }: { item: Perm; api: SessionApi }) {
   if (isStepApproval(item)) return <PermissionStep item={item} api={api} />;
   const plan = planOf(item.toolCall);
   const friendly = permissionTitle(item.toolCall, item.harnessTool);
   const title = friendly ?? item.toolCall.title ?? "Permission requested";
   const harness = item.harnessTool;
   return (
      <Card className={plan ? "border-primary/40" : "border-amber-500/40"}>
         <CardHeader>
            {plan ? (
               <ClipboardList className="size-4" />
            ) : (
               <ShieldQuestion className="size-4 text-amber-500" />
            )}
            <CardTitle>{plan ? "Plan" : title}</CardTitle>
            {!plan && friendly && item.toolCall.title && (
               <span className="font-mono text-xs text-muted-foreground">
                  {harness ?? item.toolCall.title}
               </span>
            )}
            {plan && <span className="text-xs text-muted-foreground">{title}</span>}
         </CardHeader>
         <CardContent className="space-y-3">
            {plan && (
               <Markdown className="max-h-96 overflow-auto rounded border bg-background p-3">
                  {plan}
               </Markdown>
            )}
            <PermissionActions item={item} api={api} />
         </CardContent>
      </Card>
   );
}
