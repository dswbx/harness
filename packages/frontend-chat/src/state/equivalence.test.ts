import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Event } from "@harness/api";
import { describe, expect, it } from "vitest";
import { type ChatState, initialState, reduceBatch } from "./reducer";
import { syntheticLog } from "./syntheticLog";

// Proof that restructuring the reducer changed nothing it computes. `equivalence.json` was recorded
// once against the reducer before it was split; every log is folded in batches of 1, 7 and the whole
// log, and the final state plus the state at every 50th Event must match it. Re-record only for an
// intended behaviour change: `RECORD_EQUIVALENCE=1 bun run test equivalence`.

const goldenDir = join(__dirname, "../../../../crates/harness-core/tests/golden");
const file = join(__dirname, "equivalence.json");

/** Stable JSON: sorted keys, Maps and Sets tagged, `undefined` kept distinct from a missing key. */
function stable(v: unknown): unknown {
   if (v === undefined) return "__undefined__";
   if (v === null || typeof v !== "object") return v;
   if (v instanceof Map)
      return { __map__: [...v.entries()].map(([k, x]) => [stable(k), stable(x)]) };
   if (v instanceof Set) return { __set__: [...v].map(stable) };
   if (Array.isArray(v)) return v.map(stable);
   const o = v as Record<string, unknown>;
   return Object.fromEntries(
      Object.keys(o)
         .sort()
         .map((k) => [k, stable(o[k])]),
   );
}
const hash = (s: ChatState) =>
   createHash("sha256")
      .update(JSON.stringify(stable(s)))
      .digest("hex")
      .slice(0, 24);

type Run = { final: string; at: Record<string, string> };
type Recorded = {
   /** Full final states of the golden logs, to read a diff. */
   finals: Record<string, unknown>;
   runs: Record<string, Record<string, Run>>;
};

/** Folds in batches of `size`; hashes the state at the first batch end at or after every 50th Event. */
function fold(events: Event[], size: number, every: number): Run {
   let s = initialState();
   const at: Record<string, string> = {};
   let next = every;
   for (let i = 0; i < events.length; i += size) {
      s = reduceBatch(s, events.slice(i, i + size));
      const n = Math.min(i + size, events.length);
      if (n >= next && n < events.length) {
         at[n] = hash(s);
         next = (Math.floor(n / every) + 1) * every;
      }
   }
   return { final: hash(s), at };
}

const logs: Record<string, () => Event[]> = {};
for (const f of readdirSync(goldenDir)
   .filter((n) => n.endsWith(".jsonl"))
   .sort())
   logs[f] = () =>
      readFileSync(join(goldenDir, f), "utf8")
         .split("\n")
         .filter((l) => l.trim())
         .map((l) => JSON.parse(l) as Event);
logs["synthetic-3000"] = () => syntheticLog(3000);
// Too long to hash intermediates cheaply: only the final state.
const finalOnly: Record<string, () => Event[]> = { "synthetic-20000": () => syntheticLog(20_000) };

const sizes = (n: number) => [1, 7, n];
const key = (b: number, n: number) => (b === n ? "all" : String(b));

function compute(): Recorded {
   const out: Recorded = { finals: {}, runs: {} };
   for (const [name, get] of Object.entries({ ...logs, ...finalOnly })) {
      const ev = get();
      const every = name in finalOnly ? Number.POSITIVE_INFINITY : 50;
      out.runs[name] = {};
      for (const b of sizes(ev.length)) out.runs[name]![key(b, ev.length)] = fold(ev, b, every);
      if (name.endsWith(".jsonl")) out.finals[name] = stable(reduceBatch(initialState(), ev));
   }
   return out;
}

describe("reducer equivalence with the recorded fold", () => {
   if (process.env.RECORD_EQUIVALENCE) {
      it("records", () => {
         writeFileSync(file, `${JSON.stringify(compute(), null, 1)}\n`);
      }, 300_000);
      return;
   }
   const recorded = JSON.parse(readFileSync(file, "utf8")) as Recorded;
   for (const name of [...Object.keys(logs), ...Object.keys(finalOnly)]) {
      it(`${name}: batches of 1, 7 and the whole log`, () => {
         const ev = (logs[name] ?? finalOnly[name]!)();
         const every = name in finalOnly ? Number.POSITIVE_INFINITY : 50;
         for (const b of sizes(ev.length))
            expect(fold(ev, b, every), `${name} batch ${key(b, ev.length)}`).toEqual(
               recorded.runs[name]![key(b, ev.length)],
            );
         if (recorded.finals[name])
            expect(stable(reduceBatch(initialState(), ev))).toEqual(recorded.finals[name]);
      }, 300_000);
   }
});
