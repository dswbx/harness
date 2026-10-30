import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Maximize, Minus, Plus } from "lucide-react";
import { Button, Tooltip } from "@harness/ui";

type View = { scale: number; x: number; y: number };
const MIN = 0.1;
const MAX = 8;
const clamp = (s: number) => Math.min(MAX, Math.max(MIN, s));

/**
 * Pan and zoom over content of a known size: drag or scroll to pan, pinch / Cmd+scroll to zoom
 * around the pointer, + / - / 0 keys, and buttons. Opens fitted to the box.
 */
export function ZoomView({ width, height, children }: { width: number; height: number; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View | null>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);

  const fit = useCallback(() => {
    const el = box.current;
    if (!el) return;
    const { clientWidth: w, clientHeight: h } = el;
    const scale = clamp(Math.min((w - 48) / width, (h - 48) / height, 2));
    setView({ scale, x: (w - width * scale) / 2, y: (h - height * scale) / 2 });
  }, [width, height]);

  useEffect(fit, [fit]);

  /** Zoom by `k` keeping the point (px, py) of the box still; the box center when not given. */
  const zoom = useCallback((k: number, px?: number, py?: number) => {
    const el = box.current;
    setView((v) => {
      if (!v || !el) return v;
      const cx = px ?? el.clientWidth / 2;
      const cy = py ?? el.clientHeight / 2;
      const scale = clamp(v.scale * k);
      const r = scale / v.scale;
      return { scale, x: cx - (cx - v.x) * r, y: cy - (cy - v.y) * r };
    });
  }, []);

  // React's wheel listener is passive; this one must preventDefault to stop the page and the pinch.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const r = el.getBoundingClientRect();
        // Trackpad pinches send small deltas; a mouse wheel notch ~100, capped to ~1.3x.
        zoom(Math.exp(-Math.max(-50, Math.min(50, e.deltaY)) * 0.005), e.clientX - r.left, e.clientY - r.top);
      } else {
        setView((v) => v && { ...v, x: v.x - e.deltaX, y: v.y - e.deltaY });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoom]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "+" || e.key === "=") zoom(1.25);
    else if (e.key === "-") zoom(0.8);
    else if (e.key === "0") fit();
    else return;
    e.preventDefault();
  };

  return (
    <div className="relative h-full w-full overflow-hidden">
      <div
        ref={box}
        tabIndex={0}
        aria-label="Diagram: drag to pan, pinch or Cmd+scroll to zoom"
        onKeyDown={onKeyDown}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          drag.current = { x: e.clientX, y: e.clientY };
          setView((v) => v && { ...v, x: v.x + e.clientX - d.x, y: v.y + e.clientY - d.y });
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        className="h-full w-full cursor-grab touch-none outline-none select-none active:cursor-grabbing"
      >
        <div
          style={{ width, height, transform: view ? `translate(${view.x}px, ${view.y}px) scale(${view.scale})` : undefined, visibility: view ? undefined : "hidden" }}
          className="origin-top-left"
        >
          {children}
        </div>
      </div>
      <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-lg border bg-background/90 p-1 shadow-sm backdrop-blur">
        <Tooltip content="Zoom out (-)">
          <Button size="icon" variant="ghost" className="size-7" aria-label="Zoom out" onClick={() => zoom(0.8)}><Minus /></Button>
        </Tooltip>
        <span className="w-12 text-center text-xs tabular-nums text-muted-foreground">{view ? Math.round(view.scale * 100) : 100}%</span>
        <Tooltip content="Zoom in (+)">
          <Button size="icon" variant="ghost" className="size-7" aria-label="Zoom in" onClick={() => zoom(1.25)}><Plus /></Button>
        </Tooltip>
        <Tooltip content="Fit (0)">
          <Button size="icon" variant="ghost" className="size-7" aria-label="Fit to view" onClick={fit}><Maximize /></Button>
        </Tooltip>
      </div>
    </div>
  );
}
