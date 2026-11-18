import { isOpen, type TaskSummary } from "@harness/api";
import { ancestors, matchesFilter, sortTasks, type TaskFilter } from "./listModel";

// The All tasks tree (ADR 0028, board "AllTasksTree"): which tasks show, and where. Pure, for the tests.

/** Sizes in px. A column per depth: the "All topics" root, the topics, their subtasks, ... */
const NODE_W = 260;
const NODE_H = 52;
const ROOT_W = 112;
const ROOT_H = 32;
const GAP_X = 48;
const GAP_Y = 10;
/** Extra space between two topics. */
const TOPIC_GAP = 14;
const PAD = 24;

export type Box = { x: number; y: number; w: number; h: number };

export type TreeNode<T> = Box & {
   task: T;
   /** 0: a topic; 1: its subtask; ... */
   depth: number;
   /** Its subtasks that show (shown or folded away). */
   kids: number;
   /** Folded: how many tasks below it would show (all levels); 0 when expanded. */
   hidden: number;
   expanded: boolean;
   /** It did not pass the filters: it shows only for the subtasks below it that did. */
   context: boolean;
};

/** A connector from the right middle of `from` (null: the root) to the left middle of `to`. */
export type TreeEdge = {
   from: string | null;
   to: string;
   x1: number;
   y1: number;
   x2: number;
   y2: number;
};

export type TreeLayout<T> = {
   /** The "All topics" box; null when no topic shows. */
   root: Box | null;
   /** Pre-order: a topic, then its subtasks. */
   nodes: TreeNode<T>[];
   edges: TreeEdge[];
   width: number;
   height: number;
   /** Top-level tasks without subtasks that pass the filters: the tree hides them (the list has them). */
   loose: number;
};

export type TreeOptions = {
   /**
    * The view's filters, except the status one: the tree has Hide done instead. A task shows when it passes,
    * or when a task below it does (then dimmed, as context), as in the list.
    */
   filter: TaskFilter;
   today: string;
   /** Done and cancelled tasks fail the filters (they still show as context above an open one). */
   hideDone: boolean;
   /** Tasks folded by the user. Every task with subtasks is expanded by default. */
   collapsed: ReadonlySet<string>;
};

type Layoutable = Parameters<typeof matchesFilter>[0] &
   Pick<TaskSummary, "parent_id" | "created_ms">;

/**
 * Lays the tree out left to right: the root, then one column per depth. A leaf (or a folded task) takes the
 * next row; a parent sits at the middle of its children. So no two boxes overlap: each row holds one leaf,
 * and a parent's middle lies inside its own children's rows.
 *
 * Only topics show at the top level: a top-level task with subtasks. Subtasks show in full below them.
 */
export function layoutTree<T extends Layoutable>(
   tasks: readonly T[],
   o: TreeOptions,
): TreeLayout<T> {
   const passes = (t: T) =>
      matchesFilter(t, o.filter, o.today) && (!o.hideDone || isOpen(t.status));
   const ids = new Set(tasks.map((t) => t.id));
   const kidsOf = new Map<string | null, T[]>();
   for (const t of tasks) {
      const p = t.parent_id && ids.has(t.parent_id) ? t.parent_id : null;
      kidsOf.set(p, [...(kidsOf.get(p) ?? []), t]);
   }
   for (const [k, l] of kidsOf) kidsOf.set(k, sortTasks(l));
   const allKids = (id: string) => kidsOf.get(id) ?? [];

   // Shown: it passes, or a task below it does.
   const shownMemo = new Map<string, boolean>();
   const shown = (t: T, seen = new Set<string>()): boolean => {
      const hit = shownMemo.get(t.id);
      if (hit !== undefined) return hit;
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      const v = passes(t) || allKids(t.id).some((k) => shown(k, seen));
      shownMemo.set(t.id, v);
      return v;
   };
   const kids = (id: string) => allKids(id).filter((k) => shown(k));
   const below = (id: string, seen: Set<string>): number =>
      kids(id).reduce(
         (n, k) => (seen.has(k.id) ? n : (seen.add(k.id), n + 1 + below(k.id, seen))),
         0,
      );

   const tops = kidsOf.get(null) ?? [];
   const topics = tops.filter((t) => allKids(t.id).length > 0 && shown(t));
   const loose = tops.filter((t) => allKids(t.id).length === 0 && passes(t)).length;

   const nodes: TreeNode<T>[] = [];
   const edges: TreeEdge[] = [];
   const colX = (depth: number) => PAD + ROOT_W + GAP_X + depth * (NODE_W + GAP_X);
   let cursor = PAD;
   let right = 0;
   const seen = new Set<string>();

   /** Places `t` and what shows below it; returns its box. */
   const place = (t: T, depth: number): TreeNode<T> => {
      seen.add(t.id);
      const shownKids = kids(t.id).filter((k) => !seen.has(k.id));
      const expanded = shownKids.length > 0 && !o.collapsed.has(t.id);
      const node: TreeNode<T> = {
         task: t,
         depth,
         kids: shownKids.length,
         hidden: expanded ? 0 : below(t.id, new Set([t.id])),
         expanded,
         context: !passes(t),
         x: colX(depth),
         y: 0,
         w: NODE_W,
         h: NODE_H,
      };
      nodes.push(node);
      right = Math.max(right, node.x + node.w);
      if (!expanded) {
         node.y = cursor;
         cursor += NODE_H + GAP_Y;
         return node;
      }
      const placed = shownKids.flatMap((k) => (seen.has(k.id) ? [] : [place(k, depth + 1)]));
      const first = placed[0] as TreeNode<T>;
      const last = placed[placed.length - 1] as TreeNode<T>;
      node.y = (first.y + last.y) / 2;
      for (const k of placed) edges.push(edge(t.id, node, k.task.id, k));
      return node;
   };

   const placedTopics = topics.map((t, i) => {
      if (i > 0) cursor += TOPIC_GAP;
      return place(t, 0);
   });
   if (placedTopics.length === 0) return { root: null, nodes, edges, width: 0, height: 0, loose };

   const first = placedTopics[0] as TreeNode<T>;
   const last = placedTopics[placedTopics.length - 1] as TreeNode<T>;
   const root: Box = {
      x: PAD,
      y: (first.y + last.y + NODE_H) / 2 - ROOT_H / 2,
      w: ROOT_W,
      h: ROOT_H,
   };
   for (const t of placedTopics) edges.push(edge(null, root, t.task.id, t));
   return { root, nodes, edges, width: right + PAD, height: cursor - GAP_Y + PAD, loose };
}

function edge(from: string | null, a: Box, to: string, b: Box): TreeEdge {
   return {
      from,
      to,
      x1: a.x + a.w,
      y1: a.y + a.h / 2,
      x2: b.x,
      y2: b.y + b.h / 2,
   };
}

/** Collapse all: every task with subtasks is folded (only the topics show). */
export function collapseAll(tasks: readonly Pick<TaskSummary, "parent_id">[]): Set<string> {
   return new Set(tasks.flatMap((t) => (t.parent_id ? [t.parent_id] : [])));
}

/** `collapsed` without the ancestors of `id`, so its node shows (the same set when nothing changes). */
export function revealNode(
   tasks: ReadonlyMap<string, Pick<TaskSummary, "id" | "parent_id">>,
   id: string,
   collapsed: ReadonlySet<string>,
): ReadonlySet<string> {
   const up = ancestors(tasks, id).filter((t) => collapsed.has(t.id));
   if (up.length === 0) return collapsed;
   const next = new Set(collapsed);
   for (const t of up) next.delete(t.id);
   return next;
}
