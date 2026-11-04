import { Button } from "@harness/ui";
import type { ChatState } from "./reducer";

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
