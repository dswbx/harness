import { describe, expect, it } from "vitest";
import { applyStatePatch, type StatePatchOp } from "@harness/api";
import { isVisible, repeatScopes, resolveNode, resolveValue, runActions, stackClasses, tableRows } from "./RenderUi";
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

describe("render_ui Repeat (json-render's repeat scope)", () => {
  const state = { tickets: [{ id: "T-1", title: "Refund", priority: "high", done: false }, { id: "T-2", title: "Email", priority: "low", done: true }] };
  const repeat = { type: "Repeat" as const, props: { items: { $state: "/tickets" } }, children: [] };
  const scopes = repeatScopes(repeat, state);
  it("gives one scope per item, with the item's state path", () => {
    expect(scopes.map((s) => [s.index, s.path])).toEqual([[0, "/tickets/0"], [1, "/tickets/1"]]);
    expect(repeatScopes({ ...repeat, props: { items: { $state: "/missing" } } }, state)).toEqual([]);
    // Nested: an item field of the outer item.
    expect(repeatScopes({ ...repeat, props: { items: { $item: "tags" } } }, state, { item: { tags: ["a"] }, index: 3, path: "/x/3" })).toEqual([{ item: "a", index: 0, path: "/x/3/tags/0" }]);
  });
  it("reads item fields and the index in props and templates", () => {
    const s = scopes[1];
    expect(resolveValue({ $item: "title" }, state, s)).toBe("Email");
    expect(resolveValue({ $item: "" }, state, s)).toEqual(state.tickets[1]);
    expect(resolveValue({ $index: true }, state, s)).toBe(1);
    expect(resolveValue({ $template: "${id}: ${title} of ${/tickets/0/id}" }, state, s)).toBe("T-2: Email of T-1");
    expect(resolveValue({ $item: "title" }, state)).toBeUndefined();
    const n = resolveNode({ type: "Text", props: { text: { $item: "title" } } }, state, s);
    expect(n.props).toEqual({ text: "Email" });
  });
  it("binds $bindItem to the item's path", () => {
    const n = resolveNode({ type: "Checkbox", props: { label: "Done", value: { $bindItem: "done" } } }, state, scopes[0]);
    expect([n.props.value, n.bindings]).toEqual([false, { value: "/tickets/0/done" }]);
    // Outside a Repeat it binds nothing.
    expect(resolveNode({ type: "Checkbox", props: { label: "Done", value: { $bindItem: "done" } } }, state).bindings).toEqual({});
  });
  it("evaluates visible on item fields and the index", () => {
    expect(scopes.map((s) => isVisible({ $item: "priority", eq: "high" }, state, s))).toEqual([true, false]);
    expect(scopes.map((s) => isVisible({ $item: "done" }, state, s))).toEqual([false, true]);
    expect(scopes.map((s) => isVisible({ $index: true, neq: 0 }, state, s))).toEqual([false, true]);
  });
  it("runs actions on the item: $item paths and $index indexes", async () => {
    const patches: StatePatchOp[][] = [];
    await runActions(
      [
        { action: "setState", params: { statePath: { $item: "done" }, value: true } },
        { action: "removeState", params: { statePath: "/tickets", index: { $index: true } } },
      ],
      { state, patch: async (ops) => void patches.push(ops), send: async () => {} },
      scopes[1],
    );
    expect(patches).toEqual([[{ op: "replace", path: "/tickets/1/done", value: true }, { op: "remove", path: "/tickets/1" }]]);
  });
});

describe("render_ui Table and Stack", () => {
  const rows = [
    ["b", { text: "**9**", tone: "success" }],
    { cells: ["a", { text: "10", mono: true }], tone: "error" },
    ["c", "2"],
  ];
  it("filters and sorts on the cell text, keeping row tones", () => {
    expect(tableRows(rows, "", { col: 1, desc: false }).map((r) => r.cells[0])).toEqual(["c", "b", "a"]);
    expect(tableRows(rows, "", { col: 0, desc: true }).map((r) => [r.cells[0], r.tone])).toEqual([["c", undefined], ["b", undefined], ["a", "error"]]);
    expect(tableRows(rows, "10", null).map((r) => r.cells[0])).toEqual(["a"]);
  });
  it("keeps the old Stack layout by default", () => {
    const same = (a: string | null, b: string) => expect(a?.split(" ").sort()).toEqual(b.split(" ").sort());
    same(stackClasses({}, "Card").box, "flex min-w-0 flex-col gap-3");
    const row = stackClasses({ direction: "horizontal" }, "Card");
    same(row.box, "flex min-w-0 flex-row flex-wrap items-center gap-3");
    same(row.cell, "flex min-w-48 flex-1 basis-0 flex-col self-stretch [&>*]:flex-1");
    expect(stackClasses({ direction: "horizontal" }, "Badge").cell).toBeNull();
  });
  it("applies align, justify, wrap and fill", () => {
    const p = { direction: "horizontal", align: "start", justify: "between", wrap: false } as const;
    const { box, cell } = stackClasses(p, "Card");
    expect(box.split(" ")).toEqual(expect.arrayContaining(["items-start", "justify-between", "flex-nowrap"]));
    expect(cell?.split(" ")).toEqual(expect.arrayContaining(["min-w-0"]));
    expect(cell).not.toContain("self-stretch");
    expect(stackClasses({ ...p, fill: false }, "Card").cell).toBeNull();
    expect(stackClasses({ align: "center" }, "Card").box.split(" ")).toContain("items-center");
  });
  it("accepts old and new Table rows, and Repeat bindings, in the schema", () => {
    const ok = (root: unknown) => renderUiSchema.validate({ root }).valid;
    expect(ok({ type: "Table", props: { columns: ["A"], rows: [["x"], { cells: [{ text: "y", tone: "error" }], tone: "warning" }] } })).toBe(true);
    expect(ok({ type: "Table", props: { columns: ["A"], rows: [[{ tone: "error" }]] } })).toBe(false);
    expect(ok({ type: "Repeat", props: { items: { $state: "/t" } }, children: [{ type: "Checkbox", props: { label: { $item: "title" }, value: { $bindItem: "done" } }, visible: { $index: true, eq: 0 } }] })).toBe(true);
    expect(ok({ type: "Button", props: { label: "x" }, on: { press: { action: "removeState", params: { statePath: { $item: "" }, index: { $index: true } } } } })).toBe(true);
    expect(ok({ type: "Button", props: { label: "x" }, on: { press: { action: "setState", params: { statePath: { $index: true }, value: 1 } } } })).toBe(false);
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
