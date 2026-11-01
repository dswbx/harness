import { useCallback, useEffect, useRef, useState } from "react";
import type { PanelId, Zone } from "./panelLayout";

/** Where a drop would land: a zone, and (over a stripe group) the insert index in its list; null: the end. */
export type DropTarget = { zone: Zone; index: number | null };
export type DragState = { id: PanelId; label: string; x: number; y: number; target: DropTarget | null };

const THRESHOLD = 4;

/** The drop target under the pointer: `data-drop-zone` on a stripe group or pad, `data-drop-index` on a stripe icon. */
export function targetAt(x: number, y: number): DropTarget | null {
  const els = document.elementsFromPoint(x, y).filter((e): e is HTMLElement => e instanceof HTMLElement);
  const zoneEl = els.find((e) => e.dataset.dropZone);
  if (!zoneEl) return null;
  const item = els.find((e) => e.dataset.dropIndex !== undefined && zoneEl.contains(e));
  let index: number | null = null;
  if (item) {
    const r = item.getBoundingClientRect();
    index = Number(item.dataset.dropIndex) + (y > r.top + r.height / 2 ? 1 : 0);
  }
  return { zone: zoneEl.dataset.dropZone as Zone, index };
}

/**
 * Pointer-event drag of a panel (from a stripe icon or a panel header). It starts after 4 px, so a plain
 * click still clicks; Esc cancels; the click that ends a drag is swallowed. Not HTML5 DnD: that gives
 * no custom ghost and the Tauri webview handles file drops itself.
 */
export function usePanelDrag(onDrop: (id: PanelId, target: DropTarget) => void) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const drop = useRef(onDrop);
  useEffect(() => { drop.current = onDrop; });
  const cancel = useRef<(() => void) | null>(null);
  useEffect(() => () => cancel.current?.(), []);

  const start = useCallback((id: PanelId, label: string, e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // No text selection (or native drag) from the press; a plain click still clicks.
    e.preventDefault();
    const sx = e.clientX;
    const sy = e.clientY;
    let active = false;
    let target: DropTarget | null = null;
    const onMove = (ev: PointerEvent) => {
      if (!active) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < THRESHOLD) return;
        active = true;
        document.body.style.cursor = "grabbing";
        document.body.style.userSelect = "none";
      }
      target = targetAt(ev.clientX, ev.clientY);
      setDrag({ id, label, x: ev.clientX, y: ev.clientY, target });
    };
    const finish = (commit: boolean) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
      cancel.current = null;
      if (!active) return;
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
      setDrag(null);
      // The button the drag started on would take the release as a click.
      const swallow = (ev: MouseEvent) => { ev.stopPropagation(); ev.preventDefault(); };
      window.addEventListener("click", swallow, true);
      setTimeout(() => window.removeEventListener("click", swallow, true), 0);
      if (commit && target) drop.current(id, target);
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
  }, []);

  return { drag, start };
}
