import type { Event } from "@harness/api";
import { describe, expect, it } from "vitest";
import { reduce, reduceBatch } from "../features/renderUi/chatReducer";
import { initialState } from "./reducer";
import { syntheticLog } from "./syntheticLog";

describe("reducer performance", () => {
   it("replays 20k events in well under a second (no O(n^2))", () => {
      const events = syntheticLog();
      expect(events).toHaveLength(20_000);
      const t0 = performance.now();
      const s = reduceBatch(initialState(), events);
      const ms = performance.now() - t0;
      console.log(`chat reducer: 20k events in ${ms.toFixed(1)} ms, ${s.items.length} items`);
      expect(s.items.length).toBeGreaterThan(3000);
      expect(ms).toBeLessThan(500);
   });

   it("replays one giant streaming message (10k chunks) quickly", () => {
      const events: Event[] = [
         {
            v: 1,
            seq: 0,
            session_id: "s",
            thread_id: "main",
            ts_ms: 0,
            kind: { type: "ThreadStarted", agent_id: "a", main: true },
         },
      ];
      for (let i = 1; i <= 10_000; i++)
         events.push({
            v: 1,
            seq: i,
            session_id: "s",
            thread_id: "main",
            ts_ms: 0,
            kind: { type: "AgentMessageChunk", text: "lorem ipsum " },
         });
      const t0 = performance.now();
      const s = reduceBatch(initialState(), events);
      const ms = performance.now() - t0;
      console.log(`chat reducer: 10k chunks in ${ms.toFixed(1)} ms`);
      expect(s.items).toHaveLength(1);
      expect(ms).toBeLessThan(500);
   });

   it("batched in frame-sized slices equals the per-event fold", () => {
      const events = syntheticLog(3000);
      const one = events.reduce(reduce, initialState());
      let sliced = initialState();
      for (let i = 0; i < events.length; i += 37)
         sliced = reduceBatch(sliced, events.slice(i, i + 37));
      expect(sliced).toEqual(one);
   });

   it("scales linearly: 4x events costs far less than 16x time", () => {
      const small = syntheticLog(10_000);
      const big = syntheticLog(40_000);
      // best of 5: one GC pause on a noisy CI runner can skew a single sample
      const time = (ev: Event[]) => {
         let best = Infinity;
         for (let i = 0; i < 5; i++) {
            const t0 = performance.now();
            reduceBatch(initialState(), ev);
            best = Math.min(best, performance.now() - t0);
         }
         return best;
      };
      time(small); // warm up
      const a = Math.max(time(small), 1);
      const b = time(big);
      console.log(`chat reducer: 10k=${a.toFixed(1)} ms, 40k=${b.toFixed(1)} ms`);
      expect(b / a).toBeLessThan(10);
      expect(b).toBeLessThan(1000);
   });

   it("replaying per-frame slices of 20k events stays fast", () => {
      const events = syntheticLog();
      const t0 = performance.now();
      let s = initialState();
      for (let i = 0; i < events.length; i += 200) s = reduceBatch(s, events.slice(i, i + 200));
      const ms = performance.now() - t0;
      console.log(`chat reducer: 20k in 200-event frames ${ms.toFixed(1)} ms`);
      expect(ms).toBeLessThan(500);
   });
});
