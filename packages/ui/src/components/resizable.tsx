import * as React from "react";
import { cn } from "../lib/utils";
import { Tooltip } from "./tooltip";

type Options = {
  /** localStorage key the width is kept under (per viewer). */
  storageKey: string;
  initial: number;
  min: number;
  max: number;
  /** Edge of the panel the handle sits on: dragging it outward widens the panel. */
  edge: "left" | "right";
};

/** A panel width dragged from one of its edges (double-click resets), remembered per viewer. */
export function useResizableWidth({ storageKey, initial, min, max, edge }: Options) {
  const clamp = (w: number) => Math.min(max, Math.max(min, w));
  const [width, setWidth] = React.useState(() => {
    try {
      const w = Number(localStorage.getItem(storageKey));
      return w >= min && w <= max ? w : initial;
    } catch {
      return initial;
    }
  });
  const save = (w: number) => {
    try {
      localStorage.setItem(storageKey, String(w));
    } catch { /* per-viewer convenience only */ }
  };
  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const start = width;
    let last = start;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      last = clamp(edge === "right" ? start + dx : start - dx);
      setWidth(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
      save(last);
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const reset = () => {
    setWidth(initial);
    save(initial);
  };
  return { width, handle: { edge, onPointerDown, onDoubleClick: reset } };
}

/** The drag strip on a panel edge (the panel needs `relative`). Pass `useResizableWidth(...).handle`. */
export function ResizeHandle({ label, edge, onPointerDown, onDoubleClick }: {
  label: string; edge: "left" | "right"; onPointerDown: (e: React.PointerEvent<HTMLElement>) => void; onDoubleClick: () => void;
}) {
  return (
    <Tooltip content="Drag to resize, double-click to reset" side={edge} delay={700}>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={label}
        className={cn(
          "absolute inset-y-0 z-10 w-2 cursor-col-resize after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:transition-colors hover:after:bg-ring",
          edge === "right" ? "-right-1" : "-left-1",
        )}
        onPointerDown={onPointerDown}
        onDoubleClick={onDoubleClick}
      />
    </Tooltip>
  );
}
