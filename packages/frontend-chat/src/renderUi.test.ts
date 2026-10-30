import { describe, expect, it } from "vitest";
import { applyStatePatch, type StatePatchOp } from "@harness/api";
import { isVisible, resolveNode, resolveValue, runActions } from "./RenderUi";
import { calculatorExample, components, renderUiSchema } from "./tools";
import { loadJs, runJs } from "./sandbox";

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
  it("evaluates json-render visibility conditions", () => {
    expect(isVisible(undefined, state)).toBe(true);
    expect(isVisible({ $state: "/quiz/answers/q1" }, state)).toBe(true);
    expect(isVisible({ $state: "/quiz/answers/q9" }, state)).toBe(false);
    expect(isVisible({ $state: "/quiz/answers/q9", not: true }, state)).toBe(true);
    expect(isVisible({ $state: "/quiz/answers/q2", eq: "b" }, state)).toBe(true);
    expect(isVisible({ $state: "/quiz/answers/q2", neq: "b" }, state)).toBe(false);
    expect(isVisible({ $and: [{ $state: "/quiz/results/q1" }, { $state: "/quiz/results/q2" }] }, state)).toBe(false);
    expect(isVisible({ $or: [{ $state: "/quiz/results/q1" }, { $state: "/quiz/results/q2" }] }, state)).toBe(true);
    expect(isVisible({ $state: "/quiz/points" }, state)).toBe(true);
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
      { op: "replace", path: "/a", value: "a" },
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

describe("render_ui JavaScript (sandboxed)", () => {
  it("evaluates $js against the state, without host globals or endless loops", async () => {
    await loadJs();
    expect(resolveValue({ $js: "state.a * 2" }, { a: 21 })).toBe(42);
    expect(resolveValue({ $js: "const x = state.a; return { x };" }, { a: 1 })).toEqual({ x: 1 });
    expect(runJs("typeof fetch + typeof window + typeof setTimeout", {})).toEqual({ value: "undefinedundefinedundefined" });
    expect(runJs("(() => { while (true) {} })()", {})).toMatchObject({ error: expect.stringContaining("interrupted") });
    expect(runJs("nope(", {})).toMatchObject({ error: expect.stringContaining("SyntaxError") });
  });
  it("runs a calculator: each press builds on the last, = evaluates", async () => {
    let state: unknown = { calc: { expr: "" } };
    const patch = async (ops: StatePatchOp[]) => void (state = applyStatePatch(state, ops));
    const keys = Object.fromEntries(calculatorExample().children[1].children!.map((k) => [k.props.label, k.on.press]));
    const press = (...ls: string[]) => Promise.all(ls.map(async (l) => runActions(keys[l], { state, patch, send: async () => {} })));
    for (const l of ["1", "2", "+", "3", "×", "4", "="]) await press(l);
    expect(state).toEqual({ calc: { expr: "24" } });
    for (const l of ["⌫", "%"]) await press(l);
    expect(state).toEqual({ calc: { expr: "0.02" } });
    for (const l of ["AC", "÷", "="]) await press(l);
    expect(state).toEqual({ calc: { expr: "Error" } });
  });
  it("a failing js action changes nothing and reports", async () => {
    const patches: StatePatchOp[][] = [];
    const errors: string[] = [];
    await runActions(
      [{ action: "setState", params: { statePath: "/a", value: 1 } }, { action: "js", params: { statePath: "/b", code: "state.x.y" } }],
      { state: {}, patch: async (ops) => void patches.push(ops), send: async () => {}, onError: (m) => void errors.push(m) },
    );
    expect(patches).toEqual([]);
    expect(errors[0]).toContain("TypeError");
  });
});
