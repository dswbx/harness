import type { HarnessClient, SessionSummary } from "@harness/api";
import { useEffect, useRef } from "react";
import { QUICK_TITLE, quickAgent } from "../composer/composer";

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
      if (current?.quick && current.title === QUICK_TITLE) return;
      try {
         const [agents, frontends] = await Promise.all([
            client.listAgents(),
            client.listFrontends(),
         ]);
         const agent = quickAgent(sessions, agents);
         const frontend = frontends.find((f) => f.id === "chat") ?? frontends[0];
         // No Agent yet: the Composer offers to open the Agents settings.
         if (!agent || !frontend) return setComposer(true);
         const id = await client.createQuickSession({ agentId: agent.id, frontendId: frontend.id });
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
