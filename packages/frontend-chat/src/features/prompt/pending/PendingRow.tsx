import { cn } from "@harness/ui";
import type { ChatState } from "../../../state/reducer";
import { UserText } from "../../conversation/items/UserMessage";
import { type PendingMessage, pendingActions, useSlow } from "../pendingMessages";
import { pendingStage } from "./pendingStage";

/** A message on its way: where its row will be, laid out like it, so nothing moves when that row arrives. */
export function PendingRow({
   item,
   state,
   composer,
}: {
   item: PendingMessage;
   state: ChatState;
   composer: string;
}) {
   const slow = useSlow(true);
   const failed = item.status === "failed";
   return (
      <div className="flex flex-col items-end pb-6">
         <div
            className={cn(
               "flex w-full flex-col items-end",
               (failed || (item.status === "sending" && slow)) && "opacity-60",
            )}
         >
            <UserText text={item.prompt} />
         </div>
         <div className="mt-1 flex h-6 items-center gap-2 text-xs text-muted-foreground">
            {failed ? (
               <>
                  <span className="text-destructive">Not sent</span>
                  {!state.recovery && (
                     <button
                        type="button"
                        className="underline hover:text-foreground"
                        onClick={() => pendingActions(composer)?.retry()}
                     >
                        Retry
                     </button>
                  )}
                  <button
                     type="button"
                     className="underline hover:text-foreground"
                     onClick={() => pendingActions(composer)?.edit(item)}
                  >
                     Edit
                  </button>
               </>
            ) : (
               item.status === "sending" && slow && <span>{pendingStage(state)}</span>
            )}
            {item.files.length > 0 && (failed || slow) && (
               <span>{item.files.length === 1 ? "1 file" : `${item.files.length} files`}</span>
            )}
         </div>
      </div>
   );
}
