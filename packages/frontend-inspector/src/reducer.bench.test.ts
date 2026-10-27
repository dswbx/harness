import { describe, expect, it } from "vitest";
import type { Event } from "@harness/api";
import { init, reduce, reduceBatch } from "./reducer";

const log = (n: number): Event[] =>
  Array.from({ length: n }, (_, seq) => ({
    v: 1, seq, session_id: "s", thread_id: "main", ts_ms: 0, kind: { type: "AgentMessageChunk" as const, text: "x" },
  }));

describe("inspector reducer performance", () => {
  it("replays 20k events in frame-sized batches quickly", () => {
    const events = log(20_000);
    const t0 = performance.now();
    let s = init();
    for (let i = 0; i < events.length; i += 200) s = reduceBatch(s, events.slice(i, i + 200));
    const ms = performance.now() - t0;
    console.log(`inspector reducer: 20k in 200-event frames ${ms.toFixed(1)} ms`);
    expect(s.events).toHaveLength(20_000);
    expect(ms).toBeLessThan(500);
  });

  it("per-event fold matches batched", () => {
    const events = log(500);
    expect(events.reduce(reduce, init())).toEqual(reduceBatch(init(), events));
  });
});
