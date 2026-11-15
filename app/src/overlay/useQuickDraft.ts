import type { AgentInfo, AgentSwitch, HarnessClient } from "@harness/api";
import { type Dispatch, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { QUICK_TITLE } from "../composer/composer";
import { saveAgent, startQuickSession } from "../quick/startSession";
import { discardEmpty } from "../sessions/forgetGone";
import { overlayHost } from "./overlayHost";
import type { OverlayAction, OverlayMode } from "./overlayMode";

type Draft = { id: string; frontendId: string; agentId: string };

/**
 * The overlay's draft Quick Session: started when the overlay shows, the Agent picked, the Session
 * closed or merged into the main window, and the first message noticed (it opens the chat).
 */
export function useQuickDraft({
   client,
   report,
   visible,
   mode,
   dispatch,
   onReset,
}: {
   client: HarnessClient;
   report: (title: string, e: unknown) => void;
   visible: boolean;
   mode: OverlayMode;
   dispatch: Dispatch<OverlayAction>;
   /** The rest of the overlay forgets what belonged to the draft. */
   onReset: () => void;
}) {
   const [draft, setDraft] = useState<Draft | null>(null);
   const [title, setTitle] = useState(QUICK_TITLE);
   const [agents, setAgents] = useState<AgentInfo[]>([]);
   const [error, setError] = useState<string | null>(null);
   const creating = useRef(false);
   const draftRef = useRef(draft);
   draftRef.current = draft;

   // A draft Quick Session as soon as the overlay is on screen, started right away so the prompt
   // box has the Agent's models and modes. The core removes it if nothing is sent.
   const startDraft = useCallback(async () => {
      creating.current = true;
      setError(null);
      try {
         const started = await startQuickSession(client, { useSavedAgent: true });
         if (!started) {
            setError("No Agent installed. Add one in the main window's Settings.");
            return;
         }
         setAgents(started.agents);
         const { id } = started;
         setTitle(QUICK_TITLE);
         setDraft({ id, frontendId: started.frontendId, agentId: started.agent.id });
         client
            .sessionApi(id)
            .warmUp()
            .catch(() => {});
      } catch (e) {
         report("Could not start a Quick Session", e);
      } finally {
         creating.current = false;
      }
   }, [client, report]);
   useEffect(() => {
      if (visible && !draft && !creating.current) void startDraft();
   }, [visible, draft, startDraft]);

   // The first message changes the title: the chat opens. A Turn that ends while mini marks it.
   // biome-ignore lint/correctness/useExhaustiveDependencies: dispatch is the reducer's, stable
   useEffect(() => {
      let stop = false;
      let off: (() => void) | undefined;
      client
         .subscribeApp((e) => {
            const d = draftRef.current;
            if (!d || stop) return;
            if (e.type === "SessionStatus" && e.session_id === d.id) {
               setTitle(e.title);
               if (!e.unused) {
                  saveAgent(d.agentId);
                  dispatch({ type: "sent" });
               }
            } else if (e.type === "TurnFinished" && e.session_id === d.id) {
               dispatch({ type: "turnFinished" });
            }
         })
         .then((u) => (stop ? u() : (off = u)))
         .catch((e) => report("Live updates unavailable", e));
      return () => {
         stop = true;
         off?.();
      };
   }, [client, report]);

   /** Back to a fresh prompt: the next show starts a new draft. */
   const reset = () => {
      dispatch({ type: "reset" });
      setDraft(null);
      onReset();
      setTitle(QUICK_TITLE);
   };
   /** Close: the core removes the Session if nobody wrote in it; the next show starts a new draft. */
   const close = () => {
      const d = draft;
      reset();
      if (d)
         discardEmpty(client, d.id).catch((e) =>
            report("Could not remove the empty Quick Session", e),
         );
   };
   const merge = () => {
      if (!draft) return;
      overlayHost.merge(draft.id).then(reset, (e) => report("Could not open the main window", e));
   };
   /** Another Agent: its models are known only once it runs, so the draft is replaced. */
   const pickAgent = useCallback(
      (agentId: string) => {
         const d = draftRef.current;
         if (!d || d.agentId === agentId) return;
         saveAgent(agentId);
         setDraft(null);
         discardEmpty(client, d.id).catch(() => {});
      },
      [client],
   );
   // The same Agent · model chip before and after the first message; after it the Agent is fixed.
   const agentSwitch = useMemo<AgentSwitch | undefined>(
      () =>
         draft
            ? {
                 agents: agents.map((a) => ({ id: a.id, name: a.name })),
                 current: draft.agentId,
                 onPick: pickAgent,
                 locked: mode !== "prompt",
              }
            : undefined,
      [mode, draft, agents, pickAgent],
   );
   return { draft, title, error, agentSwitch, close, merge };
}
