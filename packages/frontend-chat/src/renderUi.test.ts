import { describe, expect, it } from "vitest";
import type { StatePatchOp } from "@harness/api";
import { resolveNode, resolveValue, runActions } from "./RenderUi";
import { components, renderUiSchema } from "./tools";

describe("render_ui binding", () => {
  const state = { quiz: { answers: { q1: "a", q2: "b" }, results: { q1: true, q2: false, q3: true }, points: [1, 2, "3"] } };
  it("resolves $state, $template and $computed", () => {
    expect(resolveValue({ $state: "/quiz/answers/q1" }, state)).toBe("a");
    expect(resolveValue({ $template: "Q1: ${/quiz/answers/q1}, Q9: ${/quiz/answers/q9}" }, state)).toBe("Q1: a, Q9: ");
    expect(resolveValue({ $computed: "count", args: { values: { $state: "/quiz/results" }, eq: true } }, state)).toBe(2);
    expect(resolveValue({ $computed: "count", args: { values: { $state: "/quiz/results" }, eq: false } }, state)).toBe(1);
    expect(resolveValue({ $computed: "length", args: { values: { $state: "/quiz/answers" } } }, state)).toBe(2);
    expect(resolveValue({ $computed: "sum", args: { values: { $state: "/quiz/points" } } }, state)).toBe(6);
    expect(resolveValue({ $computed: "length", args: { values: { $state: "/missing" } } }, state)).toBe(0);
  });
  it("binds $bindState props to their path", () => {
    const n = resolveNode({ type: "Choice", props: { value: { $bindState: "/quiz/answers/q2" }, options: [] } }, state);
    expect([n.props.value, n.bindings]).toEqual(["b", { value: "/quiz/answers/q2" }]);
  });
  it("runs state actions as one patch, then messages", async () => {
    const patches: StatePatchOp[][] = [];
    const sent: string[] = [];
    await runActions(
      [
        { action: "setState", params: { statePath: "/a", value: { $state: "/quiz/answers/q1" } } },
        { action: "pushState", params: { statePath: "/log", value: 1 } },
        { action: "removeState", params: { statePath: "/quiz/answers", index: 0 } },
        { action: "sendMessage", params: { text: { $template: "Answer: ${/quiz/answers/q1}" } } },
      ],
      { state, patch: async (ops) => void patches.push(ops), send: async (t) => void sent.push(t) },
    );
    expect(patches).toEqual([[
      { op: "add", path: "/a", value: "a" },
      { op: "add", path: "/log", value: [] },
      { op: "add", path: "/log/-", value: 1 },
      { op: "remove", path: "/quiz/answers/0" },
    ]]);
    expect(sent).toEqual(["Answer: a"]);
  });
  it("every gallery example is valid render_ui input", () => {
    for (const [name, c] of Object.entries(components)) {
      expect(renderUiSchema.validate({ root: c.example.node }).valid, name).toBe(true);
    }
  });
});
