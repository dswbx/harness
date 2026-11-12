import type { SessionApi } from "@harness/api";
import { Button } from "@harness/ui";
import { type RefObject, useEffect, useRef } from "react";
import {
   ApproveButton,
   continuesIn,
   useApproveChoice,
   usePlanAnswer,
   usePlanComments,
} from "./ApproveButton";
import type { ConfigOption, Item, PlanEntry } from "./reducer";

type Perm = Extract<Item, { type: "permission" }>;

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * The answers to a pending plan: comment count, where the Agent continues, "Keep planning" (or "Send N
 * comments" when plan comments wait in the prompt box) and Approve. ⌘⏎ inside `shortcutRoot` approves.
 */
export function PlanActions({
   api,
   item,
   entry,
   configOptions,
   shortcutRoot,
}: {
   api: SessionApi;
   item: Perm;
   entry: PlanEntry;
   configOptions: ConfigOption[];
   shortcutRoot?: RefObject<HTMLElement | null>;
}) {
   const { answer, keepPlanning, error } = usePlanAnswer(api, item);
   const { chosen, fallback, pick } = useApproveChoice(item, entry);
   const comments = usePlanComments(api.sessionId).length;
   const mode = continuesIn(chosen, entry, configOptions);
   const approve = useRef<() => void>(() => {});
   approve.current = () => chosen && void answer(chosen.option_id);
   useEffect(() => {
      const el = shortcutRoot?.current;
      if (!el) return;
      const onKey = (e: KeyboardEvent) => {
         if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
            e.preventDefault();
            approve.current();
         }
      };
      el.addEventListener("keydown", onKey);
      return () => el.removeEventListener("keydown", onKey);
   }, [shortcutRoot]);
   return (
      <div className="flex flex-col gap-2">
         <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <div className="flex min-w-40 flex-1 gap-1.5 text-xs text-muted-foreground">
               {comments > 0 && (
                  <>
                     <span className="shrink-0">{plural(comments, "comment")}</span>
                     {mode && <span aria-hidden>·</span>}
                  </>
               )}
               {mode && <span className="truncate">Continues in {mode}</span>}
            </div>
            <div className="flex shrink-0 items-center gap-2">
               <Button
                  size="sm"
                  variant={comments > 0 ? "default" : "outline"}
                  onClick={() => void keepPlanning()}
               >
                  {comments > 0 ? `Send ${plural(comments, "comment")}` : "Keep planning"}
               </Button>
               <ApproveButton
                  item={item}
                  configOptions={configOptions}
                  variant={comments > 0 ? "outline" : "default"}
                  chosen={chosen}
                  fallback={fallback}
                  onPick={pick}
                  onApprove={(id) => void answer(id)}
                  onKeepPlanning={() => void keepPlanning()}
                  onDismiss={() => void answer(null)}
               />
            </div>
         </div>
         {error && (
            <p role="alert" className="whitespace-pre-wrap text-xs text-destructive">
               {error}
            </p>
         )}
      </div>
   );
}
