import type { AgentInfo, AgentSwitch, HarnessClient, SessionSummary } from "@harness/api";
import { useEffect, useMemo, useRef, useState } from "react";
import { discardEmpty } from "../sessions/forgetGone";
import { startQuickSession } from "./startSession";

/**
 * The Quick Session lifecycle (ADR 0020): `startQuick` starts one without a dialog (or stays on one that
 * is still unused); leaving a Quick Session lets the core remove it if it is still unused. `agentSwitch`:
 * the selected Quick Session is still unused, so its prompt box offers the Agent > model menu, as in the
 * Quick Overlay; picking another Agent replaces it.
 */
export function useQuickLifecycle({
   client,
   sessions,
   selected,
   setSelected,
   setComposer,
   refresh,
   report,
   agentsVersion = 0,
}: {
   client: HarnessClient;
   sessions: SessionSummary[];
   selected: string | null;
   setSelected: (id: string | null) => void;
   setComposer: (open: boolean) => void;
   refresh: () => Promise<unknown>;
   report: (title: string, e: unknown) => void;
   /** Bumped when Agents were added or removed: the menu reloads them. */
   agentsVersion?: number;
}) {
   const current = sessions.find((s) => s.id === selected);
   const draft = current?.quick && current.unused ? current : undefined;

   /** Creates a Quick Session (with `agentId`, else by the policy), selects it and refreshes. */
   const start = async (agentId?: string) => {
      try {
         const started = await startQuickSession(client, { sessions, agentId });
         // No Agent yet: the Composer offers to open the Agents settings.
         if (!started) return setComposer(true);
         setSelected(started.id);
         // A picked Agent: start it now, so its models show in the menu.
         if (agentId)
            client
               .sessionApi(started.id)
               .warmUp()
               .catch(() => {});
         await refresh();
      } catch (e) {
         report("Could not start a Quick Session", e);
      }
   };
   /** The Quick group's +: no dialog. Stays on a Quick Session that is still unused. */
   const startQuick = async () => {
      if (draft) return;
      await start();
   };

   const [agents, setAgents] = useState<AgentInfo[]>([]);
   const hasDraft = !!draft;
   // biome-ignore lint/correctness/useExhaustiveDependencies: agentsVersion reloads the list
   useEffect(() => {
      if (!hasDraft) return;
      let stop = false;
      client.listAgents().then(
         (a) => !stop && setAgents(a),
         () => {},
      );
      return () => {
         stop = true;
      };
   }, [client, hasDraft, agentsVersion]);

   // Latest `start` for the memoized switch (it closes over `sessions`).
   const startRef = useRef(start);
   startRef.current = start;
   const draftAgent = draft?.agent_id;
   const agentSwitch = useMemo<AgentSwitch | undefined>(
      () =>
         draftAgent && agents.length > 0
            ? {
                 agents: agents.map((a) => ({ id: a.id, name: a.name })),
                 current: draftAgent,
                 // Leaving the old draft discards it (below).
                 onPick: (id) => {
                    if (id !== draftAgent) void startRef.current(id);
                 },
              }
            : undefined,
      [draftAgent, agents],
   );

   // Leaving a Quick Session: the core removes it if it is still unused.
   const leaving = useRef(selected);
   useEffect(() => {
      const prev = leaving.current;
      leaving.current = selected;
      if (!prev || prev === selected) return;
      if (!sessions.find((s) => s.id === prev)?.quick) return;
      discardEmpty(client, prev)
         .then(refresh)
         .catch((e) => report("Could not remove the empty Quick Session", e));
   }, [selected]);
   return { startQuick, agentSwitch };
}
