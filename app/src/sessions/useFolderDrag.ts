import { useCallback, useEffect, useRef, useState } from "react";

/** The folder group being dragged and the folder it would land before (null: after the last). */
export type FolderDrag = { id: string; before: string | null };

/** Distance before a press turns into a drag, so a click (or a shaky one) still folds the group. */
const THRESHOLD = 6;

/** Where a drop lands: before the first folder group whose header's middle is below the pointer. */
function beforeAt(y: number): string | null {
   for (const el of document.querySelectorAll<HTMLElement>("[data-folder-group]")) {
      const r = el.getBoundingClientRect();
      if (y < r.top + r.height / 2) return el.dataset.folderGroup!;
   }
   return null;
}

/**
 * Pointer drag of a folder group header (marked `data-folder-group`) to reorder the groups. It
 * starts after a few px; Esc, blur or a lost capture cancel; the click that ends a drag is swallowed.
 */
export function useFolderDrag(onDrop: (id: string, before: string | null) => void) {
   const [drag, setDrag] = useState<FolderDrag | null>(null);
   const drop = useRef(onDrop);
   useEffect(() => {
      drop.current = onDrop;
   });
   const cancel = useRef<(() => void) | null>(null);
   useEffect(() => () => cancel.current?.(), []);

   const start = useCallback((id: string, e: React.PointerEvent) => {
      if (e.button !== 0) return;
      // No text selection from the press; a plain click still clicks.
      e.preventDefault();
      const el = e.currentTarget as HTMLElement;
      const pointer = e.pointerId;
      const sy = e.clientY;
      const sx = e.clientX;
      let active = false;
      let before: string | null = null;
      const onMove = (ev: PointerEvent) => {
         if (!active) {
            if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < THRESHOLD) return;
            active = true;
            el.setPointerCapture?.(pointer);
            document.body.style.cursor = "grabbing";
            document.body.style.userSelect = "none";
         }
         before = beforeAt(ev.clientY);
         setDrag({ id, before });
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
         // The header button would take the release as a click (and fold the group).
         const swallow = (ev: MouseEvent) => {
            ev.stopPropagation();
            ev.preventDefault();
         };
         window.addEventListener("click", swallow, true);
         setTimeout(() => window.removeEventListener("click", swallow, true), 0);
         if (commit) drop.current(id, before);
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
