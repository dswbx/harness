import type { HarnessClient, SessionSummary } from "@harness/api";
import { useEffect, useRef } from "react";
import { startQuickSession } from "./startSession";

/**
 * The Quick Session lifecycle (ADR 0020): `startQuick` starts one without a dialog (or stays on one that
 * is still unused); leaving a Quick Session lets the core remove it if it is still unused.
 */
export function useQuickLifecycle({
   client,
   sessions,
   selected,
   setSelected,
   setComposer,
   refresh,
   report,
}: {
   client: HarnessClient;
   sessions: SessionSummary[];
   selected: string | null;
   setSelected: (id: string | null) => void;
   setComposer: (open: boolean) => void;
   refresh: () => Promise<unknown>;
   report: (title: string, e: unknown) => void;
}) {
   /** The Quick group's +: no dialog. Stays on a Quick Session that is still unused. */
   const startQuick = async () => {
      const current = sessions.find((s) => s.id === selected);
      if (current?.quick && current.unused) return;
      try {
         const started = await startQuickSession(client, { sessions });
         // No Agent yet: the Composer offers to open the Agents settings.
         if (!started) return setComposer(true);
         const id = started.id;
         setSelected(id);
         await refresh();
      } catch (e) {
         report("Could not start a Quick Session", e);
      }
   };
   // Leaving a Quick Session: the core removes it if it is still unused.
   const leaving = useRef(selected);
   useEffect(() => {
      const prev = leaving.current;
      leaving.current = selected;
      if (!prev || prev === selected) return;
      if (!sessions.find((s) => s.id === prev)?.quick) return;
      client
         .discardEmptySession(prev)
         .then(refresh)
         .catch((e) => report("Could not remove the empty Quick Session", e));
   }, [selected]);
   return startQuick;
}
