import { createSessionApi, type SessionApi } from "@harness/api";
import { MockTransport } from "@harness/api/mock";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useChatLog } from "./useChatLog";

afterEach(() => vi.restoreAllMocks());

/** A mock Session with `count` Events; each test uses its own id (the fold cache is module-wide). */
function session(id: string, count: number) {
   const mock = new MockTransport([], []);
   mock.logs.set(id, []);
   const append = (n: number) => {
      for (let i = 0; i < n; i++) mock.emit(id, { type: "Error", message: "x" }, null);
   };
   append(count);
   const api = { ...createSessionApi(mock, id), warmUp: async () => {} } as SessionApi;
   const mount = () => {
      const seen: { inert: boolean; loaded: boolean }[] = [];
      const hook = renderHook(() => {
         const r = useChatLog(api);
         seen.push({ inert: r.inert, loaded: r.state.loaded });
         return r;
      });
      return { hook, seen };
   };
   return { api, append, mount };
}

it("a first load (no cached fold) is never inert: the prompt box takes input while it loads", async () => {
   const s = session("chat-first", 20);
   const v = s.mount();
   await waitFor(() => expect(v.hook.result.current.state.loaded).toBe(true));
   expect(v.seen.every((r) => !r.inert)).toBe(true);
   expect(v.seen[0].loaded).toBe(false);
});

it("a cached fold is inert until the load confirms it whole, then not", async () => {
   const s = session("chat-cached", 10);
   const first = s.mount();
   await waitFor(() => expect(first.hook.result.current.state.loaded).toBe(true));
   first.hook.unmount();
   // A Turn could end while the Session is not shown.
   s.append(3);
   const again = s.mount();
   // The cached fold renders at once, and is inert.
   expect(again.seen[0]).toEqual({ inert: true, loaded: true });
   await waitFor(() => expect(again.hook.result.current.inert).toBe(false));
   // Inert only before the delta was folded: never again after.
   const firstFree = again.seen.findIndex((r) => !r.inert);
   expect(again.seen.slice(firstFree).every((r) => !r.inert)).toBe(true);
   again.hook.unmount();
});

it("a cached fold whose load fails is not inert for good", async () => {
   vi.spyOn(console, "error").mockImplementation(() => {});
   const s = session("chat-failed", 4);
   const first = s.mount();
   await waitFor(() => expect(first.hook.result.current.state.loaded).toBe(true));
   first.hook.unmount();
   vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
   try {
      s.api.readLogPage = () => Promise.reject(new Error("read down"));
      const again = s.mount();
      expect(again.hook.result.current.inert).toBe(true);
      await act(() => vi.advanceTimersByTimeAsync(10_000));
      expect(again.hook.result.current.inert).toBe(false);
   } finally {
      vi.useRealTimers();
   }
});
