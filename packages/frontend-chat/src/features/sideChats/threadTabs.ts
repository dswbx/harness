import { useCallback, useEffect, useRef, useState } from "react";
import { sessionJson } from "../../lib/jsonStore";

/**
 * The Side Chats panel's tabs: the open Side Threads, in tab order, and the one shown. Closing a tab only
 * hides it; the Thread stays in the Session Log (ADR 0018). Kept per Session, apart from the dock layout.
 * Pure helpers first, then the storage, then the hook that holds them.
 */
export type ThreadTabs = {
   /** Open Side Threads (and drafts), in tab order. */
   threads: string[];
   /** The tab shown. */
   thread: string | null;
};

export const NO_TABS: ThreadTabs = { threads: [], thread: null };

/** A side chat tab not started yet: its Side Thread forks on the first message (`draft:<uuid>`). */
export const isDraftThread = (id: string) => id.startsWith("draft:");

/** Opens a Side Thread (appended when new) and makes it the active one. */
export const openThread = (t: ThreadTabs, id: string): ThreadTabs => ({
   threads: t.threads.includes(id) ? t.threads : [...t.threads, id],
   thread: id,
});

/** The draft tab became Side Thread `to`: same place in the tabs, still active if it was. */
export const replaceThread = (t: ThreadTabs, from: string, to: string): ThreadTabs =>
   t.threads.includes(from)
      ? {
           threads: t.threads.map((x) => (x === from ? to : x)),
           thread: t.thread === from ? to : t.thread,
        }
      : t;

/** Selects an open Side Thread. */
export const selectThread = (t: ThreadTabs, id: string): ThreadTabs =>
   t.threads.includes(id) ? { ...t, thread: id } : t;

/** Closes a Side Thread; if it was active the neighbour on its left (else right) takes over. */
export function closeThread(t: ThreadTabs, id: string): ThreadTabs {
   const at = t.threads.indexOf(id);
   if (at < 0) return t;
   const threads = t.threads.filter((x) => x !== id);
   const thread = t.thread === id ? (threads[at - 1] ?? threads[at] ?? null) : t.thread;
   return { threads, thread };
}

/**
 * Open Side Thread tabs that have something to show: drafts, Threads whose replay arrived, and Threads just
 * started here (`started`), whose replay is on its way.
 */
export function openThreadIds(
   threads: readonly string[],
   known: Record<string, unknown>,
   started: Record<string, unknown> = {},
): string[] {
   return threads.filter((id) => isDraftThread(id) || !!known[id] || id in started);
}

/** Moves tab `id` in front of tab `before` (null: to the end). */
export function moveThread(t: ThreadTabs, id: string, before: string | null): ThreadTabs {
   if (id === before || !t.threads.includes(id)) return t;
   const rest = t.threads.filter((x) => x !== id);
   const at = before === null ? rest.length : rest.indexOf(before);
   if (at < 0) return t;
   const threads = [...rest.slice(0, at), id, ...rest.slice(at)];
   return threads.every((x, i) => x === t.threads[i]) ? t : { ...t, threads };
}

/** The Side Thread shown: the selected one if open, else the last open one. */
export function activeThreadId(selected: string | null, open: readonly string[]): string | null {
   return selected && open.includes(selected) ? selected : (open.at(-1) ?? null);
}

/** The tab "new side chat" shows: an open draft is reused. */
export function newThreadTabId(t: ThreadTabs, uuid: () => string): string {
   return t.threads.find(isDraftThread) ?? `draft:${uuid()}`;
}

/** Whether a started Side Thread takes `draft`'s tab (else it opens a tab of its own). */
export const takesDraftTab = (t: ThreadTabs, draft: string | undefined): draft is string =>
   !!draft && t.threads.includes(draft);

/** A Side Thread started: it takes the draft tab's place when there is one, else a new tab. */
export const threadStarted = (t: ThreadTabs, draft: string | undefined, threadId: string) =>
   takesDraftTab(t, draft) ? replaceThread(t, draft, threadId) : openThread(t, threadId);

// Storage

const KEY = (sessionId: string) => `harness.chat.sideThreads.${sessionId}`;
// Before the tabs had a key of their own they lived in the dock layout's value (and, before that, in the old
// right-panel value). Read from those when there is no key of the tabs' own. Never written here.
const LAYOUT_KEY = (sessionId: string) => `harness.chat.layout.${sessionId}`;
const RIGHT_PANEL_KEY = (sessionId: string) => `harness.chat.panel.${sessionId}`;

const readJson = (key: string, sessionId: string): unknown => sessionJson(key, sessionId).get();

/** `threads` and `thread` of a stored value, dropping what is invalid; the active one falls back to the last. */
export function parseThreadTabs(raw: unknown): ThreadTabs {
   const v = (raw ?? {}) as { threads?: unknown; thread?: unknown };
   const threads = Array.isArray(v.threads)
      ? v.threads.filter((t): t is string => typeof t === "string")
      : [];
   const thread =
      typeof v.thread === "string" && threads.includes(v.thread)
         ? v.thread
         : (threads.at(-1) ?? null);
   return { threads, thread };
}

/** The Session's tabs: its own key, else the `threads`/`thread` fields an older build kept in the layout's value. */
export function loadThreadTabs(sessionId: string): ThreadTabs {
   const own = readJson(KEY(sessionId), sessionId);
   if (own !== undefined) return parseThreadTabs(own);
   return parseThreadTabs(
      readJson(LAYOUT_KEY(sessionId), sessionId) ?? readJson(RIGHT_PANEL_KEY(sessionId), sessionId),
   );
}

/** Whether the tabs have a key of their own yet. */
const hasOwnKey = (sessionId: string) => readJson(KEY(sessionId), sessionId) !== undefined;

export function saveThreadTabs(sessionId: string, t: ThreadTabs) {
   sessionJson(KEY(sessionId), sessionId).set({ v: 1, ...t });
}

/**
 * The Session's tabs as state, kept in storage (unless `persist` is false: the Quick Overlay keeps them in
 * memory). `apply` takes the change as a function and returns the tabs it left, also when called twice before
 * the next render. Nothing is written until there is something to keep (the tabs came from an older value, or
 * changed), so a Session without side chats gets no key.
 */
export function useThreadTabs(sessionId: string, persist: boolean) {
   const [tabs, setTabs] = useState<ThreadTabs>(() =>
      persist ? loadThreadTabs(sessionId) : NO_TABS,
   );
   // `apply` is the only writer: assigning it per render could reset it to stale tabs.
   const latest = useRef(tabs);
   const apply = useCallback((f: (t: ThreadTabs) => ThreadTabs) => {
      const next = f(latest.current);
      latest.current = next;
      setTabs(next);
      return next;
   }, []);
   useEffect(() => {
      if (!persist) return;
      if (tabs.threads.length === 0 && !hasOwnKey(sessionId)) return;
      saveThreadTabs(sessionId, tabs);
   }, [persist, sessionId, tabs]);
   return { tabs, apply, tabsRef: latest };
}
