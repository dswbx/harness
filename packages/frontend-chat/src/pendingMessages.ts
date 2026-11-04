import type { AttachmentInput } from "@harness/api";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { PendingAttachment } from "./attachments";
import type { PromptSnapshot } from "./promptMarkdown";
import type { ReviewComment } from "./reviewComments";

/**
 * A message the user sent that is not in the Session Log yet: the Harness logs `TurnStarted` only
 * once the Agent is up. It is still composer state, like a draft (ADR 0003), so "Edit" can put back
 * exactly what was sent. Kept per composer (`composerKey`) outside React: the prompt box sends it,
 * the message list shows it, and a send outlives switching to another Session.
 */
export type PendingMessage = {
   id: string;
   prompt: string;
   inputs: AttachmentInput[];
   files: PendingAttachment[];
   comments: ReviewComment[];
   snap: PromptSnapshot;
   status: "sending" | "sent" | "failed";
   /** It is in the list once the Thread has more user messages than this. */
   base: number;
};

/** What the prompt box does for a pending message's buttons. */
export type PendingActions = { retry: () => void; edit: (item: PendingMessage) => void };

const EMPTY: PendingMessage[] = [];
const byKey = new Map<string, PendingMessage[]>();
const actions = new Map<string, PendingActions>();
const listeners = new Set<() => void>();

export const getPendingMessages = (key: string) => byKey.get(key) ?? EMPTY;

export function updatePendingMessages(key: string, f: (cur: PendingMessage[]) => PendingMessage[]) {
   const next = f(getPendingMessages(key));
   if (next.length) byKey.set(key, next);
   else byKey.delete(key);
   for (const l of listeners) l();
}

/** The Turn's row has arrived (it may do so before `api.prompt` answers). */
export const hasArrived = (p: PendingMessage, userCount: number) =>
   p.status !== "failed" && userCount > p.base;

export const setPendingActions = (key: string, a: PendingActions) => {
   actions.set(key, a);
};
export const pendingActions = (key: string) => actions.get(key);

function subscribe(cb: () => void) {
   listeners.add(cb);
   return () => {
      listeners.delete(cb);
   };
}

export const usePendingMessages = (key: string) =>
   useSyncExternalStore(subscribe, () => getPendingMessages(key));

/** True once `active` has lasted a moment, so a ready Agent does not flash a state. */
export function useSlow(active: boolean) {
   const [slow, setSlow] = useState(false);
   useEffect(() => {
      if (!active) {
         setSlow(false);
         return;
      }
      const t = setTimeout(() => setSlow(true), 300);
      return () => clearTimeout(t);
   }, [active]);
   return slow;
}
