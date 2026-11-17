import { applyStatePatch, type Event, stepLineComments, stepThreads } from "@harness/api";
import { type Ctx, notice } from "../draft";

/**
 * Session-level Events, folded into the Main Thread's state whichever Thread they name, and
 * handled before anything else. True when the Event is fully handled.
 */
export function sessionLevel(c: Ctx, e: Event): boolean {
   const d = c.d;
   const k = e.kind;
   if (k.type === "StateChanged") {
      try {
         d.uiState = applyStatePatch(d.uiState, k.ops);
      } catch {
         // The core applied this patch; a failure here means our rules drifted. Keep the last state.
      }
      return true;
   }
   // Shared Artifacts are Session-level. Their state is never folded here: Views read it from the
   // artifact (ADR 0024 addendum), so `ArtifactStateChanged` never touches `uiState`.
   if (k.type === "ArtifactAttached" || k.type === "ArtifactDetached") {
      const rest = d.sharedAttached.filter((x) => x.id !== k.id);
      d.sharedAttached =
         k.type === "ArtifactAttached" ? [...rest, { id: k.id, ts: e.ts_ms }] : rest;
      return true;
   }
   if (
      k.type === "CommentAdded" ||
      k.type === "CommentEdited" ||
      k.type === "CommentDeleted" ||
      k.type === "CommentsSent" ||
      k.type === "CommentResolved"
   ) {
      d.lineComments = stepLineComments(d.lineComments, e);
      return true;
   }
   return k.type === "ArtifactStateChanged";
}

/** Main + Side Threads for menus and tab titles. */
export function trackThreadList(c: Ctx, e: Event) {
   c.d.threadList = stepThreads(c.d.threadList, e);
}

/** The first main `ThreadStarted` names the Main Thread. */
export function adoptMainThread(c: Ctx, e: Event) {
   const d = c.d;
   if (e.kind.type === "ThreadStarted" && e.kind.main && !d.mainThreadId)
      d.mainThreadId = e.thread_id;
}

/** Title, archived flag and Side Thread origin of one Thread. */
export function sessionSlice(c: Ctx, e: Event) {
   const d = c.d;
   const k = e.kind;
   switch (k.type) {
      case "SessionInfoUpdated":
         if (k.title) d.title = k.title;
         return;
      case "ThreadStarted":
         if (!k.main) {
            d.side = true;
            d.forkedFrom = k.forked_from ?? null;
         }
         return;
      case "SessionArchived":
         d.archived = k.archived;
         notice(c, `e${e.seq}`, "info", k.archived ? "Session archived" : "Session unarchived");
         return;
   }
}
