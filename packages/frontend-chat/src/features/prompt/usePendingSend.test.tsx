import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getPendingMessages, type PendingMessage, updatePendingMessages } from "./pendingMessages";
import { usePendingSend } from "./usePendingSend";

let n = 0;
const msg = (id: string): PendingMessage => ({
   id,
   prompt: id,
   inputs: [],
   files: [],
   comments: [],
   snap: {} as never,
   status: "sending",
   base: 0,
});

afterEach(() => vi.useRealTimers());

function setup(userCount = 0) {
   const key = `test-${n++}`;
   const sent: string[] = [];
   const errors: (string | null)[] = [];
   let fail = new Set<string>();
   const send = vi.fn(async (p: PendingMessage) => {
      if (fail.has(p.id)) throw new Error(`no ${p.id}`);
      sent.push(p.id);
   });
   const hook = renderHook(
      ({ count }) =>
         usePendingSend({ key, userCount: count, send, onError: (e) => errors.push(e) }),
      { initialProps: { count: userCount } },
   );
   const ids = () => getPendingMessages(key).map((p) => `${p.id}:${p.status}:${p.base}`);
   return {
      key,
      sent,
      errors,
      send,
      hook,
      ids,
      failing: (...id: string[]) => {
         fail = new Set(id);
      },
      deliver: (id: string) =>
         act(() => hook.result.current.deliver(msg(id), () => send(msg(id))).then(() => {})),
      retry: () => act(() => hook.result.current.retry()),
      userCount: (count: number) => hook.rerender({ count }),
   };
}

describe("usePendingSend", () => {
   it("a message shows as sending, then sent, and stays until its row arrives", async () => {
      const t = setup(3);
      let release!: () => void;
      let p!: Promise<boolean>;
      act(() => {
         p = t.hook.result.current.deliver(msg("a"), () => new Promise<void>((r) => (release = r)));
      });
      expect(t.ids()).toEqual(["a:sending:3"]);
      expect(t.hook.result.current.sending).toBe(true);
      await act(async () => {
         release();
         expect(await p).toBe(true);
      });
      expect(t.ids()).toEqual(["a:sent:3"]);
      t.userCount(3);
      expect(t.ids()).toEqual(["a:sent:3"]);
      t.userCount(4);
      expect(t.ids()).toEqual([]);
   });

   it("a failed message stays as failed, reports the error, and its row never clears it", async () => {
      const t = setup(0);
      t.failing("a");
      await t.deliver("a");
      expect(t.ids()).toEqual(["a:failed:0"]);
      expect(t.errors).toEqual(["no a"]);
      expect(t.hook.result.current.failed.map((p) => p.id)).toEqual(["a"]);
      t.userCount(5);
      expect(t.ids()).toEqual(["a:failed:0"]);
   });

   it("a sent message is dropped after 5s even when no row arrives", async () => {
      vi.useFakeTimers();
      const t = setup(0);
      await t.deliver("a");
      expect(t.ids()).toEqual(["a:sent:0"]);
      act(() => {
         vi.advanceTimersByTime(5000);
      });
      expect(t.ids()).toEqual([]);
   });

   it("two failed messages retried keep both bubbles until their own rows arrive", async () => {
      const t = setup(2);
      t.failing("a", "b");
      await t.deliver("a");
      await t.deliver("b");
      expect(t.ids()).toEqual(["a:failed:2", "b:failed:2"]);

      t.failing();
      await t.retry();
      // Sent in order; the second waits for one more row than the first.
      expect(t.sent).toEqual(["a", "b"]);
      expect(t.errors.at(-1)).toBeNull();
      expect(t.ids()).toEqual(["a:sent:2", "b:sent:3"]);

      t.userCount(3);
      expect(t.ids()).toEqual(["b:sent:3"]);
      t.userCount(4);
      expect(t.ids()).toEqual([]);
   });

   it("both bubbles stay when the rows have not arrived yet", async () => {
      const t = setup(0);
      t.failing("a", "b");
      await t.deliver("a");
      await t.deliver("b");
      t.failing();
      await t.retry();
      t.userCount(1);
      expect(t.ids()).toEqual(["b:sent:1"]);
      expect(getPendingMessages(t.key)).toHaveLength(1);
   });

   it("retry stops at the first message that fails again", async () => {
      const t = setup(0);
      t.failing("a", "b");
      await t.deliver("a");
      await t.deliver("b");
      t.failing("a");
      await t.retry();
      expect(t.sent).toEqual([]);
      expect(t.ids()).toEqual(["a:failed:0", "b:failed:0"]);
      expect(t.send).toHaveBeenCalledTimes(3);
   });

   it("a message sent while another is on its way counts it in its base", async () => {
      const t = setup(1);
      act(() => {
         updatePendingMessages(t.key, () => [{ ...msg("x"), status: "sent", base: 1 }]);
      });
      await t.deliver("b");
      expect(t.ids()).toEqual(["x:sent:1", "b:sent:2"]);
      // Only x's row has arrived.
      t.userCount(2);
      await waitFor(() => expect(t.ids()).toEqual(["b:sent:2"]));
   });
});
