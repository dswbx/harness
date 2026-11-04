import type { AttachmentInput } from "@harness/api";
import { Button, cn } from "@harness/ui";
import { useEffect, useState } from "react";
import type { PendingAttachment } from "./attachments";
import { UserText } from "./Messages";
import type { PromptSnapshot } from "./promptMarkdown";
import type { ChatState } from "./reducer";
import type { ReviewComment } from "./reviewComments";

/**
 * A message the user sent that is not in the Session Log yet: the Harness logs `TurnStarted` only
 * once the Agent is up. It is still part of the composer's state, like a draft (ADR 0003), so "Edit"
 * can put back exactly what was sent.
 */
export type PendingMessage = {
   id: string;
   prompt: string;
   inputs: AttachmentInput[];
   files: PendingAttachment[];
   comments: ReviewComment[];
   snap: PromptSnapshot;
   status: "sending" | "sent" | "failed";
   /** Gone once the Thread has more user messages than this. */
   base: number;
};

/** The wait below this shows nothing, so a ready Agent does not flash a state. */
const SLOW_MS = 300;

function stage(state: ChatState): string {
   if (state.restoring)
      return `Reopening session, attempt ${state.restoring.attempt} of ${state.restoring.of}...`;
   if (state.process?.state === "starting") return "Starting agent...";
   return "Sending...";
}

function PendingRow({
   item,
   state,
   onRetry,
   onEdit,
}: {
   item: PendingMessage;
   state: ChatState;
   onRetry?: () => void;
   onEdit: () => void;
}) {
   const [slow, setSlow] = useState(false);
   useEffect(() => {
      const t = setTimeout(() => setSlow(true), SLOW_MS);
      return () => clearTimeout(t);
   }, []);
   const failed = item.status === "failed";
   const dim = failed || (item.status === "sending" && slow);
   return (
      <div className="flex flex-col items-end gap-1">
         <div className={cn("flex w-full flex-col items-end", dim && "opacity-60")}>
            <UserText text={item.prompt} />
            {item.files.length > 0 && (
               <span className="mt-1 text-xs text-muted-foreground">
                  {item.files.length === 1 ? "1 file" : `${item.files.length} files`}
               </span>
            )}
         </div>
         {failed ? (
            <div className="flex items-center gap-2 text-xs">
               <span className="text-destructive">Not sent</span>
               {onRetry && (
                  <button type="button" className="underline" onClick={onRetry}>
                     Retry
                  </button>
               )}
               <button type="button" className="underline" onClick={onEdit}>
                  Edit
               </button>
            </div>
         ) : (
            item.status === "sending" &&
            slow && (
               <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="size-1.5 animate-pulse rounded-full bg-sky-500" />
                  {stage(state)}
               </div>
            )
         )}
      </div>
   );
}

/** Messages on their way, right under the Thread's last message. */
export function PendingMessages({
   items,
   state,
   onRetry,
   onEdit,
}: {
   items: PendingMessage[];
   state: ChatState;
   onRetry: () => void;
   onEdit: (item: PendingMessage) => void;
}) {
   if (items.length === 0) return null;
   return (
      <div className="mb-3 flex flex-col gap-2">
         {items.map((item) => (
            <PendingRow
               key={item.id}
               item={item}
               state={state}
               // With the recovery card up, its buttons are the way forward.
               onRetry={state.recovery ? undefined : onRetry}
               onEdit={() => onEdit(item)}
            />
         ))}
      </div>
   );
}

/** The way out when the Agent Session could not be restored. */
export function RecoveryCard({
   recovery,
   canRetry,
   onRetry,
   onContinue,
}: {
   recovery: NonNullable<ChatState["recovery"]>;
   /** There is an unsent message to try again with; else sending a message tries again. */
   canRetry: boolean;
   onRetry: () => void;
   onContinue: () => void;
}) {
   const { retryable, errors, transcript } = recovery;
   const older = transcript ? transcript.total_turns - transcript.kept_turns : 0;
   const offerRetry = retryable && canRetry;
   return (
      <div role="alert" className="mb-2 flex flex-col gap-3 rounded-lg border bg-muted/50 p-3">
         <div className="flex flex-col gap-1">
            <div className="text-sm font-semibold">
               {retryable
                  ? "The agent could not reopen this session"
                  : "This agent cannot reopen earlier sessions"}
            </div>
            <p className="text-sm text-muted-foreground">
               {retryable
                  ? "Automatic retries failed. This may still be temporary, so you can try again."
                  : "To go on, start a new agent session from the transcript."}{" "}
               Your conversation and files are safe.
            </p>
            {errors.length > 0 && (
               <code className="break-words font-mono text-xs text-muted-foreground">
                  {errors.join(" · ")}
               </code>
            )}
         </div>
         <div className="flex flex-wrap gap-2">
            {offerRetry && (
               <Button size="sm" onClick={onRetry}>
                  Try again
               </Button>
            )}
            <Button size="sm" variant={offerRetry ? "outline" : "default"} onClick={onContinue}>
               Continue from transcript
            </Button>
         </div>
         <div className="grid grid-cols-2 gap-3 border-t pt-3 text-xs">
            <div className="flex flex-col gap-0.5">
               <span className="font-medium">A new agent session gets</span>
               <span className="text-muted-foreground">Your prompts and its replies</span>
               <span className="text-muted-foreground">Tool names</span>
               <span className="text-muted-foreground">
                  {!transcript || older > 0
                     ? transcript
                        ? `The last ${transcript.kept_turns} of ${transcript.total_turns} turns`
                        : "The most recent turns"
                     : `All ${transcript.total_turns} turns`}
               </span>
            </div>
            <div className="flex flex-col gap-0.5">
               <span className="font-medium">It does not get</span>
               <span className="text-muted-foreground">Tool inputs and outputs</span>
               <span className="text-muted-foreground">Its earlier thoughts</span>
               {older > 0 && (
                  <span className="text-muted-foreground">
                     {older === 1 ? "The 1 older turn" : `The ${older} older turns`}
                  </span>
               )}
            </div>
         </div>
      </div>
   );
}
