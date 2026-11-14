import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Event } from "@harness/api";
import { describe, expect, it } from "vitest";
import { type ChatState, initialState, reduce, reduceBatch } from "./reducer";

/**
 * The reducer is a pure function of (state, event): React compares states by identity, so a state
 * that was handed out must never change. Every intermediate state is deep-frozen (ESM is strict:
 * a write to a frozen object throws), then the fold goes on.
 */
const deepFreeze = <T>(x: T): T => {
   if (x === null || typeof x !== "object" || Object.isFrozen(x)) return x;
   // A frozen object holds only frozen children, so a shared (already frozen) subtree is skipped.
   Object.freeze(x);
   for (const v of Object.values(x)) deepFreeze(v);
   return x;
};

const dir = join(__dirname, "../../../../crates/harness-core/tests/golden");
const logs = readdirSync(dir)
   .filter((f) => f.endsWith(".jsonl"))
   .sort()
   .map((name) => ({
      name,
      events: readFileSync(join(dir, name), "utf8")
         .split("\n")
         .filter((l) => l.trim())
         .map((l) => JSON.parse(l) as Event),
   }));

describe("the chat reducer never mutates its input", () => {
   it("has logs", () => {
      expect(logs.length).toBeGreaterThanOrEqual(2);
   });

   for (const { name, events } of logs) {
      it(`${name}: one event at a time, every state frozen`, () => {
         let s: ChatState = deepFreeze(initialState());
         for (const e of events) s = deepFreeze(reduce(s, e));
         expect(s.items.length).toBeGreaterThan(0);
      });

      it(`${name}: batched in slices of 7, every state frozen, same result`, () => {
         let s: ChatState = deepFreeze(initialState());
         for (let i = 0; i < events.length; i += 7)
            s = deepFreeze(reduceBatch(s, deepFreeze(events.slice(i, i + 7))));
         expect(s).toEqual(events.reduce(reduce, initialState()));
      });

      it(`${name}: frozen events too`, () => {
         const frozen = deepFreeze(structuredClone(events));
         expect(() => reduceBatch(deepFreeze(initialState()), frozen)).not.toThrow();
      });
   }
});
