import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Event } from "@harness/api";
import { describe, expect, it } from "vitest";
import { initialState, reduceBatch } from "./reducer";

// The same logs the Rust side parses (crates/harness-core/tests/golden.rs). A change that makes
// an old log reduce differently fails here; update the snapshot only when that is intended.
const dir = join(__dirname, "../../../crates/harness-core/tests/golden");
const logs = readdirSync(dir)
   .filter((f) => f.endsWith(".jsonl"))
   .sort();

describe("golden Session Logs", () => {
   it("has logs", () => {
      expect(logs.length).toBeGreaterThanOrEqual(2);
   });

   for (const name of logs) {
      it(`${name} reduces to the committed chat state`, () => {
         const events = readFileSync(join(dir, name), "utf8")
            .split("\n")
            .filter((l) => l.trim())
            .map((l) => JSON.parse(l) as Event);
         expect(events.some((e) => (e.kind.type as string) === "Unknown")).toBe(false);
         expect(reduceBatch(initialState(), events)).toMatchSnapshot();
      });
   }
});
