import type { Event, ForkPoint, TextAnchor } from "../generated";

/** A Thread of a Session as the Views list it: the Main Thread and its Side Threads. */
export type ThreadInfo = {
   id: string;
   main: boolean;
   /** The Agent's title for the Thread (`SessionInfoUpdated`), else its first prompt (truncated), else null. */
   title: string | null;
   /** The Agent's newest title for the Thread; null until it sends one. */
   agentTitle: string | null;
   forkedFrom: ForkPoint | null;
   /** Inline Threads: the quoted Main Thread text the Thread is about (ADR 0031). */
   anchor: TextAnchor | null;
   /** Resolved by the user (`SideThreadResolved`); reopening clears it. */
   resolved: boolean;
   /** Finished or running Turns started in this Thread. */
   turns: number;
   /** ms epoch the Thread started or its newest Turn did. */
   lastAt: number;
};

const TITLE_MAX = 48;
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const cut = (s: string) => (s.length > TITLE_MAX ? `${s.slice(0, TITLE_MAX - 1).trimEnd()}…` : s);

/** A Thread's title from its first prompt (null when that has no text). */
export function threadTitle(prompt: string): string | null {
   const text = oneLine(prompt);
   return text ? cut(text) : null;
}

/**
 * One step of `threadsOf`, for Views that fold Events themselves. Returns `list` itself when `e` changes
 * nothing. Main Thread first, then Side Threads in start order.
 */
export function stepThreads(list: readonly ThreadInfo[], e: Event): readonly ThreadInfo[] {
   const k = e.kind;
   if (
      k.type !== "ThreadStarted" &&
      k.type !== "TurnStarted" &&
      k.type !== "SessionInfoUpdated" &&
      k.type !== "SideThreadResolved"
   )
      return list;
   // A Session-level title names the Main Thread.
   const id =
      e.thread_id ?? (k.type === "SessionInfoUpdated" ? list.find((x) => x.main)?.id : null);
   if (!id) return list;
   const at = list.findIndex((t) => t.id === id);
   // Titles and resolve state only for Threads that started.
   if (at < 0 && (k.type === "SessionInfoUpdated" || k.type === "SideThreadResolved")) return list;
   const prev: ThreadInfo =
      at >= 0
         ? list[at]!
         : {
              id,
              main: false,
              title: null,
              agentTitle: null,
              forkedFrom: null,
              anchor: null,
              resolved: false,
              turns: 0,
              lastAt: e.ts_ms,
           };
   let t = prev;
   switch (k.type) {
      case "ThreadStarted": {
         t = {
            ...prev,
            main: k.main,
            forkedFrom: k.forked_from ?? null,
            anchor: k.anchor ?? null,
            lastAt: e.ts_ms,
         };
         break;
      }
      case "SideThreadResolved": {
         if (prev.main || prev.resolved === k.resolved) return list;
         t = { ...prev, resolved: k.resolved };
         break;
      }
      case "TurnStarted": {
         t = {
            ...prev,
            turns: prev.turns + 1,
            lastAt: e.ts_ms,
            title: prev.agentTitle ?? ((prev.turns === 0 && threadTitle(k.text)) || prev.title),
         };
         break;
      }
      case "SessionInfoUpdated": {
         const title = k.title ? oneLine(k.title) : "";
         if (!title || title === prev.agentTitle) return list;
         // A fork can carry the Main Thread's title over: that names the Main Thread, not this one.
         const main = list.find((x) => x.main);
         if (prev.forkedFrom && main && main.id !== id && title === main.agentTitle) return list;
         t = { ...prev, agentTitle: title, title: cut(title) };
         break;
      }
   }
   const next = at >= 0 ? list.map((x, i) => (i === at ? t : x)) : [...list, t];
   return t.main && at < 0 ? [t, ...list] : next;
}

/** Main + Side Threads of a Session Log. Pure derivation (ADR 0012). */
export const threadsOf = (events: readonly Event[]): ThreadInfo[] => [
   ...events.reduce(stepThreads, [] as readonly ThreadInfo[]),
];
