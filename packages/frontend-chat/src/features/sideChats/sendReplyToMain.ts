import { addReviewComment } from "../review/reviewComments";

/**
 * "Send to main": a Side Thread's reply goes to the Main prompt box as a quote, with an optional note on what
 * to do with it. False when the reply is empty.
 */
export function sendReplyToMain(sessionId: string, text: string, note = ""): boolean {
   const quote = text.trim();
   if (!quote) return false;
   addReviewComment(sessionId, { kind: "quote", quote, text: note.trim(), source: "side_thread" });
   return true;
}
