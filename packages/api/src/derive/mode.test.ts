import { describe, expect, it } from "vitest";
import type { EventKind } from "../generated";
import { announcedMode, findModeOption, isModeOption, usageOf } from "./mode";

const cfg = (options: unknown, extra: object = {}) =>
   ({ type: "ConfigOptionsChanged", options, ...extra }) as EventKind;

describe("announcedMode", () => {
   it("takes the core's typed mode as is", () => {
      const mode = { id: "x", name: "X", plan: true };
      expect(announcedMode(cfg([], { mode }))).toEqual({ mode, legacy: false });
      expect(announcedMode({ type: "ModeChanged", mode_id: "x", mode })).toEqual({
         mode,
         legacy: false,
      });
   });

   it("old logs: finds the mode option by category or by id, like the core", () => {
      const opt = (o: object) =>
         [{ currentValue: "b", options: [{ value: "b", name: "B" }], ...o }] as unknown;
      for (const o of [{ category: "mode" }, { id: "mode" }])
         expect(announcedMode(cfg(opt(o)))).toEqual({
            mode: { id: "b", name: "B", plan: false },
            legacy: true,
         });
      expect(announcedMode(cfg(opt({ id: "model", category: "model" })))).toBeNull();
      expect(announcedMode(cfg(null))).toBeNull();
   });

   it("old logs: ModeChanged announces a mode, plan is flagged", () => {
      expect(announcedMode({ type: "ModeChanged", mode_id: "plan" })).toEqual({
         mode: { id: "plan", plan: true },
         legacy: true,
      });
      expect(announcedMode({ type: "ModeChanged", mode_id: "" })).toBeNull();
      expect(announcedMode({ type: "TurnStarted" } as unknown as EventKind)).toBeNull();
   });
});

describe("usageOf", () => {
   it("prefers the typed numbers, falls back to the raw update", () => {
      const u = (e: object) => usageOf({ type: "UsageUpdated", usage: null, ...e } as EventKind);
      expect(u({ used: 1, size: 2, usage: { used: 9, size: 9 } })).toEqual({ used: 1, size: 2 });
      expect(u({ usage: { used: 3, size: 4 } })).toEqual({ used: 3, size: 4 });
      expect(u({ usage: { used: 3 } })).toBeNull();
      expect(u({})).toBeNull();
   });
});

describe("findModeOption", () => {
   it("matches category or id like the core", () => {
      expect(isModeOption({ id: "x", category: "mode" })).toBe(true);
      expect(isModeOption({ id: "mode" })).toBe(true);
      expect(isModeOption({ id: "model", category: "model" })).toBe(false);
      expect(isModeOption(null)).toBe(false);
      const a = { id: "mode" };
      expect(findModeOption([{ id: "model" }, a])).toBe(a);
      expect(findModeOption([])).toBeUndefined();
   });
   it("an empty mode id is absent", () => {
      expect(
         announcedMode({ type: "ModeChanged", mode_id: "", mode: { id: "", plan: false } }),
      ).toBeNull();
      expect(announcedMode(cfg([{ id: "mode", currentValue: "" }]))).toBeNull();
   });
});
