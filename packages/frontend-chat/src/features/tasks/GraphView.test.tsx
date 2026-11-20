import type { TaskDepKind, TaskSummary } from "@harness/api";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GraphView, parseGraphLines } from "./GraphView";
import { parseViewMode } from "./TasksView";

// The Lines choice is a stored value: give it a storage.
const mem = new Map<string, string>();
beforeEach(() => {
   mem.clear();
   vi.stubGlobal("localStorage", {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, String(v)),
      removeItem: (k: string) => void mem.delete(k),
      clear: () => mem.clear(),
   });
});
afterEach(() => {
   cleanup();
   vi.unstubAllGlobals();
});

const task = (
   id: string,
   deps: [string, TaskDepKind][] = [],
   o: Partial<TaskSummary> = {},
): TaskSummary => ({
   id,
   title: `Task ${id}`,
   has_body: false,
   excerpt: "",
   status: "todo",
   priority: "none",
   due: null,
   upstream: null,
   parent_id: null,
   order: 1,
   origin_session_id: null,
   origin_title: null,
   sessions: [],
   assets: [],
   created_ms: 0,
   updated_ms: 0,
   deps: deps.map(([d, kind]) => ({ id: d, kind })),
   props: {},
   ...o,
});

// a -> b -> c (blocks), b ~> d (follow-up); e is on its own; x -> e.
const TASKS = [
   task("a", [], { excerpt: "Start here." }),
   task("b", [["a", "blocks"]]),
   task("c", [["b", "blocks"]]),
   task("d", [["b", "follow_up"]]),
   task("e"),
   task("x", [["e", "blocks"]], { parent_id: "a" }),
];

function setup(o: Partial<Parameters<typeof GraphView>[0]> = {}) {
   const onOpen = vi.fn();
   const view = render(
      <GraphView
         tasks={TASKS}
         all={TASKS}
         groupBy={null}
         density="condensed"
         today="2026-01-10"
         onOpen={onOpen}
         {...o}
      />,
   );
   return { onOpen, ...view };
}

const card = (id: string) => {
   const el = document.querySelector<HTMLElement>(`[data-graph-card="${id}"]`);
   if (!el) throw new Error(`no card ${id}`);
   return el;
};
const line = (key: string) => {
   const el = document.querySelector<SVGPathElement>(`[data-line="${key}"]`);
   if (!el) throw new Error(`no line ${key}`);
   return el;
};
const lines = () =>
   [...document.querySelectorAll<SVGPathElement>("[data-line]")].map((l) => l.dataset.line).sort();

describe("GraphView", () => {
   it("shows a card per task and a line per dep, follow-ups dashed", () => {
      const { onOpen } = setup();
      expect(document.querySelectorAll("[data-graph-card]")).toHaveLength(6);
      expect(lines()).toEqual(["a>b", "b>c", "b>d", "e>x"]);
      expect(line("b>c").getAttribute("stroke-dasharray")).toBeNull();
      expect(line("b>d").getAttribute("stroke-dasharray")).toBe("4 3");
      expect(line("a>b").getAttribute("marker-end")).toMatch(/^url\(#graph.*-gray\)$/);
      // "waits on N" counts open blockers; condensed cards have no excerpt.
      expect(card("b").textContent).toContain("waits on 1");
      expect(card("a").textContent).not.toContain("Start here.");
      fireEvent.click(card("c").querySelector("button")!);
      expect(onOpen).toHaveBeenCalledWith("c");
   });

   it("detail cards show the excerpt; lanes have headings with their counts", () => {
      setup({
         density: "detail",
         groupBy: {
            laneOf: (t) => (t.id === "e" || t.id === "x" ? "side" : null),
            missing: "Rest",
         },
      });
      expect(card("a").textContent).toContain("Start here.");
      const text = document.querySelector("[data-graph-box]")!.textContent;
      expect(text).toContain("side· 2");
      expect(text).toContain("Rest· 4");
   });

   it("selection: its direct lines light up, its chain stays, the rest fades", () => {
      setup({ selected: "b" });
      expect(line("a>b").dataset.lit).toBe("true");
      expect(line("b>c").dataset.lit).toBe("true");
      expect(line("b>d").dataset.lit).toBe("true");
      expect(line("e>x").dataset.lit).toBeUndefined();
      expect(line("e>x").dataset.faded).toBe("true");
      expect(line("a>b").getAttribute("marker-end")).toMatch(/-gray-lit\)$/);
      expect(line("a>b").getAttribute("class")).toContain("text-foreground");
      for (const id of ["a", "b", "c", "d"]) expect(card(id).dataset.faded).toBeUndefined();
      expect(card("e").dataset.faded).toBe("true");
      expect(card("x").dataset.faded).toBe("true");
      expect(card("b").getAttribute("aria-current")).toBe("true");
   });

   it("the chain goes through several tasks; a line inside it that is not direct stays, not lit", () => {
      setup({ selected: "c" });
      expect(line("b>c").dataset.lit).toBe("true");
      expect(line("a>b").dataset.lit).toBeUndefined();
      expect(line("a>b").dataset.faded).toBeUndefined();
      // `d` follows `b` but is not in `c`'s chain.
      expect(card("d").dataset.faded).toBe("true");
      expect(line("b>d").dataset.faded).toBe("true");
   });

   it("a line has its source task's status color: muted at rest, full and thicker lit, gray for todo", () => {
      const ext = task("ext", [], { status: "done", origin_session_id: "s9" });
      const tasks = [
         task("r", [], { status: "in_review" }),
         task("p", [], { status: "in_progress" }),
         task("k", [["r", "blocks"]], { status: "blocked" }),
         task("q", [
            ["p", "follow_up"],
            ["k", "blocks"],
            ["ext", "blocks"],
         ]),
         task("z", [["q", "blocks"]]),
      ];
      setup({ tasks, all: [...tasks, ext], outside: [ext], selected: "k" });
      const tone = (key: string) => line(key).dataset.tone;
      expect(["r>k", "p>q", "k>q", "ext>q", "q>z"].map(tone)).toEqual([
         "in_review",
         "in_progress",
         "blocked",
         "done",
         "gray",
      ]);
      // k is selected: its lines are lit, in full color and thicker; the others rest, muted.
      const lit = line("r>k");
      expect(lit.dataset.lit).toBe("true");
      expect(lit.getAttribute("class")).toContain("text-violet-500");
      expect(lit.getAttribute("stroke")).toBe("currentColor");
      expect(lit.getAttribute("stroke-width")).toBe("2");
      expect(lit.getAttribute("marker-end")).toMatch(/-in_review-lit\)$/);
      const rest = line("p>q");
      expect(rest.dataset.lit).toBeUndefined();
      expect(rest.getAttribute("class")).toContain("text-sky-500");
      expect(rest.getAttribute("stroke-width")).toBe("1");
      expect(rest.getAttribute("marker-end")).toMatch(/-in_progress\)$/);
      // Outside k's chain: faded.
      expect(rest.dataset.faded).toBe("true");
      expect(rest.getAttribute("class")).toContain("opacity-25");
      expect(line("q>z").getAttribute("class")).toContain("text-muted-foreground/70");
      // A marker for each tone, rest and lit, colored like its line.
      const m = document.querySelector(`marker[id$="-done-lit"]`);
      expect(m?.getAttribute("class")).toContain("text-emerald-500");
   });

   it("hover lights a card's lines without fading the others", () => {
      setup();
      fireEvent.pointerEnter(card("e"));
      expect(line("e>x").dataset.lit).toBe("true");
      expect(line("a>b").dataset.lit).toBeUndefined();
      expect(document.querySelectorAll("[data-faded]")).toHaveLength(0);
      fireEvent.pointerLeave(card("e"));
      expect(line("e>x").dataset.lit).toBeUndefined();
   });

   it("the Lines choice hides kinds of lines and adds parent lines", () => {
      mem.set("harness.tasks.graphLines", JSON.stringify({ followUps: false, parents: true }));
      setup();
      expect(lines()).toEqual(["a>b", "a>x", "b>c", "e>x"]);
      expect(line("a>x").dataset.kind).toBe("parent");
   });

   it("outside cards are dashed and open through their own handler", () => {
      const ext = task("ext", [], {
         title: "Elsewhere",
         origin_session_id: "s9",
         origin_title: "Other",
      });
      const tasks = [...TASKS, task("w", [["ext", "blocks"]])];
      const onOpenOutside = vi.fn();
      const { onOpen } = setup({ tasks, all: [...tasks, ext], outside: [ext], onOpenOutside });
      const el = card("ext");
      expect(el.dataset.outside).toBe("true");
      expect(el.className).toContain("border-dashed");
      expect(el.textContent).toContain("Other session");
      expect(lines()).toContain("ext>w");
      fireEvent.click(el.querySelector("button")!);
      expect(onOpenOutside).toHaveBeenCalledWith("ext");
      expect(onOpen).not.toHaveBeenCalled();
   });

   it("lays out for the measured width, in flow below the ranks' width and aligned above", () => {
      let report: (() => void) | null = null;
      let width = 1440;
      vi.stubGlobal(
         "ResizeObserver",
         class {
            constructor(cb: () => void) {
               report = cb;
            }
            observe() {}
            disconnect() {}
         },
      );
      // Runs the frame at once (and gives no frame id, so the next change asks for a new frame).
      vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => {
         f(0);
         return 0;
      });
      const spy = vi
         .spyOn(HTMLElement.prototype, "clientWidth", "get")
         .mockImplementation(() => width);
      setup();
      const box = () => document.querySelector<HTMLElement>("[data-graph-box]")!;
      expect(box().dataset.mode).toBe("aligned");
      expect(box().style.width).toBe("1440px");
      width = 445;
      act(() => report?.());
      expect(box().dataset.mode).toBe("flow");
      // Rounded down to 8 px.
      expect(box().style.width).toBe("440px");
      width = 300;
      act(() => report?.());
      expect(box().style.width).toBe("424px");
      spy.mockRestore();
   });

   it("shows `empty` without tasks", () => {
      const { getByText } = setup({ tasks: [], empty: <p>Nothing here</p> });
      expect(getByText("Nothing here")).toBeTruthy();
      expect(document.querySelector("[data-graph-box]")).toBeNull();
   });
});

describe("stored values", () => {
   it("view mode: list, tree or graph; anything else is the list", () => {
      expect(parseViewMode("graph")).toBe("graph");
      expect(parseViewMode("tree")).toBe("tree");
      expect(parseViewMode("list")).toBe("list");
      expect(parseViewMode(null)).toBe("list");
      expect(parseViewMode("board")).toBe("list");
   });

   it("lines: missing or broken fields are their defaults", () => {
      const def = { blocks: true, followUps: true, parents: false };
      expect(parseGraphLines(null)).toEqual(def);
      expect(parseGraphLines("not json")).toEqual(def);
      expect(parseGraphLines("[1]")).toEqual(def);
      expect(parseGraphLines('{"parents":true,"blocks":"no"}')).toEqual({ ...def, parents: true });
      expect(parseGraphLines('{"blocks":false,"followUps":false,"parents":true}')).toEqual({
         blocks: false,
         followUps: false,
         parents: true,
      });
   });
});
