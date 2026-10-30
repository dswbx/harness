import { describe, expect, it } from "vitest";
import { applyStatePatch, getAt } from "./state";

describe("applyStatePatch (same rules as the core's state.rs)", () => {
  it("is lenient JSON Patch, all or nothing", () => {
    const doc = applyStatePatch({}, [
      { op: "add", path: "/quiz/score", value: 0 },
      { op: "add", path: "/quiz/answers", value: [] },
      { op: "add", path: "/quiz/answers/-", value: "B" },
      { op: "add", path: "/quiz/answers/0", value: "A" },
      { op: "replace", path: "/quiz/score", value: 1 },
      { op: "replace", path: "/a~1b", value: true },
    ]);
    expect(doc).toEqual({ quiz: { score: 1, answers: ["A", "B"] }, "a/b": true });
    const next = applyStatePatch(doc, [{ op: "remove", path: "/quiz/answers/0" }, { op: "remove", path: "/missing/x" }, { op: "test", path: "/quiz/score", value: 1 }]);
    expect(getAt(next, "/quiz/answers")).toEqual(["B"]);
    expect(() => applyStatePatch(next, [{ op: "replace", path: "/quiz/score", value: 5 }, { op: "test", path: "/quiz/score", value: 1 }])).toThrow("test failed");
    expect(getAt(next, "/quiz/score")).toBe(1);
    expect(() => applyStatePatch(next, [{ op: "add", path: "/quiz/score/x", value: 1 }])).toThrow();
    expect(() => applyStatePatch(next, [{ op: "replace", path: "/quiz/answers/3", value: 1 }])).toThrow();
  });
});
