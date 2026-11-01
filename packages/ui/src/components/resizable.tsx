import * as React from "react";
import { cn } from "../lib/utils";
import { Tooltip } from "./tooltip";

type DragOptions = {
  cursor: "col-resize" | "row-resize";
  /** Called once on pointer down, before any movement. */
  onStart?: () => void;
  /** Distance from the pointer-down point, in px. */
  onDelta: (dx: number, dy: number) => void;
  onEnd?: () => void;
};

/** A pointer drag measured from where it started. Returns the `onPointerDown` to put on the handle. */
export function useDragDelta(opts: DragOptions) {
  const latest = React.useRef(opts);
  latest.current = opts;
  return React.useCallback((e: React.PointerEvent<HTMLElement>) => {
    e.preventDefault();
    const { clientX: startX, clientY: startY } = e;
    latest.current.onStart?.();
    const move = (ev: PointerEvent) => latest.current.onDelta(ev.clientX - startX, ev.clientY - startY);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
      latest.current.onEnd?.();
    };
    document.body.style.cursor = latest.current.cursor;
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, []);
}

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
  const start = React.useRef(width);
  const last = React.useRef(width);
  const onPointerDown = useDragDelta({
    cursor: "col-resize",
    onStart: () => { start.current = width; last.current = width; },
    onDelta: (dx) => {
      last.current = clamp(edge === "right" ? start.current + dx : start.current - dx);
      setWidth(last.current);
    },
    onEnd: () => save(last.current),
  });
  const reset = () => {
    setWidth(initial);
    save(initial);
  };
  return { width, handle: { edge, onPointerDown, onDoubleClick: reset } };
}

/**
 * The drag strip on an edge. By `edge` it hugs that edge of its `relative` parent; with `style` it is
 * placed freely (a dock's split lines), `orientation` then says which way the line runs.
 */
export function ResizeHandle({ label, edge, orientation = "vertical", style, onPointerDown, onDoubleClick }: {
  label: string;
  edge?: "left" | "right";
  orientation?: "vertical" | "horizontal";
  style?: React.CSSProperties;
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
  onDoubleClick: () => void;
}) {
  const vertical = orientation === "vertical";
  return (
    <Tooltip content="Drag to resize, double-click to reset" side={edge ?? (vertical ? "right" : "bottom")} delay={700}>
      <div
        role="separator"
        aria-orientation={orientation}
        aria-label={label}
        style={style}
        className={cn(
          "z-10 after:absolute after:transition-colors hover:after:bg-ring",
          vertical ? "cursor-col-resize after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2" : "cursor-row-resize after:inset-x-0 after:top-1/2 after:h-px after:-translate-y-1/2",
          !style && "absolute inset-y-0 w-2",
          !style && (edge === "right" ? "-right-1" : "-left-1"),
          style && "absolute",
        )}
        onPointerDown={onPointerDown}
        onDoubleClick={onDoubleClick}
      />
    </Tooltip>
  );
}
