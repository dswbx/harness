import { draftStorageKey, notifyDraftsChanged } from "@harness/api";
import { useCallback, useSyncExternalStore } from "react";
import type { PendingAttachment } from "./attachments";
import type { PromptSnapshot } from "./promptMarkdown";

/**
 * Half-written prompts, kept per composer (`composerKey`) so they survive switching Sessions or Threads.
 * The editor content goes to localStorage (it also survives a restart); attachments stay in memory
 * (image previews are data URLs, too big to store).
 */
export function getDraft(key: string): PromptSnapshot | null {
   try {
      const raw = localStorage.getItem(draftStorageKey(key));
      return raw ? (JSON.parse(raw) as PromptSnapshot) : null;
   } catch {
      return null;
   }
}

/** Stores `snap` for `key`; `null` (an empty box) removes it. */
export function setDraft(key: string, snap: PromptSnapshot | null) {
   try {
      const k = draftStorageKey(key);
      const had = localStorage.getItem(k) !== null;
      if (snap) localStorage.setItem(k, JSON.stringify(snap));
      else localStorage.removeItem(k);
      // Only having a draft or not matters to the sidebar: don't wake it on every keystroke.
      if (had !== !!snap) notifyDraftsChanged();
   } catch {
      // Storage blocked or full: the draft stays unsaved.
   }
}

const EMPTY: PendingAttachment[] = [];
const files = new Map<string, PendingAttachment[]>();
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
   listeners.add(l);
   return () => listeners.delete(l);
};

export function updateDraftAttachments(
   key: string,
   f: (cur: PendingAttachment[]) => PendingAttachment[],
) {
   const next = f(files.get(key) ?? EMPTY);
   if (next.length) files.set(key, next);
   else files.delete(key);
   for (const l of listeners) l();
}

/** Drops everything waiting in `key`'s composer (e.g. a closed side chat tab). */
export function clearDraft(key: string) {
   setDraft(key, null);
   if (files.has(key)) updateDraftAttachments(key, () => EMPTY);
}

/** The attachments waiting in `key`'s composer, with a setter like `useState`'s. */
export function useDraftAttachments(key: string) {
   const list = useSyncExternalStore(subscribe, () => files.get(key) ?? EMPTY);
   const set = useCallback(
      (v: PendingAttachment[] | ((cur: PendingAttachment[]) => PendingAttachment[])) =>
         updateDraftAttachments(key, typeof v === "function" ? v : () => v),
      [key],
   );
   return [list, set] as const;
}
