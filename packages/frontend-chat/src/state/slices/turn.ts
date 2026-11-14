import type { Event } from "@harness/api";
import type { Ctx } from "../draft";

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
         d.turnId = null;
         d.turnStartedAt = null;
         d.lastTurnErrored = k.stop_reason === "error";
         return;
      case "UsageUpdated": {
         const u = k.usage as { used?: number; size?: number } | null;
         if (typeof u?.used === "number" && typeof u?.size === "number")
            d.usage = { used: u.used, size: u.size };
         return;
      }
   }
}
