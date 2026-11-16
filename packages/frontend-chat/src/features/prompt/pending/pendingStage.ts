import type { ChatState } from "../../../state/reducer";

/** What a message that is not sent yet is waiting for. */
export function pendingStage(state: ChatState): string {
   if (state.restoring)
      return `Reopening session, attempt ${state.restoring.attempt} of ${state.restoring.of}...`;
   // A Side Thread's Agent Session (a fork, or a fresh one) is not up yet.
   if (state.side && state.startBoundary === null) return "Starting side chat...";
   if (state.process?.state === "starting") return "Starting agent...";
   return "Sending...";
}
