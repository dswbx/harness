import type { Event, ForkPoint } from "./generated";

/** A Thread of a Session as the Views list it: the Main Thread and its Side Threads. */
export type ThreadInfo = {
  id: string;
  main: boolean;
  /** First prompt (truncated), else null (nothing asked yet). */
  title: string | null;
  forkedFrom: ForkPoint | null;
  /** Finished or running Turns started in this Thread. */
  turns: number;
};

const TITLE_MAX = 48;
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const cut = (s: string) => (s.length > TITLE_MAX ? s.slice(0, TITLE_MAX - 1).trimEnd() + "…" : s);

/**
 * One step of `threadsOf`, for Views that fold Events themselves. Returns `list` itself when `e` changes
 * nothing. Main Thread first, then Side Threads in start order.
 */
export function stepThreads(list: readonly ThreadInfo[], e: Event): readonly ThreadInfo[] {
  const k = e.kind;
  if (!e.thread_id || (k.type !== "ThreadStarted" && k.type !== "TurnStarted")) return list;
  const id = e.thread_id;
  const at = list.findIndex((t) => t.id === id);
  const prev: ThreadInfo = at >= 0 ? list[at]! : { id, main: false, title: null, forkedFrom: null, turns: 0 };
  let t = prev;
  switch (k.type) {
    case "ThreadStarted": {
      t = { ...prev, main: k.main, forkedFrom: k.forked_from ?? null };
      break;
    }
    case "TurnStarted": {
      const text = oneLine(k.text);
      t = { ...prev, turns: prev.turns + 1, title: prev.turns === 0 && text ? cut(text) : prev.title };
      break;
    }
  }
  const next = at >= 0 ? list.map((x, i) => (i === at ? t : x)) : [...list, t];
  return t.main && at < 0 ? [t, ...list] : next;
}

/** Main + Side Threads of a Session Log. Pure derivation (ADR 0012). */
export const threadsOf = (events: readonly Event[]): ThreadInfo[] => [...events.reduce(stepThreads, [] as readonly ThreadInfo[])];
