import { type Event, usageOf } from "@harness/api";
import { type Ctx, endsRunningTurn } from "../draft";

/**
 * The running Turn and the context usage. `TurnStarted` and `TurnEnded` also write to the timeline
 * (`timelineSlice`), which runs first: stamping a Turn's duration reads `turnStartedAt` before this
 * clears it.
 */
export function turnSlice(c: Ctx, e: Event) {
   const d = c.d;
   const k = e.kind;
   switch (k.type) {
      case "TurnStarted":
         d.turnId = k.turn_id;
         d.turnStartedAt = e.ts_ms;
         d.lastTurnErrored = false;
         return;
      case "TurnEnded":
         if (!endsRunningTurn(d, k.turn_id)) return;
         d.turnId = null;
         d.turnStartedAt = null;
         if (k.stop_reason !== "cancelled") d.turnEndedAt = e.ts_ms;
         d.lastTurnErrored = k.stop_reason === "error";
         return;
      case "UsageUpdated": {
         const u = usageOf(k);
         if (u) d.usage = u;
         return;
      }
   }
}
