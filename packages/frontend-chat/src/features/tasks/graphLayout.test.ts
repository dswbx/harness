import { describe, expect, it } from "vitest";
import {
   CARD_MAX,
   type GraphDepKind,
   type GraphLayout,
   type GraphOptions,
   type GraphPoint,
   type GraphTask,
   graphColumns,
   graphRanks,
   LANE_HEAD,
   layoutGraph,
   MIN_WIDTH,
   PAD,
   TRACK,
} from "./graphLayout";

const t = (
   id: string,
   deps: (string | [string, GraphDepKind])[] = [],
   props: Record<string, string> = {},
   order = 1,
): GraphTask => ({
   id,
   order,
   deps: deps.map((d) =>
      typeof d === "string" ? { id: d, kind: "blocks" } : { id: d[0], kind: d[1] },
   ),
   props,
});

// Four ranks (0..3) in three components, plus two tasks without one.
const TASKS = [
   t("plan", [], { component: "core" }),
   t("schema", ["plan"], { component: "core" }),
   t("api", ["schema"], { component: "server" }),
   t("ui", ["api", ["schema", "follow_up"]], { component: "client" }),
   t("docs", [["plan", "follow_up"]], { component: "client" }),
   t("tests", ["schema", "api"], { component: "server" }),
   t("spike"),
   t("ghost", ["nowhere"]),
];

const opts = (o: Partial<GraphOptions<GraphTask>> = {}): GraphOptions<GraphTask> => ({
   width: 1440,
   groupBy: "component",
   density: "condensed",
   ...o,
});

/** A bigger graph: each task depends on up to 2 earlier ones; made-up ids and areas. */
function bigGraph(n: number, seed: number): GraphTask[] {
   let s = seed;
   const rnd = () => {
      s = (s * 1103515245 + 12345) % 2147483648;
      return s / 2147483648;
   };
   const areas = ["alpha", "beta", "gamma", ""];
   return Array.from({ length: n }, (_, i) => {
      const deps: [string, GraphDepKind][] = [];
      for (let k = 0; k < 2; k++)
         if (i > 0 && rnd() < 0.6)
            deps.push([`n${Math.floor(rnd() * i)}`, rnd() < 0.3 ? "follow_up" : "blocks"]);
      const area = areas[Math.floor(rnd() * areas.length)]!;
      return t(`n${i}`, deps, area ? { area } : {}, Math.floor(rnd() * 5));
   });
}

const EPS = 1e-6;
type Seg = [GraphPoint, GraphPoint];
const segs = (p: GraphPoint[]): Seg[] => p.slice(1).map((b, i) => [p[i]!, b]);
const vertical = ([a, b]: Seg) => Math.abs(a.x - b.x) < EPS;
const overlap = (a1: number, a2: number, b1: number, b2: number) =>
   Math.min(Math.max(a1, a2), Math.max(b1, b2)) - Math.max(Math.min(a1, a2), Math.min(b1, b2));

/** The checks every layout must pass; returns what fails (one `expect` per layout keeps the test fast). */
function problems(l: GraphLayout): string[] {
   const bad: string[] = [];
   const { cardWidth: w, cardHeight: h } = l;
   const byId = new Map(l.cards.map((c) => [c.id, c]));
   if (byId.size !== l.cards.length) bad.push("duplicate card");
   // Cards in the box, without overlap.
   for (const [i, a] of l.cards.entries()) {
      if (a.x < -EPS || a.y < -EPS || a.x + w > l.width + EPS || a.y + h > l.height + EPS)
         bad.push(`${a.id} outside the box`);
      for (const b of l.cards.slice(i + 1))
         if (overlap(a.x, a.x + w, b.x, b.x + w) > EPS && overlap(a.y, a.y + h, b.y, b.y + h) > EPS)
            bad.push(`${a.id} overlaps ${b.id}`);
   }
   for (const line of l.lines) {
      const name = `${line.from}->${line.to}`;
      const from = byId.get(line.from)!;
      const to = byId.get(line.to)!;
      const first = line.points[0]!;
      const last = line.points[line.points.length - 1]!;
      // Out of the right side of `from`, into the left side of `to`.
      if (Math.abs(first.x - (from.x + w)) > EPS || first.y <= from.y || first.y >= from.y + h)
         bad.push(`${name} does not start on the right side`);
      if (Math.abs(last.x - to.x) > EPS || last.y <= to.y || last.y >= to.y + h)
         bad.push(`${name} does not end on the left side`);
      // Lines in the outer gaps keep PAD from the edge.
      for (const p of line.points)
         if (
            p.x < PAD - EPS ||
            p.x > l.width - PAD + EPS ||
            p.y < PAD - EPS ||
            p.y > l.height - PAD + EPS
         )
            bad.push(`${name} too near the edge`);
      for (const s of segs(line.points)) {
         if (!vertical(s) && Math.abs(s[0].y - s[1].y) > EPS) bad.push(`${name} not orthogonal`);
         // Never inside a card (touching its own cards' sides is fine).
         for (const c of l.cards)
            if (
               Math.max(s[0].x, s[1].x) > c.x + EPS &&
               Math.min(s[0].x, s[1].x) < c.x + w - EPS &&
               Math.max(s[0].y, s[1].y) > c.y + EPS &&
               Math.min(s[0].y, s[1].y) < c.y + h - EPS
            )
               bad.push(`${name} crosses ${c.id}`);
      }
   }
   // No two lines on one track: parallel segments of two lines never overlap, and vertical tracks are apart.
   for (const [i, a] of l.lines.entries())
      for (const b of l.lines.slice(i + 1))
         for (const p of segs(a.points))
            for (const q of segs(b.points)) {
               const name = `${a.from}->${a.to} / ${b.from}->${b.to}`;
               if (vertical(p) && vertical(q)) {
                  if (
                     overlap(p[0].y, p[1].y, q[0].y, q[1].y) > EPS &&
                     Math.abs(p[0].x - q[0].x) < TRACK - EPS
                  )
                     bad.push(`${name} share a vertical track`);
               } else if (
                  !vertical(p) &&
                  !vertical(q) &&
                  Math.abs(p[0].y - q[0].y) < EPS &&
                  overlap(p[0].x, p[1].x, q[0].x, q[1].x) > EPS
               )
                  bad.push(`${name} share a horizontal track`);
            }
   return bad;
}

describe("graphRanks", () => {
   it("is the longest dep path, both kinds, dropping unknown ids", () => {
      expect(Object.fromEntries(graphRanks(TASKS))).toEqual({
         plan: 0,
         schema: 1,
         api: 2,
         ui: 3,
         docs: 1,
         tests: 3,
         spike: 0,
         ghost: 0,
      });
   });

   it("cuts a loop instead of hanging", () => {
      const r = graphRanks([t("a", ["b"]), t("b", ["a"])]);
      expect(r.size).toBe(2);
   });
});

describe("graphColumns", () => {
   it("fits cards of at least CARD_MIN, 2 at least", () => {
      expect(graphColumns(300)).toBe(2);
      expect(graphColumns(424)).toBe(2);
      expect(graphColumns(440)).toBe(2);
      expect(graphColumns(660)).toBe(3);
      expect(graphColumns(1440)).toBe(6);
   });
});

describe("layoutGraph", () => {
   it("sorts lanes by lowest rank, then name; no key last", () => {
      const l = layoutGraph(TASKS, opts());
      expect(l.lanes.map((x) => [x.key, x.label])).toEqual([
         ["core", "core"],
         ["client", "client"],
         ["server", "server"],
         [null, "No component"],
      ]);
      const tie = layoutGraph([t("x", [], { area: "beta" }), t("y", [], { area: "alpha" })], {
         ...opts(),
         groupBy: "area",
      });
      expect(tie.lanes.map((x) => x.label)).toEqual(["alpha", "beta"]);
      for (const lane of l.lanes) expect(lane.head).toBe(LANE_HEAD);
   });

   it("groups by a lane function with its labels, or not at all", () => {
      const byFirst = layoutGraph(TASKS, {
         ...opts(),
         groupBy: {
            laneOf: (x) => (x.id.startsWith("s") ? "s" : null),
            label: (k) => `Starts with ${k}`,
            missing: "Others",
         },
      });
      expect(byFirst.lanes.map((x) => x.label)).toEqual(["Starts with s", "Others"]);
      const none = layoutGraph(TASKS, opts({ groupBy: null }));
      expect(none.lanes.map((x) => [x.key, x.label, x.head])).toEqual([[null, "", 0]]);
      expect(none.cards.every((c) => c.lane === 0)).toBe(true);
   });

   it("picks the mode from the width", () => {
      const mode = (width: number) => layoutGraph(TASKS, opts({ width })).mode;
      expect([424, 440, 660, 1440].map(mode)).toEqual(["flow", "flow", "flow", "aligned"]);
      // Three ranks fit 3 columns.
      const three = TASKS.filter((x) => x.id !== "ui" && x.id !== "tests");
      expect(layoutGraph(three, opts({ width: 660 })).mode).toBe("aligned");
   });

   it("aligned: a column per rank, extra width on both sides", () => {
      const l = layoutGraph(TASKS, opts({ width: 1440 }));
      expect(l.cardWidth).toBeLessThanOrEqual(CARD_MAX);
      const byId = new Map(l.cards.map((c) => [c.id, c]));
      const xs = new Map<number, number>();
      for (const c of l.cards) {
         if (!xs.has(c.rank)) xs.set(c.rank, c.x);
         expect(c.x).toBe(xs.get(c.rank));
      }
      const left = Math.min(...l.cards.map((c) => c.x));
      const right = Math.max(...l.cards.map((c) => c.x + l.cardWidth));
      expect(left).toBeCloseTo(l.width - right);
      // Each card in its lane band.
      for (const c of l.cards) {
         const lane = l.lanes[c.lane]!;
         expect(c.y).toBeGreaterThanOrEqual(lane.y + lane.head);
         expect(c.y + l.cardHeight).toBeLessThanOrEqual(lane.y + lane.h);
      }
      // Lines run left to right.
      for (const line of l.lines)
         expect(byId.get(line.to)!.x).toBeGreaterThan(byId.get(line.from)!.x);
   });

   it("flow: lanes are sections, tasks by rank fill rows of `cols` cards", () => {
      const l = layoutGraph(TASKS, opts({ width: 440 }));
      expect(l.cols).toBe(2);
      for (const [L, lane] of l.lanes.entries()) {
         const cards = l.cards.filter((c) => c.lane === L);
         // Reading order (rows, then left to right) follows the rank.
         const ranks = cards.map((c) => c.rank);
         expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
         const rows = new Map<number, number>();
         for (const c of cards) rows.set(c.y, (rows.get(c.y) ?? 0) + 1);
         for (const n of rows.values()) expect(n).toBeLessThanOrEqual(l.cols);
         for (const c of cards) expect(c.y).toBeGreaterThanOrEqual(lane.y + lane.head);
      }
      // Sections one under the other.
      for (const [i, lane] of l.lanes.slice(1).entries())
         expect(lane.y).toBeGreaterThan(l.lanes[i]!.y + l.lanes[i]!.h);
   });

   it("card height follows the density", () => {
      expect(layoutGraph(TASKS, opts({ density: "condensed" })).cardHeight).toBe(48);
      expect(layoutGraph(TASKS, opts({ density: "detail" })).cardHeight).toBe(64);
   });

   it("lines go from the task waited on to the task that waits", () => {
      const l = layoutGraph(TASKS, opts());
      expect(l.lines.map((x) => `${x.from}->${x.to}:${x.kind}`).sort()).toEqual(
         [
            "plan->schema:blocks",
            "schema->api:blocks",
            "api->ui:blocks",
            "schema->ui:follow_up",
            "plan->docs:follow_up",
            "schema->tests:blocks",
            "api->tests:blocks",
         ].sort(),
      );
      for (const line of l.lines) expect(line.path.startsWith("M")).toBe(true);
   });

   it("orders a lane by barycenter, so these lines stay straight", () => {
      // c waits on b, d on a; by order alone c would sit above d and the lines would cross.
      const tasks = [
         t("a", [], {}, 1),
         t("b", [], {}, 2),
         t("c", ["b"], {}, 1),
         t("d", ["a"], {}, 2),
      ];
      const l = layoutGraph(tasks, opts({ groupBy: null }));
      expect(l.mode).toBe("aligned");
      for (const line of l.lines) expect(line.points).toHaveLength(2);
      const y = (id: string) => l.cards.find((c) => c.id === id)!.y;
      expect(y("d")).toBe(y("a"));
      expect(y("c")).toBe(y("b"));
   });

   it("ties in a lane go by order, then id", () => {
      const tasks = [t("b", [], {}, 1), t("a", [], {}, 1), t("z", [], {}, 0)];
      const l = layoutGraph(tasks, opts({ groupBy: null }));
      expect(l.cards.map((c) => c.id)).toEqual(["z", "a", "b"]);
   });

   it("places outside blockers just before the task that waits, in its lane", () => {
      const tasks = [...TASKS, t("wait", ["ext"], { component: "core" })];
      const outside = [t("ext", [], { component: "elsewhere" }), t("unused")];
      for (const width of [440, 1440]) {
         const l = layoutGraph(tasks, opts({ width, outside }));
         const byId = new Map(l.cards.map((c) => [c.id, c]));
         const ext = byId.get("ext")!;
         const wait = byId.get("wait")!;
         expect(ext.outside).toBe(true);
         expect(wait.outside).toBeUndefined();
         expect(byId.has("unused")).toBe(false);
         expect(ext.lane).toBe(wait.lane);
         expect(ext.rank).toBe(wait.rank - 1);
         expect(ext.y < wait.y || (ext.y === wait.y && ext.x < wait.x)).toBe(true);
         expect(l.lines.some((x) => x.from === "ext" && x.to === "wait")).toBe(true);
         // The outside card does not change the lanes or the shown ranks.
         expect(l.lanes.map((x) => x.label)).toEqual(["core", "client", "server", "No component"]);
         expect(byId.get("wait")!.rank).toBe(0);
         expect(problems(l)).toEqual([]);
      }
      // A blocker of a rank 0 task adds a column on the left.
      expect(layoutGraph(tasks, opts({ width: 1440, outside })).mode).toBe("aligned");
      expect(layoutGraph(tasks, opts({ width: 824, outside })).mode).toBe("flow");
   });

   it("no line crosses a card, and no two lines share a track", () => {
      const sets = [TASKS, bigGraph(40, 7), bigGraph(60, 42), bigGraph(25, 3)];
      for (const tasks of sets)
         for (const width of [300, 424, 440, 660, 900, 1440])
            for (const groupBy of [null, "component", "area"])
               for (const density of ["condensed", "detail"] as const) {
                  const outside = [t("n3"), t("nowhere")];
                  expect(
                     problems(layoutGraph(tasks, { width, groupBy, density, outside })),
                  ).toEqual([]);
               }
   });

   it("parent lines: routed like deps, without changing ranks or order", () => {
      const parents: Record<string, string> = {
         schema: "plan",
         tests: "api",
         ui: "docs",
         spike: "ui",
      };
      const parentOf = (x: GraphTask) => parents[x.id] ?? null;
      for (const width of [440, 1440]) {
         const plain = layoutGraph(TASKS, opts({ width }));
         const l = layoutGraph(TASKS, opts({ width, parentOf }));
         const kinds = l.lines.filter((x) => x.kind === "parent").map((x) => `${x.from}>${x.to}`);
         expect(kinds.sort()).toEqual(["api>tests", "docs>ui", "plan>schema", "ui>spike"]);
         expect(l.cards.map((c) => [c.id, c.rank, c.lane])).toEqual(
            plain.cards.map((c) => [c.id, c.rank, c.lane]),
         );
         expect(problems(l)).toEqual([]);
      }
      // A parent that is not shown: no line.
      const none = layoutGraph(TASKS, opts({ parentOf: () => "nowhere" }));
      expect(none.lines.some((x) => x.kind === "parent")).toBe(false);
      for (const tasks of [bigGraph(40, 7), bigGraph(60, 42)]) {
         // Some point back to an earlier or a later task (n1 -> n2), so lines also run right to left.
         const parentOf = (x: GraphTask) => {
            const n = Number(x.id.slice(1));
            return n % 3 === 0 && n > 0 ? `n${n - 1}` : n % 5 === 1 ? "n2" : null;
         };
         for (const width of [300, 660, 1440])
            for (const groupBy of [null, "area"])
               expect(
                  problems(layoutGraph(tasks, { width, groupBy, density: "detail", parentOf })),
               ).toEqual([]);
      }
   });

   it("the checks find a line through a card and two lines on one track", () => {
      const l = layoutGraph(TASKS, opts({ width: 440 }));
      expect(problems(l)).toEqual([]);
      const line = l.lines.find((x) => x.points.length > 4)!;
      const p = line.points[2]!;
      const card = { id: "x", x: p.x - 10, y: p.y - 10, lane: 0, rank: 0 };
      expect(problems({ ...l, cards: [...l.cards, card] })).toContain(
         `${line.from}->${line.to} crosses x`,
      );
      expect(problems({ ...l, lines: [...l.lines, line] }).some((s) => s.includes("share"))).toBe(
         true,
      );
   });

   it("gives the same output for the same input, in any input order", () => {
      const tasks = bigGraph(40, 11);
      const a = layoutGraph(tasks, opts({ groupBy: "area", width: 660 }));
      expect(layoutGraph(tasks, opts({ groupBy: "area", width: 660 }))).toEqual(a);
      expect(layoutGraph([...tasks].reverse(), opts({ groupBy: "area", width: 660 }))).toEqual(a);
   });

   it("lays out at MIN_WIDTH below it", () => {
      expect(MIN_WIDTH).toBe(424);
      const narrow = layoutGraph(TASKS, opts({ width: 300 }));
      expect(narrow).toEqual(layoutGraph(TASKS, opts({ width: 424 })));
      expect(narrow.width).toBe(424);
   });

   it("outer gaps grow by their lines: PAD to the edge, 2 tracks to the cards", () => {
      const parentOf = (x: GraphTask) => {
         const n = Number(x.id.slice(1));
         return n % 3 === 0 && n > 0 ? `n${n - 1}` : n % 5 === 1 ? "n2" : null;
      };
      let outer = 0;
      for (const tasks of [bigGraph(40, 7), bigGraph(60, 42)])
         for (const width of [300, 424, 660])
            for (const groupBy of [null, "area"]) {
               const l = layoutGraph(tasks, { width, groupBy, density: "detail", parentOf });
               const left = Math.min(...l.cards.map((c) => c.x));
               const right = Math.max(...l.cards.map((c) => c.x + l.cardWidth));
               expect(left).toBeGreaterThanOrEqual(PAD);
               for (const line of l.lines)
                  for (const s of segs(line.points).filter(vertical)) {
                     const x = s[0].x;
                     if (x >= left && x <= right) continue;
                     outer++;
                     expect(x < left ? left - x : x - right).toBeGreaterThanOrEqual(
                        2 * TRACK - EPS,
                     );
                  }
            }
      expect(outer).toBeGreaterThan(0);
      // A few outer lines: the cards shrink, the layout does not get wider than the container.
      const parents: Record<string, string> = { plan: "tests", schema: "ui", docs: "api" };
      const small = layoutGraph(
         TASKS,
         opts({ width: 300, parentOf: (x) => parents[x.id] ?? null }),
      );
      expect(small.width).toBe(MIN_WIDTH);
      expect(small.cardWidth).toBeLessThan(layoutGraph(TASKS, opts({ width: 300 })).cardWidth);
   });

   it("lays out nothing for no tasks", () => {
      const l = layoutGraph([], opts());
      expect(l.cards).toEqual([]);
      expect(l.lanes).toEqual([]);
      expect(l.lines).toEqual([]);
   });
});
