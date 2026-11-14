import { describe, expect, test } from "vitest";
import { hasArrived, nextBase, type PendingMessage } from "./pendingMessages";

const msg = (id: string, status: PendingMessage["status"], base = 0): PendingMessage => ({
   id,
   prompt: id,
   inputs: [],
   files: [],
   comments: [],
   snap: {} as PendingMessage["snap"],
   status,
   base,
});

describe("nextBase", () => {
   test("counts the other non-failed pending messages, not the item itself", () => {
      const cur = [msg("a", "failed"), msg("b", "sending"), msg("c", "sent")];
      expect(nextBase(cur, "a", 4)).toBe(6);
      expect(nextBase(cur, "b", 4)).toBe(5);
   });

   test("retrying two failed messages in a row gives increasing bases", () => {
      let cur = [msg("a", "failed"), msg("b", "failed")];
      const baseA = nextBase(cur, "a", 2);
      cur = cur.map((p) => (p.id === "a" ? { ...p, status: "sending", base: baseA } : p));
      const baseB = nextBase(cur, "b", 2);
      cur = cur.map((p) => (p.id === "b" ? { ...p, status: "sending", base: baseB } : p));
      expect(baseA).toBe(2);
      expect(baseB).toBe(3);
      // Only the first row has arrived: the second is still pending.
      expect(hasArrived(cur[0], 3)).toBe(true);
      expect(hasArrived(cur[1], 3)).toBe(false);
   });
});
