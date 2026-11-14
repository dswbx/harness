import type { AppEvent, HarnessClient, SessionSummary } from "@harness/api";
import { useEffect, useRef, useState } from "react";
import { useReportError } from "./toast";

type StatusEvent = Extract<AppEvent, { type: "SessionStatus" }>;

/** The list with one Session's status and title patched (also counts as activity); null: unknown Session, the list is stale. */
export function applyStatus(
   list: SessionSummary[],
   e: StatusEvent,
   now: number,
): SessionSummary[] | null {
   const i = list.findIndex((s) => s.id === e.session_id);
   if (i < 0) return null;
   return list.map((s, n) =>
      n === i ? { ...s, status: e.status, title: e.title, updated_ms: now } : s,
   );
}

/**
 * The Session list, kept fresh: SessionsChanged reloads, SessionStatus patches one row, a slow
 * poll is the safety net. `settled`: the first load answered (or failed).
 */
export function useSessions(client: HarnessClient, onAgentsChanged?: () => void) {
   const [sessions, setSessions] = useState<SessionSummary[]>([]);
   const [settled, setSettled] = useState(false);
   const report = useReportError();
   const agentsChanged = useRef(onAgentsChanged);
   agentsChanged.current = onAgentsChanged;
   useEffect(() => {
      let stop = false;
      let failed = false;
      const load = () =>
         client.listSessions().then(
            (l) => {
               failed = false;
               if (!stop) {
                  setSessions(l);
                  setSettled(true);
               }
            },
            (e) => {
               if (!failed) report("Could not load sessions", e);
               failed = true;
               if (!stop) setSettled(true);
            },
         );
      void load();
      const poll = setInterval(load, 30_000);
      let unsub: (() => void) | undefined;
      client
         .subscribeApp((e) => {
            if (stop) return;
            if (e.type === "SessionsChanged") void load();
            else if (e.type === "SessionStatus") {
               setSessions((l) => {
                  const next = applyStatus(l, e, Date.now());
                  if (!next) void load(); // unknown Session: the list is stale
                  return next ?? l;
               });
            } else if (e.type === "AgentsChanged") agentsChanged.current?.();
         })
         .then((u) => (stop ? u() : (unsub = u)))
         .catch((e) => report("Live updates unavailable (falling back to polling)", e));
      return () => {
         stop = true;
         clearInterval(poll);
         unsub?.();
      };
   }, [client, report]);
   return { sessions, setSessions, settled };
}
