import type { PrInfo } from "@harness/api";
import { describe, expect, it } from "vitest";
import { watchingChecks } from "./checks";

const NOW = Date.parse("2026-06-01T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const pr = (o: Partial<PrInfo> = {}): PrInfo => ({
   repo: { owner: "o", name: "r" },
   number: 1,
   title: "t",
   author: "a",
   state: "open",
   checks: "passing",
   checks_passed: 3,
   checks_total: 3,
   additions: 0,
   deletions: 0,
   changed_files: 0,
   updated_at: ago(60 * 60_000),
   url: "",
   ...o,
});
const watching = (o: Partial<PrInfo>) => watchingChecks(pr(o), NOW);

describe("watchingChecks", () => {
   it("no PR: not watching", () => expect(watchingChecks(null, NOW)).toBe(false));

   it("an open or draft PR with pending checks", () => {
      expect(watching({ checks: "pending" })).toBe(true);
      expect(watching({ checks: "pending", state: "draft" })).toBe(true);
   });

   it("a finished PR is never watched, whatever its checks", () => {
      expect(watching({ checks: "pending", state: "merged" })).toBe(false);
      expect(watching({ checks: "pending", state: "closed" })).toBe(false);
      expect(
         watching({ checks: "none", checks_total: 0, state: "merged", updated_at: ago(1000) }),
      ).toBe(false);
   });

   it("passing or failing checks: not watching", () => {
      expect(watching({ checks: "passing" })).toBe(false);
      expect(watching({ checks: "failing" })).toBe(false);
   });

   it("no checks yet on a PR updated within 5 minutes: they may be about to start", () => {
      expect(watching({ checks: "none", checks_total: 0, updated_at: ago(60_000) })).toBe(true);
      expect(watching({ checks: "none", checks_total: 0, updated_at: ago(4 * 60_000) })).toBe(true);
   });

   it("no checks and not updated for 5 minutes or more: not watching", () => {
      expect(watching({ checks: "none", checks_total: 0, updated_at: ago(5 * 60_000) })).toBe(
         false,
      );
      expect(watching({ checks: "none", checks_total: 0, updated_at: ago(60 * 60_000) })).toBe(
         false,
      );
   });

   it("a PR with checks that are not pending does not use the recency rule", () => {
      expect(watching({ checks: "passing", checks_total: 2, updated_at: ago(1000) })).toBe(false);
   });

   it("uses the current time by default", () => {
      expect(
         watchingChecks(
            pr({ checks: "none", checks_total: 0, updated_at: new Date().toISOString() }),
         ),
      ).toBe(true);
   });
});
