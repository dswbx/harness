import { describe, expect, it } from "vitest";
import {
   defaultApproveOption,
   keepPlanningOption,
   modeName,
   planStats,
   planSteps,
   planTitle,
} from "./plans";
import type { ConfigOption } from "./reducer";

describe("planTitle", () => {
   it("takes the first heading", () => {
      expect(planTitle("intro\n\n## Refactor auth ##\n\n# Later")).toBe("Refactor auth");
      expect(planTitle("no heading")).toBeNull();
   });
});

describe("planSteps", () => {
   it("counts top-level items under a Steps heading", () => {
      const md =
         "# Plan\n\n## Context\n\n- a\n- b\n\n## Implementation steps\n\n1. one\n   - nested\n2. two\n### Detail\n3. three\n\n## Verify\n\n- x";
      expect(planSteps(md)).toBe(3);
   });
   it("falls back to all top-level items, and skips code fences", () => {
      expect(planSteps("# P\n\n- a\n- b\n\n```\n- not a step\n```\n1. c")).toBe(3);
      expect(planSteps("# P\n\njust text")).toBeNull();
   });
});

describe("planStats", () => {
   it("counts added and removed lines", () => {
      expect(planStats("a\nb\nc", "a\nB\nc\nd")).toEqual({ add: 2, del: 1 });
   });
});

describe("options", () => {
   const o = (option_id: string, kind: string, plan_mode?: string, clears_context = false) => ({
      option_id,
      name: option_id,
      kind,
      plan_mode,
      clears_context,
   });
   const claude = [
      o("clear-auto", "allow_always", "auto", true),
      o("auto", "allow_always", "auto"),
      o("bypass", "allow_always", "bypassPermissions"),
      o("manual", "allow_once", "default"),
      o("keep", "reject_once"),
   ];
   it("defaults to the mode before Plan, without clearing context", () => {
      expect(defaultApproveOption(claude, "auto")?.option_id).toBe("auto");
      expect(defaultApproveOption(claude, "bypassPermissions")?.option_id).toBe("bypass");
   });
   it("falls back to the first allow_once, then the first allow", () => {
      expect(defaultApproveOption(claude, "acceptEdits")?.option_id).toBe("manual");
      expect(defaultApproveOption(claude, null)?.option_id).toBe("manual");
      expect(defaultApproveOption([o("x", "allow_always")], null)?.option_id).toBe("x");
      expect(defaultApproveOption([o("keep", "reject_once")], null)).toBeNull();
   });
   it("Keep planning is the reject option", () => {
      expect(keepPlanningOption(claude)?.option_id).toBe("keep");
   });
});

describe("modeName", () => {
   const opts: ConfigOption[] = [
      {
         id: "mode",
         name: "Mode",
         category: "mode",
         type: "select",
         currentValue: "plan",
         options: [{ value: "acceptEdits", name: "Accept Edits" }],
      },
   ];
   it("names a mode value, else returns the value", () => {
      expect(modeName(opts, "acceptEdits")).toBe("Accept Edits");
      expect(modeName(opts, "auto")).toBe("auto");
      expect(modeName(opts, null)).toBeNull();
   });
});
