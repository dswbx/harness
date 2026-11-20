// The Graph view (ADR 0029, docs/plans/task-graph.md "The layout"): where the cards, lane bands and lines go
// for a given width. Pure, for the tests.

export type GraphDepKind = "blocks" | "follow_up";
/** A dep, or `parent`: from a task's parent to it (`parentOf`). */
export type GraphLineKind = GraphDepKind | "parent";

/** What the layout reads from a task (a `TaskSummary` fits). A dep is stored on the task that waits. */
export interface GraphTask {
   id: string;
   order: number;
   deps: readonly { id: string; kind: GraphDepKind }[];
   props: Readonly<Record<string, string>>;
}

/**
 * The lanes: null is one lane without a heading; a string is a prop key (lane label: the value, missing:
 * "No <key>"); or a function for other fields (status, topic, Session), with its labels.
 */
export type GraphGroupBy<T> =
   | null
   | string
   | {
        laneOf: (t: T) => string | null;
        /** The heading of a lane; the key when not given. */
        label?: (key: string) => string;
        /** The heading of the last lane, for tasks without a key. */
        missing: string;
     };

export type GraphOptions<T> = {
   /** The container width in px. Below `MIN_WIDTH`, the layout is `MIN_WIDTH` wide (it scrolls sideways). */
   width: number;
   groupBy: GraphGroupBy<T>;
   density: "condensed" | "detail";
   /**
    * Tasks that are not shown (other Sessions) but that shown tasks depend on: each one in a dep shows as an
    * outside card just before the task that waits on it, in its lane. Others are ignored.
    */
   outside?: readonly GraphTask[];
   /**
    * Also a `parent` line from each task's parent to it, when both show. Parent lines do not change ranks or
    * the order in a lane, only the room in the gaps.
    */
   parentOf?: (t: T) => string | null;
};

export type GraphPoint = { x: number; y: number };

export type GraphCard = {
   id: string;
   x: number;
   y: number;
   /** Index in `lanes`. */
   lane: number;
   /** Longest dep path to it. An outside card: one less than the lowest rank of the tasks waiting on it. */
   rank: number;
   outside?: true;
};

export type GraphLane = {
   /** The group value; null for "No <key>" and for the single lane without grouping. */
   key: string | null;
   label: string;
   x: number;
   y: number;
   w: number;
   h: number;
   /** The heading height at the top of the band: `LANE_HEAD`, or 0 without grouping. */
   head: number;
};

/** From the task waited on (the dep target) to the task that waits; for `parent`, from the parent to the child. */
export type GraphLine = {
   from: string;
   to: string;
   kind: GraphLineKind;
   /** Orthogonal: from the right side of `from` to the left side of `to`. */
   points: GraphPoint[];
   /** SVG path `d` of `points` with rounded corners. */
   path: string;
};

export type GraphLayout = {
   /** aligned: lanes are bands, column = rank. flow: lanes are sections, tasks fill rows of `cols`. */
   mode: "aligned" | "flow";
   width: number;
   height: number;
   cols: number;
   cardWidth: number;
   cardHeight: number;
   /** By row, then column. */
   cards: GraphCard[];
   lanes: GraphLane[];
   lines: GraphLine[];
};

/** Sizes in px. */
export const CARD_MIN = 176;
export const CARD_MAX = 248;
/** Between columns. */
export const GAP = 32;
/** Around the cards; lines in an outer gap keep at least this from the edge. */
export const PAD = 20;
/** Two cards. */
export const MIN_WIDTH = 2 * CARD_MIN + GAP + 2 * PAD;
export const CARD_HEIGHT = { condensed: 48, detail: 64 } as const;
/** Between two rows of one lane. */
export const ROW_GAP = 16;
/** Between two lanes, above the heading. */
export const LANE_GAP = 16;
export const LANE_HEAD = 24;
/** Between two lines in one gap. A gap grows when its lines need more room. */
export const TRACK = 4;
export const RADIUS = 6;

/** Cards per row for a container width (at least 2). */
export function graphColumns(width: number): number {
   const w = Math.max(width, MIN_WIDTH);
   return Math.max(2, Math.floor((w - 2 * PAD + GAP) / (CARD_MIN + GAP)));
}

/** Rank of each task: the longest path of deps (both kinds) to it; deps to tasks not in `tasks` are dropped. */
export function graphRanks(tasks: readonly GraphTask[]): Map<string, number> {
   const byId = new Map(tasks.map((t) => [t.id, t]));
   const rank = new Map<string, number>();
   const visiting = new Set<string>();
   const visit = (t: GraphTask): number => {
      const hit = rank.get(t.id);
      if (hit !== undefined) return hit;
      // A loop (the core refuses them): cut it here.
      if (visiting.has(t.id)) return -1;
      visiting.add(t.id);
      let r = 0;
      for (const d of t.deps) {
         const p = byId.get(d.id);
         if (p && p !== t) r = Math.max(r, visit(p) + 1);
      }
      visiting.delete(t.id);
      rank.set(t.id, r);
      return r;
   };
   for (const t of tasks) visit(t);
   return rank;
}

type Node = {
   id: string;
   order: number;
   rank: number;
   lane: number;
   outside: boolean;
   preds: Node[];
   succs: Node[];
   /** Rank column (ranks shifted so the lowest is 0). */
   col: number;
   gcol: number;
   grow: number;
};

type Line = {
   i: number;
   from: Node;
   to: Node;
   kind: GraphLineKind;
   /** The from and to cards are in neighbour columns: one jog in the gap between them. */
   direct: boolean;
   /** Otherwise: the horizontal gap (above row h) it goes along. */
   h: number;
   outY: number;
   inY: number;
   x1: number;
   x2: number;
   y: number;
};

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byOrder = (a: { order: number; id: string }, b: { order: number; id: string }) =>
   a.order - b.order || cmp(a.id, b.id);
const sum = (l: number[]) => l.reduce((a, b) => a + b, 0);

/**
 * Lays the graph out in a grid of cards. Gaps between columns and rows hold the lines, so a line never crosses
 * a card: out of the right side of the task waited on, along the gaps, into the left side of the task that
 * waits. Every line has its own track in each gap it uses.
 */
export function layoutGraph<T extends GraphTask>(
   tasks: readonly T[],
   o: GraphOptions<T>,
): GraphLayout {
   const width = Math.max(o.width, MIN_WIDTH);
   const cols = graphColumns(width);
   const fullCard = Math.min(CARD_MAX, (width - 2 * PAD - (cols - 1) * GAP) / cols);
   const cardHeight = CARD_HEIGHT[o.density];

   const shown = new Map<string, T>();
   for (const t of [...tasks].sort(byOrder)) if (!shown.has(t.id)) shown.set(t.id, t);
   const sorted = [...shown.values()];
   const ranks = graphRanks(sorted);

   // Lanes: by lowest rank, then name; tasks without a key last.
   const g = o.groupBy;
   const grouped = g !== null;
   const keyOf = (t: T): string | null => {
      const k = g === null ? null : typeof g === "string" ? t.props[g] : g.laneOf(t);
      return k === undefined || k === "" ? null : k;
   };
   const labelOf = (k: string | null) =>
      g === null
         ? ""
         : k === null
           ? typeof g === "string"
              ? `No ${g}`
              : g.missing
           : typeof g === "string" || !g.label
             ? k
             : g.label(k);
   const laneBy = new Map<string | null, { key: string | null; label: string; min: number }>();
   for (const t of sorted) {
      const k = keyOf(t);
      const r = ranks.get(t.id) ?? 0;
      const l = laneBy.get(k);
      if (l) l.min = Math.min(l.min, r);
      else laneBy.set(k, { key: k, label: labelOf(k), min: r });
   }
   const laneList = [...laneBy.values()].sort(
      (a, b) =>
         Number(a.key === null) - Number(b.key === null) ||
         a.min - b.min ||
         cmp(a.label, b.label) ||
         cmp(a.key ?? "", b.key ?? ""),
   );
   const laneIndex = new Map(laneList.map((l, i) => [l.key, i]));

   const node = (
      id: string,
      order: number,
      rank: number,
      lane: number,
      outside: boolean,
   ): Node => ({
      id,
      order,
      rank,
      lane,
      outside,
      preds: [],
      succs: [],
      col: 0,
      gcol: 0,
      grow: 0,
   });
   const nodes = new Map<string, Node>();
   for (const t of sorted)
      nodes.set(
         t.id,
         node(t.id, t.order, ranks.get(t.id) ?? 0, laneIndex.get(keyOf(t)) ?? 0, false),
      );

   // Deps, in task order. Outside cards for deps to outside tasks; other unknown ids are dropped.
   const outsideBy = new Map<string, GraphTask>();
   for (const t of o.outside ?? [])
      if (!shown.has(t.id) && !outsideBy.has(t.id)) outsideBy.set(t.id, t);
   const pending: { from: string; to: Node; kind: GraphLineKind }[] = [];
   const waiting = new Map<string, Node[]>();
   for (const t of sorted) {
      const to = nodes.get(t.id)!;
      const seen = new Set<string>();
      for (const d of t.deps) {
         if (d.id === t.id || seen.has(d.id)) continue;
         seen.add(d.id);
         if (shown.has(d.id)) pending.push({ from: d.id, to, kind: d.kind });
         else if (outsideBy.has(d.id)) {
            pending.push({ from: d.id, to, kind: d.kind });
            const w = waiting.get(d.id);
            if (w) w.push(to);
            else waiting.set(d.id, [to]);
         }
      }
   }
   for (const id of [...waiting.keys()].sort(cmp)) {
      const w = waiting.get(id)!;
      // The first lowest-ranked task waiting on it (task order) gives its lane.
      const first = w.reduce((a, b) => (b.rank < a.rank ? b : a));
      nodes.set(id, node(id, outsideBy.get(id)!.order, first.rank - 1, first.lane, true));
   }
   if (o.parentOf)
      for (const t of sorted) {
         const p = o.parentOf(t);
         if (p && p !== t.id && shown.has(p))
            pending.push({ from: p, to: nodes.get(t.id)!, kind: "parent" });
      }
   const lines: Line[] = pending.map((p, i) => {
      const from = nodes.get(p.from)!;
      if (p.kind !== "parent") {
         from.succs.push(p.to);
         p.to.preds.push(from);
      }
      return {
         i,
         from,
         to: p.to,
         kind: p.kind,
         direct: false,
         h: 0,
         outY: 0,
         inY: 0,
         x1: 0,
         x2: 0,
         y: 0,
      };
   });

   const all = [...nodes.values()];
   if (all.length === 0)
      return {
         mode: "aligned",
         width,
         height: 2 * PAD,
         cols,
         cardWidth: fullCard,
         cardHeight,
         cards: [],
         lanes: [],
         lines: [],
      };
   const minRank = Math.min(...all.map((n) => n.rank));
   for (const n of all) n.col = n.rank - minRank;
   const ranksN = Math.max(...all.map((n) => n.col)) + 1;
   const mode = cols >= ranksN ? "aligned" : "flow";

   // Cards per lane and rank column, then 2 barycenter sweeps (ties by order, then id).
   const groups: Node[][][] = laneList.map(() => Array.from({ length: ranksN }, () => []));
   for (const n of all) groups[n.lane]![n.col]!.push(n);
   for (const lane of groups) for (const gr of lane) gr.sort(byOrder);
   const laneRows = (L: number) =>
      mode === "aligned"
         ? Math.max(1, ...groups[L]!.map((gr) => gr.length))
         : Math.ceil(sum(groups[L]!.map((gr) => gr.length)) / cols);
   const laneStart: number[] = [];
   let nRows = 0;
   for (const [L] of laneList.entries()) {
      laneStart.push(nRows);
      nRows += laneRows(L);
   }
   const positions = () => {
      const pos = new Map<Node, number>();
      let seq = 0;
      for (const [L, lane] of groups.entries())
         for (const gr of lane)
            for (const [i, n] of gr.entries())
               pos.set(n, mode === "aligned" ? laneStart[L]! + i : seq++);
      return pos;
   };
   const sweep = (order: number[], near: (n: Node) => Node[]) => {
      for (const c of order) {
         const pos = positions();
         for (const lane of groups) {
            const gr = lane[c]!;
            if (gr.length < 2) continue;
            const bary = new Map(
               gr.map((n) => {
                  const ns = near(n);
                  return [n, ns.length ? sum(ns.map((m) => pos.get(m)!)) / ns.length : pos.get(n)!];
               }),
            );
            gr.sort((a, b) => bary.get(a)! - bary.get(b)! || byOrder(a, b));
         }
      }
   };
   const colIdx = Array.from({ length: ranksN }, (_, c) => c);
   sweep(colIdx, (n) => n.preds);
   sweep([...colIdx].reverse(), (n) => n.succs);

   // Grid cells.
   const gridCols = mode === "aligned" ? ranksN : cols;
   const firstRow = new Set(laneStart);
   const laneOfRow: number[] = [];
   for (const [L, lane] of groups.entries()) {
      for (let r = 0; r < laneRows(L); r++) laneOfRow.push(L);
      if (mode === "aligned")
         for (const gr of lane)
            for (const [i, n] of gr.entries()) {
               n.gcol = n.col;
               n.grow = laneStart[L]! + i;
            }
      else
         for (const [k, n] of lane.flat().entries()) {
            n.gcol = k % cols;
            n.grow = laneStart[L]! + Math.floor(k / cols);
         }
   }

   // Routes: the gap right of `from`, then (not direct) a row gap and the gap left of `to`.
   const vCount = new Array<number>(gridCols + 1).fill(0);
   const hCount = new Array<number>(nRows + 1).fill(0);
   for (const l of lines) {
      l.direct = l.to.gcol === l.from.gcol + 1;
      vCount[l.from.gcol + 1]!++;
      if (l.direct) continue;
      l.h = l.from.grow > l.to.grow ? l.from.grow : l.from.grow + 1;
      vCount[l.to.gcol]!++;
      hCount[l.h]!++;
   }

   // Sizes and positions.
   // An inner gap holds its tracks in the middle. An outer gap (left of the first column, above the first row,
   // and the mirror sides) grows by its tracks: PAD stays free on the edge side, 2 * TRACK on the card side.
   const room = (n: number) => (n + 1) * TRACK;
   const size = (n: number, outer: boolean, inner: number) =>
      outer ? PAD + (n > 0 ? room(n) : 0) : Math.max(inner, room(n));
   const trackStart = (start: number, sz: number, n: number, i: number, last: number) =>
      i === 0 ? start + PAD : i === last ? start + 2 * TRACK : start + (sz - (n - 1) * TRACK) / 2;
   const vSize = vCount.map((n, i) => size(n, i === 0 || i === gridCols, GAP));
   // Gaps that grew for their lines take room from the cards first (down to CARD_MIN - GAP), then widen the layout.
   const cardWidth = Math.min(fullCard, Math.max(CARD_MIN - GAP, (width - sum(vSize)) / gridCols));
   const content = sum(vSize) + gridCols * cardWidth;
   const left = Math.max(0, (width - content) / 2);
   const vStart: number[] = [];
   const colX: number[] = [];
   let x = left;
   for (let i = 0; i <= gridCols; i++) {
      vStart.push(x);
      x += vSize[i]!;
      colX.push(x);
      x += cardWidth;
   }
   const head = grouped ? LANE_HEAD : 0;
   const hSize = hCount.map((n, j) =>
      size(n, j === 0 || j === nRows, firstRow.has(j) ? LANE_GAP : ROW_GAP),
   );
   const hStart: number[] = [];
   const rowY: number[] = [];
   let y = 0;
   for (let j = 0; j <= nRows; j++) {
      hStart.push(y);
      y += hSize[j]!;
      if (j === nRows) break;
      if (firstRow.has(j)) y += head;
      rowY.push(y);
      y += cardHeight;
   }
   const height = y;
   const hMid = (h: number) => hStart[h]! + hSize[h]! / 2;

   // Ports: the two card sides facing one gap in one row share slots, so lines from both never meet on one y.
   type Port = { l: Line; out: boolean; in: boolean; key: number };
   const sides = new Map<string, Port[]>();
   const port = (ch: number, row: number, l: Line, out: boolean, key: number) => {
      const k = `${ch}:${row}`;
      const list = sides.get(k) ?? [];
      sides.set(k, list);
      const p = list.find((q) => q.l === l);
      if (p) {
         p.in = true;
         p.key = 2 * row + 1;
      } else list.push({ l, out, in: !out, key });
   };
   for (const l of lines) {
      port(l.from.gcol + 1, l.from.grow, l, true, l.direct ? 2 * l.to.grow + 1 : 2 * l.h);
      port(l.to.gcol, l.to.grow, l, false, l.direct ? 2 * l.from.grow + 1 : 2 * l.h);
   }
   for (const [k, list] of sides) {
      const row = Number(k.split(":")[1]);
      list.sort((a, b) => a.key - b.key || a.l.i - b.l.i);
      for (const [s, p] of list.entries()) {
         const py = rowY[row]! + (cardHeight * (s + 1)) / (list.length + 1);
         if (p.out) p.l.outY = py;
         if (p.in) p.l.inY = py;
      }
   }

   // Tracks in the column gaps: lines leaving the left card first, then direct ones, then lines entering the
   // right card; each group ordered to cross less.
   type VSeg = { l: Line; role: 0 | 1 | 2; a: number; b: number };
   const vSegs: VSeg[][] = vCount.map(() => []);
   for (const l of lines) {
      if (l.direct) vSegs[l.from.gcol + 1]!.push({ l, role: 1, a: l.outY, b: l.inY });
      else {
         vSegs[l.from.gcol + 1]!.push({ l, role: 0, a: l.outY, b: hMid(l.h) });
         vSegs[l.to.gcol]!.push({ l, role: 2, a: hMid(l.h), b: l.inY });
      }
   }
   // Leaving: up lines (by start, top first), flat, down lines (by start, bottom first). Entering: mirrored.
   const vKey = (s: VSeg): [number, number] =>
      s.role < 2
         ? s.b < s.a
            ? [0, s.a]
            : s.b === s.a
              ? [1, 0]
              : [2, -s.a]
         : s.a > s.b
           ? [0, s.b]
           : [1, -s.b];
   for (const [i, segs] of vSegs.entries()) {
      segs.sort((p, q) => {
         const [pg, pk] = vKey(p);
         const [qg, qk] = vKey(q);
         return p.role - q.role || pg - qg || pk - qk || p.l.i - q.l.i;
      });
      const x0 = trackStart(vStart[i]!, vSize[i]!, segs.length, i, gridCols);
      for (const [k, s] of segs.entries()) {
         if (s.role === 2) s.l.x2 = x0 + k * TRACK;
         else s.l.x1 = x0 + k * TRACK;
         if (s.role === 1) s.l.x2 = s.l.x1;
      }
   }

   // Tracks in the row gaps: lines whose both ends go up first (short ones on top), then the rest, then lines
   // whose both ends go down (long ones on top).
   const hLines: Line[][] = hCount.map(() => []);
   for (const l of lines) if (!l.direct) hLines[l.h]!.push(l);
   for (const [h, list] of hLines.entries()) {
      const key = (l: Line): [number, number] => {
         const up = Number(l.from.grow < h) + Number(l.to.grow < h);
         const span = Math.abs(l.x2 - l.x1);
         return up === 2 ? [0, span] : up === 0 ? [2, -span] : [1, Math.min(l.x1, l.x2)];
      };
      list.sort((p, q) => {
         const [pg, pk] = key(p);
         const [qg, qk] = key(q);
         return pg - qg || pk - qk || p.i - q.i;
      });
      const y0 = trackStart(hStart[h]!, hSize[h]!, list.length, h, nRows);
      for (const [k, l] of list.entries()) l.y = y0 + k * TRACK;
   }

   const cards: GraphCard[] = all
      .sort((a, b) => a.grow - b.grow || a.gcol - b.gcol)
      .map((n) => ({
         id: n.id,
         x: colX[n.gcol]!,
         y: rowY[n.grow]!,
         lane: n.lane,
         rank: n.rank,
         ...(n.outside ? { outside: true as const } : {}),
      }));
   const lanes: GraphLane[] = laneList.map((l, L) => {
      const top = rowY[laneStart[L]!]! - head;
      return {
         key: l.key,
         label: l.label,
         x: left,
         y: top,
         w: content,
         h: rowY[laneStart[L]! + laneRows(L) - 1]! + cardHeight - top,
         head,
      };
   });
   const out: GraphLine[] = lines.map((l) => {
      const sx = colX[l.from.gcol]! + cardWidth;
      const tx = colX[l.to.gcol]!;
      const pts = l.direct
         ? [
              { x: sx, y: l.outY },
              { x: l.x1, y: l.outY },
              { x: l.x1, y: l.inY },
              { x: tx, y: l.inY },
           ]
         : [
              { x: sx, y: l.outY },
              { x: l.x1, y: l.outY },
              { x: l.x1, y: l.y },
              { x: l.x2, y: l.y },
              { x: l.x2, y: l.inY },
              { x: tx, y: l.inY },
           ];
      const points = simplify(pts);
      return { from: l.from.id, to: l.to.id, kind: l.kind, points, path: roundedPath(points) };
   });
   return {
      mode,
      width: Math.max(width, content),
      height,
      cols,
      cardWidth,
      cardHeight,
      cards,
      lanes,
      lines: out,
   };
}

/** Drops repeated points and points in the middle of a straight run. */
function simplify(p: GraphPoint[]): GraphPoint[] {
   const same = (a: GraphPoint, b: GraphPoint) => a.x === b.x && a.y === b.y;
   const q = p.filter((pt, i) => i === 0 || !same(pt, p[i - 1]!));
   return q.filter((b, i) => {
      if (i === 0 || i === q.length - 1) return true;
      const a = q[i - 1]!;
      const c = q[i + 1]!;
      return !((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y));
   });
}

const num = (n: number) => String(Math.round(n * 100) / 100);

/** SVG path through the points, each corner rounded (`RADIUS`, less on short runs). */
function roundedPath(p: GraphPoint[]): string {
   const toward = (from: GraphPoint, to: GraphPoint, r: number) => {
      const d = Math.hypot(to.x - from.x, to.y - from.y);
      return { x: from.x + ((to.x - from.x) / d) * r, y: from.y + ((to.y - from.y) / d) * r };
   };
   const first = p[0]!;
   let d = `M${num(first.x)} ${num(first.y)}`;
   for (let i = 1; i < p.length - 1; i++) {
      const a = p[i - 1]!;
      const b = p[i]!;
      const c = p[i + 1]!;
      const r = Math.min(
         RADIUS,
         Math.hypot(b.x - a.x, b.y - a.y) / 2,
         Math.hypot(c.x - b.x, c.y - b.y) / 2,
      );
      const s = toward(b, a, r);
      const e = toward(b, c, r);
      d += ` L${num(s.x)} ${num(s.y)} Q${num(b.x)} ${num(b.y)} ${num(e.x)} ${num(e.y)}`;
   }
   const last = p[p.length - 1]!;
   return `${d} L${num(last.x)} ${num(last.y)}`;
}
