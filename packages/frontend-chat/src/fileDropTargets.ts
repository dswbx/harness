import { type DropPoint, onFileDrop } from "@harness/api";
import { inside } from "./attachments";

type Rect = { left: number; top: number; right: number; bottom: number };

/** A prompt box that can take files dropped on the window. */
export type DropTarget = {
   el: () => HTMLElement | null;
   /** The drag is over the window and this target would take the drop. */
   over: (on: boolean) => void;
   drop: (paths: string[]) => void;
};

/**
 * Which target takes a drop at `point`: the one under the point, else the focused one, else the
 * first. A drop anywhere on the window lands in a prompt box, and in one only. -1: no target.
 */
export function pickTarget(
   rects: (Rect | null)[],
   point: DropPoint | undefined,
   focused: number,
): number {
   if (point) {
      const under = rects.findIndex((r) => r !== null && inside(r, point));
      if (under >= 0) return under;
   }
   if (focused >= 0 && focused < rects.length) return focused;
   return rects.length ? 0 : -1;
}

const targets: DropTarget[] = [];
let stop: (() => void) | null = null;
/** Bumped on every subscribe and unsubscribe, so a late `onFileDrop` answer knows it is stale. */
let run = 0;

function chosen(point: DropPoint | undefined): DropTarget | undefined {
   const els = targets.map((t) => t.el());
   const active = document.activeElement;
   const focused = els.findIndex((el) => !!el && !!active && el.contains(active));
   const rects = els.map((el) => el?.getBoundingClientRect() ?? null);
   return targets[pickTarget(rects, point, focused)];
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
