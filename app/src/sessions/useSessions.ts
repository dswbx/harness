import type { AppEvent, HarnessClient, SessionSummary } from "@harness/api";
import { useEffect, useRef, useState } from "react";
import { useReportError } from "../platform/toast";

type StatusEvent = Extract<AppEvent, { type: "SessionStatus" }>;
const TOLD_EVERY_MS = 60_000;
type LogHealthEvent = Extract<AppEvent, { type: "SessionLogHealth" }>;

/** The list with one Session's `log_error` set or cleared (its Log cannot be written, or can be again). */
export function applyLogHealth(list: SessionSummary[], e: LogHealthEvent): SessionSummary[] {
   return list.map((s) => (s.id === e.session_id ? { ...s, log_error: e.error } : s));
}

/** The list with one Session's status and title patched (also counts as activity); null: unknown Session, the list is stale. */
export function applyStatus(
   list: SessionSummary[],
   e: StatusEvent,
   now: number,
): SessionSummary[] | null {
   const i = list.findIndex((s) => s.id === e.session_id);
   if (i < 0) return null;
   return list.map((s, n) =>
      n === i ? { ...s, status: e.status, title: e.title, unused: e.unused, updated_ms: now } : s,
   );
}

/**
 * The Session list, kept fresh: SessionsChanged reloads, SessionStatus patches one row, a slow
 * poll is the safety net. `settled`: the first load answered (or failed).
 */
export function useSessions(client: HarnessClient, onAgentsChanged?: () => void) {
   const [sessions, setSessions] = useState<SessionSummary[]>([]);
   const [settled, setSettled] = useState(false);
   // The list as last rendered: titles for the notice.
   const shown = useRef(sessions);
   shown.current = sessions;
   const report = useReportError();
   // Sessions whose unsaved state was already shown, so it is told once per episode.
   const unsaved = useRef(new Set<string>());
   const toldAt = useRef(new Map<string, number>());
   const agentsChanged = useRef(onAgentsChanged);
   agentsChanged.current = onAgentsChanged;
   useEffect(() => {
      let stop = false;
      let failed = false;
      // Once per episode, and once a minute per Session however often the disk flaps.
      const tell = (list: SessionSummary[], id: string, error: string | null | undefined) => {
         if (!error) return void unsaved.current.delete(id);
         const s = list.find((x) => x.id === id);
         if (!s || unsaved.current.has(id)) return;
         unsaved.current.add(id);
         const now = Date.now();
         if (now - (toldAt.current.get(id) ?? -Infinity) < TOLD_EVERY_MS) return;
         toldAt.current.set(id, now);
         report(`This Session ("${s.title}") is not being saved`, error);
      };
      const load = () =>
         client.listSessions().then(
            (l) => {
               failed = false;
               if (!stop) {
                  setSessions(l);
                  setSettled(true);
                  for (const s of l) tell(l, s.id, s.log_error);
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
            } else if (e.type === "SessionLogHealth") {
               setSessions((l) => applyLogHealth(l, e));
               tell(shown.current, e.session_id, e.error);
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
