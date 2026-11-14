import { useEffect, useRef } from "react";
import { type PendingActions, removePendingActions, setPendingActions } from "./pendingMessages";

/**
 * Registers what the pending messages' Retry and Edit buttons do for this composer (`key`) while it is
 * mounted. The registered functions call the latest `actions`, so no render's closure goes stale.
 */
export function usePendingActions(key: string, actions: PendingActions) {
   const latest = useRef(actions);
   latest.current = actions;
   useEffect(() => {
      const mine: PendingActions = {
         retry: () => latest.current.retry(),
         edit: (item) => latest.current.edit(item),
      };
      setPendingActions(key, mine);
      return () => removePendingActions(key, mine);
   }, [key]);
}
