import {
   type PointerEvent as ReactPointerEvent,
   useCallback,
   useEffect,
   useRef,
   useState,
} from "react";

/**
 * The task being dragged, the row it would land on (`target`: a task id, `""` the top level, null: nowhere
 * it can go) and the pointer, for the ghost.
 */
export type NestDrag = { id: string; target: string | null; x: number; y: number };

/** Distance before a press turns into a drag, so a click (or a shaky one) still clicks. */
const THRESHOLD = 6;

/**
 * The drop row under the pointer: the element marked `data-nest-target` (its value: a task id, or "" the top level).
 * Hit-tested, so a row scrolled out of sight (kept in the DOM by the virtual list) under a header does not count.
 */
function targetAt(x: number, y: number): string | null {
   const el = document.elementFromPoint?.(x, y)?.closest<HTMLElement>("[data-nest-target]");
   return el?.dataset.nestTarget ?? null;
}

/**
 * Pointer drag of a task row onto another row to nest it there (the pattern of the sidebar's folder drag).
 * It starts after a few px; Esc, blur or a lost capture cancel; the click that ends a drag is swallowed.
 * `canDrop(id, target)`: `target` null is the top level. A press on a control (menu, status) does not drag.
 */
export function useNestDrag(
   onDrop: (id: string, target: string | null) => void,
   canDrop: (id: string, target: string | null) => boolean,
) {
   const [drag, setDrag] = useState<NestDrag | null>(null);
   const latest = useRef({ onDrop, canDrop });
   useEffect(() => {
      latest.current = { onDrop, canDrop };
   });
   const cancel = useRef<(() => void) | null>(null);
   useEffect(() => () => cancel.current?.(), []);

   const start = useCallback((id: string, e: ReactPointerEvent) => {
      if (e.button !== 0) return;
      const hit = e.target as Element;
      if (hit.closest("button:not([data-drag]), a, input, [role=menuitem]")) return;
      // No text selection from the press; a plain click still clicks.
      e.preventDefault();
      const el = e.currentTarget as HTMLElement;
      const pointer = e.pointerId;
      const sx = e.clientX;
      const sy = e.clientY;
      let active = false;
      let target: string | null = null;
      const onMove = (ev: PointerEvent) => {
         if (!active) {
            if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < THRESHOLD) return;
            active = true;
            el.setPointerCapture?.(pointer);
            document.body.style.cursor = "grabbing";
            document.body.style.userSelect = "none";
         }
         const at = targetAt(ev.clientX, ev.clientY);
         const parent = at === "" ? null : at;
         target = at !== null && latest.current.canDrop(id, parent) ? at : null;
         setDrag({ id, target, x: ev.clientX, y: ev.clientY });
      };
      let done = false;
      const finish = (commit: boolean) => {
         if (done) return;
         done = true;
         window.removeEventListener("pointermove", onMove);
         window.removeEventListener("pointerup", onUp);
         window.removeEventListener("pointercancel", onCancel);
         window.removeEventListener("keydown", onKey, true);
         window.removeEventListener("blur", onCancel);
         el.removeEventListener("lostpointercapture", onCancel);
         cancel.current = null;
         if (!active) return;
         if (el.hasPointerCapture?.(pointer)) el.releasePointerCapture(pointer);
         document.body.style.removeProperty("cursor");
         document.body.style.removeProperty("user-select");
         setDrag(null);
         // The row's title button would take the release as a click (and open the preview).
         const swallow = (ev: MouseEvent) => {
            ev.stopPropagation();
            ev.preventDefault();
         };
         window.addEventListener("click", swallow, true);
         setTimeout(() => window.removeEventListener("click", swallow, true), 0);
         if (commit && target !== null) latest.current.onDrop(id, target === "" ? null : target);
      };
      const onUp = () => finish(true);
      const onCancel = () => finish(false);
      const onKey = (ev: KeyboardEvent) => {
         if (ev.key !== "Escape") return;
         ev.preventDefault();
         ev.stopPropagation();
         finish(false);
      };
      cancel.current = () => finish(false);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("keydown", onKey, true);
      window.addEventListener("blur", onCancel);
      el.addEventListener("lostpointercapture", onCancel);
   }, []);

   return { drag, start };
}
