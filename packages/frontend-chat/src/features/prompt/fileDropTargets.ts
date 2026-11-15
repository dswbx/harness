import { type DropPoint, onFileDrop } from "@harness/api";
import { inside } from "./attachments";

type Rect = { left: number; top: number; right: number; bottom: number };

/** A prompt box that can take files dropped on the window. */
export type DropTarget = {
   el: () => HTMLElement | null;
   /** The area that belongs to this box (the chat column, a Side chat panel body). */
   region: () => HTMLElement | null;
   /** The box of the Main Thread: it takes drops that are over no box or region. */
   main: boolean;
   /** The drag is over the window and this target would take the drop. */
   over: (on: boolean) => void;
   drop: (paths: string[]) => void;
};

export type TargetRects = { box: Rect | null; region: Rect | null; main: boolean };

const area = (r: Rect) => (r.right - r.left) * (r.bottom - r.top);

/**
 * Which target takes a drop at `point`: the box under the point, else the box of the smallest
 * region under it, else the Main Thread's box (else the first). Focus plays no role. -1: no target.
 */
export function pickTarget(targets: TargetRects[], point: DropPoint | undefined): number {
   if (point) {
      const under = targets.findIndex((t) => t.box !== null && inside(t.box, point));
      if (under >= 0) return under;
      let best = -1;
      let bestArea = Number.POSITIVE_INFINITY;
      targets.forEach((t, i) => {
         if (!t.region || !inside(t.region, point) || area(t.region) >= bestArea) return;
         best = i;
         bestArea = area(t.region);
      });
      if (best >= 0) return best;
   }
   const main = targets.findIndex((t) => t.main);
   if (main >= 0) return main;
   return targets.length ? 0 : -1;
}

const targets: DropTarget[] = [];
let stop: (() => void) | null = null;
/** Bumped on every subscribe and unsubscribe, so a late `onFileDrop` answer knows it is stale. */
let run = 0;

function chosen(point: DropPoint | undefined): DropTarget | undefined {
   const rects = targets.map((t) => ({
      box: t.el()?.getBoundingClientRect() ?? null,
      region: t.region()?.getBoundingClientRect() ?? null,
      main: t.main,
   }));
   return targets[pickTarget(rects, point)];
}

/**
 * Registers a prompt box for file drops (Tauri delivers them to the window, not to an element).
 * One window listener serves all of them. Returns the unregister function.
 */
export function registerDropTarget(target: DropTarget): () => void {
   targets.push(target);
   if (targets.length === 1) {
      const mine = ++run;
      void onFileDrop((e) => {
         const to = e.type === "leave" ? undefined : chosen(e.position);
         for (const t of targets) t.over(e.type === "over" && t === to);
         if (e.type === "drop") to?.drop(e.paths);
      }).then((u) => {
         if (mine === run) stop = u;
         else u?.();
      });
   }
   return () => {
      const i = targets.indexOf(target);
      if (i >= 0) targets.splice(i, 1);
      if (targets.length === 0) {
         run++;
         stop?.();
         stop = null;
      }
   };
}
