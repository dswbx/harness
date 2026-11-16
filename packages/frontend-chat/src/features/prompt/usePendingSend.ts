import { errText } from "@harness/api";
import { useEffect, useRef } from "react";
import {
   hasArrived,
   nextBase,
   type PendingMessage,
   updatePendingMessages,
   usePendingMessages,
} from "./pendingMessages";

/**
 * The send flow of a prompt box's pending messages (see `pendingMessages.ts`): `deliver` shows a message
 * as sending until its call settles, `retry` sends the failed ones again in order (stopping at the
 * first failure), and a sent message leaves the list once its row has arrived.
 *
 * `userCount`: the user messages in the Thread now. `send`: how a pending message goes out.
 * `onError`: gets the message of a failed send, and null when a retry starts.
 */
export function usePendingSend({
   key,
   userCount,
   send,
   onError,
}: {
   key: string;
   userCount: number;
   send: (p: PendingMessage) => Promise<void>;
   onError: (message: string | null) => void;
}) {
   const pending = usePendingMessages(key);
   // `deliver` runs in loops across renders: it needs the current count, not its closure's.
   const userCountRef = useRef(userCount);
   userCountRef.current = userCount;
   // A sent message is replaced by its row in the list once that row has arrived.
   useEffect(() => {
      if (pending.some((p) => p.status === "sent" && hasArrived(p, userCount)))
         updatePendingMessages(key, (cur) =>
            cur.filter((p) => !(p.status === "sent" && hasArrived(p, userCount))),
         );
   }, [key, pending, userCount]);
   const failed = pending.filter((p) => p.status === "failed");
   const sending = pending.some((p) => p.status === "sending");

   /** Shows `item` as sending until `run` settles. True when it was sent. */
   const deliver = (item: PendingMessage, run: () => Promise<void>) =>
      deliverPending(key, item, userCountRef.current, run, onError);
   const retry = async () => {
      onError(null);
      for (const p of failed) {
         if (!(await deliver(p, () => send(p)))) return;
      }
   };
   return { pending, failed, sending, deliver, retry };
}

/**
 * Shows `item` in composer `key` as sending until `run` settles, then as sent (it leaves once its row has
 * arrived) or failed. True when it was sent. Also for a message sent before its prompt box exists (the first
 * message of a side chat, sent while its Thread starts).
 */
export async function deliverPending(
   key: string,
   item: PendingMessage,
   userCount: number,
   run: () => Promise<void>,
   onError: (message: string) => void,
) {
   updatePendingMessages(key, (cur) => {
      const next: PendingMessage = {
         ...item,
         status: "sending",
         base: nextBase(cur, item.id, userCount),
      };
      return cur.some((p) => p.id === item.id)
         ? cur.map((p) => (p.id === item.id ? next : p))
         : [...cur, next];
   });
   const mark = (status: PendingMessage["status"]) =>
      updatePendingMessages(key, (cur) =>
         cur.map((p) => (p.id === item.id ? { ...p, status } : p)),
      );
   try {
      await run();
      mark("sent");
      // Not every prompt makes a Turn (e.g. a mock command): don't keep it forever.
      setTimeout(
         () => updatePendingMessages(key, (cur) => cur.filter((p) => p.id !== item.id)),
         5000,
      );
      return true;
   } catch (err) {
      onError(errText(err));
      mark("failed");
      return false;
   }
}
