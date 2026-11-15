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
      const small = syntheticLog(50_000);
      const big = syntheticLog(200_000);
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
      console.log(`chat reducer: 50k=${a.toFixed(1)} ms, 200k=${b.toFixed(1)} ms`);
      expect(b / a).toBeLessThan(10);
      expect(b).toBeLessThan(4000);
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

   it("StateChanged on a large Session State (2k keys, 5k patches) with Side Threads and plans", () => {
      const ev = (seq: number, thread_id: string, kind: Event["kind"]): Event => ({
         v: 1,
         seq,
         session_id: "s",
         thread_id,
         ts_ms: 0,
         kind,
      });
      const events: Event[] = [ev(0, "main", { type: "ThreadStarted", agent_id: "a", main: true })];
      const big: Record<string, unknown> = {};
      for (let i = 0; i < 2000; i++) big[`k${i}`] = { n: i, tags: ["a", "b"], nested: { v: i } };
      events.push(
         ev(events.length, "main", {
            type: "StateChanged",
            ops: [{ op: "replace", path: "", value: big }],
            by: "agent",
         }),
      );
      for (let t = 0; t < 5; t++)
         events.push(
            ev(events.length, `side${t}`, { type: "ThreadStarted", agent_id: "a", main: false }),
         );
      for (let i = 0; i < 5000; i++) {
         events.push(
            ev(events.length, i % 3 === 0 ? `side${i % 5}` : "main", {
               type: "StateChanged",
               ops: [
                  { op: "replace", path: `/k${i % 2000}/nested/v`, value: i },
                  { op: "add", path: `/k${(i * 7) % 2000}/tags/-`, value: `t${i}` },
               ],
               by: "agent",
            }),
         );
         if (i % 50 === 0)
            events.push(
               ev(events.length, "main", {
                  type: "TaskListUpdated",
                  entries: [
                     { content: `step ${i}`, status: "pending", priority: "medium" },
                  ] as never,
               }),
            );
      }
      const t0 = performance.now();
      const s = reduceBatch(initialState(), events);
      const ms = performance.now() - t0;
      console.log(`chat reducer: 5k StateChanged on a 2k-key state in ${ms.toFixed(1)} ms`);
      const state = s.uiState as Record<string, { nested: { v: number } }>;
      expect(Object.keys(state)).toHaveLength(2000);
      expect(state.k4999 ?? state.k1999).toBeDefined();
      // Was ~44 s with a whole-state structuredClone per patch; ~2 s with path copying (the top
      // level of a 2k-key object is still copied). The bound leaves CI noise room.
      expect(ms).toBeLessThan(10_000);
   });
});
