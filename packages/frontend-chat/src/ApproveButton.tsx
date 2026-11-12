import type { PermissionOption, SessionApi } from "@harness/api";
import {
   Button,
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuLabel,
   DropdownMenuRadioGroup,
   DropdownMenuRadioItem,
   DropdownMenuSeparator,
   DropdownMenuTrigger,
} from "@harness/ui";
import { ChevronDown } from "lucide-react";
import { useMemo, useState } from "react";
import { errorMessage } from "./errors";
import { defaultApproveOption, keepPlanningOption, modeName } from "./plans";
import type { ConfigOption, Item, PlanEntry } from "./reducer";
import {
   getReviewComments,
   type ReviewComment,
   setReviewComments,
   useReviewComments,
   withReviewComments,
} from "./reviewComments";

type Perm = Extract<Item, { type: "permission" }>;

const isPlanComment = (c: ReviewComment) => c.kind === "quote" && c.source === "plan";

/** Plan comments waiting in the Main Thread's prompt box (from any plan version). */
export function usePlanComments(sessionId: string) {
   const all = useReviewComments(sessionId);
   return useMemo(() => all.filter(isPlanComment), [all]);
}

/**
 * Answers a plan approval. "Keep planning" answers with the reject option, then sends the plan comments
 * waiting in the Main Thread's prompt box as a prompt (other comments stay there for the next send).
 */
export function usePlanAnswer(api: SessionApi, item: Perm) {
   const [error, setError] = useState<string | null>(null);
   const answer = (optionId: string | null) => {
      setError(null);
      return api
         .resolvePermission(item.requestId, optionId, false)
         .then(() => true)
         .catch((e) => {
            setError(errorMessage(e));
            return false;
         });
   };
   const keepPlanning = async () => {
      const reject = keepPlanningOption(item.options);
      if (!(await answer(reject?.option_id ?? null))) return;
      const all = getReviewComments(api.sessionId);
      const sent = all.filter(isPlanComment);
      if (sent.length === 0) return;
      setReviewComments(
         api.sessionId,
         all.filter((c) => !isPlanComment(c)),
      );
      api.prompt(withReviewComments("", sent)).catch((e) => {
         // Not sent: put the comments back.
         setReviewComments(api.sessionId, [...getReviewComments(api.sessionId), ...sent]);
         setError(errorMessage(e));
      });
   };
   return { answer, keepPlanning, error };
}

/** What an option leads to: "Auto", "Clear context · Auto", or its own name when its mode is unknown. */
export function optionLabel(o: PermissionOption, configOptions: ConfigOption[]) {
   const mode = modeName(configOptions, o.plan_mode);
   if (!mode) return o.name;
   return o.clears_context ? `Clear context · ${mode}` : mode;
}

/** The mode the Agent continues in after approving with `o` (its own mode, else the one before Plan). */
export const continuesIn = (
   o: PermissionOption | null | undefined,
   entry: PlanEntry,
   configOptions: ConfigOption[],
) => modeName(configOptions, o?.plan_mode ?? entry.modeBefore);

/** The option the button approves with: the one picked in the menu, else the default. */
export function useApproveChoice(item: Perm, entry: PlanEntry) {
   const [picked, setPicked] = useState<string | null>(null);
   const fallback = defaultApproveOption(item.options, entry.modeBefore);
   const chosen = item.options.find((o) => o.option_id === picked) ?? fallback;
   return { chosen, fallback, pick: setPicked };
}

/**
 * Approve split button. The button approves with `chosen`; the menu picks another option (one more click
 * approves), "Keep planning" or "Dismiss". No chevron when the Agent offers only one way to approve.
 */
export function ApproveButton({
   item,
   configOptions,
   chosen,
   fallback,
   onPick,
   onApprove,
   onKeepPlanning,
   onDismiss,
   size = "sm",
   variant = "default",
}: {
   item: Perm;
   configOptions: ConfigOption[];
   chosen: PermissionOption | null;
   fallback: PermissionOption | null;
   onPick: (optionId: string) => void;
   onApprove: (optionId: string) => void;
   onKeepPlanning: () => void;
   onDismiss: () => void;
   size?: "sm" | "default";
   /** "outline" while plan comments wait, so "Send N comments" is the one primary action. */
   variant?: "default" | "outline";
}) {
   const allow = item.options.filter((o) => o.kind.startsWith("allow"));
   const keep = allow.filter((o) => !o.clears_context);
   const clear = allow.filter((o) => o.clears_context);
   const label = (o: PermissionOption) => optionLabel(o, configOptions);
   const text =
      chosen && fallback && chosen.option_id !== fallback.option_id
         ? `Approve · ${label(chosen)}`
         : "Approve";
   const radio = (list: PermissionOption[]) =>
      list.map((o) => (
         <DropdownMenuRadioItem key={o.option_id} value={o.option_id}>
            <span className="flex min-w-0 flex-col">
               <span>{label(o)}</span>
               {label(o) !== o.name && (
                  <span className="text-xs text-muted-foreground">{o.name}</span>
               )}
            </span>
         </DropdownMenuRadioItem>
      ));
   return (
      <div className="flex">
         <Button
            size={size}
            variant={variant}
            className={allow.length > 1 ? "rounded-r-none" : undefined}
            disabled={!chosen}
            title="Approve (⌘⏎)"
            onClick={() => chosen && onApprove(chosen.option_id)}
         >
            {text}
         </Button>
         {allow.length > 1 && (
            <DropdownMenu>
               <DropdownMenuTrigger asChild>
                  <Button
                     size={size}
                     variant={variant}
                     className={
                        variant === "outline"
                           ? "rounded-l-none border-l-0 px-1.5"
                           : "rounded-l-none border-l border-l-primary-foreground/20 px-1.5"
                     }
                     aria-label="More ways to approve"
                  >
                     <ChevronDown className="size-3.5" />
                  </Button>
               </DropdownMenuTrigger>
               <DropdownMenuContent align="end" className="w-72">
                  <DropdownMenuRadioGroup
                     value={chosen?.option_id ?? ""}
                     onValueChange={(v) => onPick(v)}
                  >
                     {keep.length > 0 && (
                        <>
                           <DropdownMenuLabel>Then continue in</DropdownMenuLabel>
                           {radio(keep)}
                        </>
                     )}
                     {clear.length > 0 && (
                        <>
                           {keep.length > 0 && <DropdownMenuSeparator />}
                           <DropdownMenuLabel>Clear context and…</DropdownMenuLabel>
                           {radio(clear)}
                        </>
                     )}
                  </DropdownMenuRadioGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={onKeepPlanning}>Keep planning</DropdownMenuItem>
                  <DropdownMenuItem onSelect={onDismiss}>Dismiss</DropdownMenuItem>
               </DropdownMenuContent>
            </DropdownMenu>
         )}
      </div>
   );
}
