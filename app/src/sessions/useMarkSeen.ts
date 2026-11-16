import type { HarnessClient, SessionSummary } from "@harness/api";
import { useEffect } from "react";

const looking = () => document.visibilityState === "visible" && document.hasFocus();

/** Marks the shown Session seen while this window is in front: now, or once it comes back. */
export function useMarkSeen(client: HarnessClient, session: SessionSummary | null | undefined) {
   const id = session?.unseen ? session.id : null;
   useEffect(() => {
      if (!id) return;
      // Fails only for a Session that is gone: nothing to mark.
      const mark = () => void (looking() && client.markSessionSeen(id).catch(() => {}));
      mark();
      window.addEventListener("focus", mark);
      document.addEventListener("visibilitychange", mark);
      return () => {
         window.removeEventListener("focus", mark);
         document.removeEventListener("visibilitychange", mark);
      };
   }, [client, id]);
}
