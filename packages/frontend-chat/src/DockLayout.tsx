import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ResizeHandle, cn, useDragDelta } from "@harness/ui";
import { PanelContext } from "./PanelHeader";
import type { DragState } from "./panelDrag";
import {
  DEFAULT_SIZES, ZONES, ZONE_LABEL, clampSize, computeRects, isBottomZone, isLeftZone, isRightZone, withShownIn, zoneOf,
  type Geometry, type Layout, type PanelId, type Rect, type ResizeKind, type Sizes, type Zone,
} from "./panelLayout";

/** A panel the dock keeps mounted. Hidden (not open) panels stay in the tree, so a Terminal shell or a draft survives. */
export type DockPanel = { id: PanelId; label: string; expandable?: boolean; children: ReactNode };

/** Border classes of a panel: the dock draws the lines between its areas. */
function borders(zone: Zone, open: Layout["open"]): string {
  return cn(
    isLeftZone(zone) && "border-r",
    isRightZone(zone) && "border-l",
    isBottomZone(zone) && "border-t",
    zone === "bottomRight" && open.bottomLeft && "border-l",
    ((zone === "leftBottom" && open.leftTop) || (zone === "rightBottom" && open.rightTop)) && "border-t",
  );
}

/** One resize line. Dragging sets `kind` from where it started; double-click resets it. */
function DockHandle({ kind, label, vertical, rect, start, value, onResize }: {
  kind: ResizeKind; label: string; vertical: boolean; rect: Rect; start: () => number; value: (v0: number, dx: number, dy: number) => number; onResize: (patch: Partial<Sizes>) => void;
}) {
  const v0 = useRef(0);
  const onPointerDown = useDragDelta({
    cursor: vertical ? "col-resize" : "row-resize",
    onStart: () => { v0.current = start(); },
    onDelta: (dx, dy) => onResize({ [kind]: value(v0.current, dx, dy) }),
  });
  const T = 6;
  return (
    <ResizeHandle
      label={label}
      orientation={vertical ? "vertical" : "horizontal"}
      style={vertical ? { left: rect.x - T / 2, top: rect.y, width: T, height: rect.h } : { left: rect.x, top: rect.y - T / 2, width: rect.w, height: T }}
      onPointerDown={onPointerDown}
      onDoubleClick={() => onResize({ [kind]: DEFAULT_SIZES[kind] })}
    />
  );
}

/**
 * Lays the chat and the panels out in six zones (ADR 0019). Everything is positioned absolutely from
 * `computeRects` in one box, so a panel moved to another zone keeps its place in the tree and never
 * remounts. Draws the resize lines, and while a panel is dragged, the drop pads and the preview.
 * `layout` is what to draw: only panels that can show count as open.
 */
export function DockLayout({ layout, chat, panels, drag, leftStripeOverlay, onResize, onMove, onHide, onExpand, onDragStart }: {
  layout: Layout;
  chat: ReactNode;
  panels: DockPanel[];
  drag: DragState | null;
  /** The left stripe covers the dock's left edge while dragging (it is empty and otherwise hidden). */
  leftStripeOverlay: boolean;
  onResize: (patch: Partial<Sizes>) => void;
  onMove: (id: PanelId, zone: Zone) => void;
  onHide: (id: PanelId) => void;
  onExpand: (id: PanelId | null) => void;
  onDragStart: (id: PanelId, label: string, e: React.PointerEvent) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = box.current!;
    const measure = () => setSize((s) => (s && s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Escape shrinks the expanded panel.
  const expanded = layout.expanded;
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !e.defaultPrevented && onExpand(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded, onExpand]);

  const w = size?.w ?? 0;
  const h = size?.h ?? 0;
  const g: Geometry = computeRects(layout, w, h);
  const o = layout.open;

  const handles: { kind: ResizeKind; label: string; vertical: boolean; rect: Rect; start: () => number; value: (v0: number, dx: number, dy: number) => number }[] = [];
  if (!expanded && size) {
    const z = g.zones;
    if (o.leftTop || o.leftBottom) handles.push({ kind: "left", label: "Resize left panels", vertical: true, rect: { x: g.left, y: 0, w: 0, h: g.top }, start: () => g.left, value: (v, dx) => clampSize("left", v + dx, g, w, h) });
    if (o.rightTop || o.rightBottom) handles.push({ kind: "right", label: "Resize right panels", vertical: true, rect: { x: w - g.right, y: 0, w: 0, h: g.top }, start: () => g.right, value: (v, dx) => clampSize("right", v - dx, g, w, h) });
    if (o.bottomLeft || o.bottomRight) handles.push({ kind: "bottom", label: "Resize bottom panels", vertical: false, rect: { x: 0, y: g.top, w, h: 0 }, start: () => g.bottom, value: (v, _dx, dy) => clampSize("bottom", v - dy, g, w, h) });
    if (o.leftTop && o.leftBottom) handles.push({ kind: "leftSplit", label: "Split left panels", vertical: false, rect: { x: 0, y: z.leftBottom!.y, w: g.left, h: 0 }, start: () => layout.sizes.leftSplit, value: (v, _dx, dy) => clampSize("leftSplit", v + dy / g.top, g, w, h) });
    if (o.rightTop && o.rightBottom) handles.push({ kind: "rightSplit", label: "Split right panels", vertical: false, rect: { x: w - g.right, y: z.rightBottom!.y, w: g.right, h: 0 }, start: () => layout.sizes.rightSplit, value: (v, _dx, dy) => clampSize("rightSplit", v + dy / g.top, g, w, h) });
    if (o.bottomLeft && o.bottomRight) handles.push({ kind: "bottomSplit", label: "Split bottom panels", vertical: true, rect: { x: z.bottomRight!.x, y: g.top, w: 0, h: g.bottom }, start: () => layout.sizes.bottomSplit, value: (v, dx) => clampSize("bottomSplit", v + dx / w, g, w, h) });
  }

  // While dragging: a pad per zone at the dock's edges, and the blue rect the panel would take.
  const sideH = (h - 150) / 2;
  const lx = leftStripeOverlay ? 56 : 12;
  const pads: { zone: Zone; rect: Rect }[] = [
    { zone: "leftTop", rect: { x: lx, y: 12, w: 84, h: sideH - 6 } },
    { zone: "leftBottom", rect: { x: lx, y: 12 + sideH + 6, w: 84, h: sideH - 6 } },
    { zone: "rightTop", rect: { x: w - 96, y: 12, w: 84, h: sideH - 6 } },
    { zone: "rightBottom", rect: { x: w - 96, y: 12 + sideH + 6, w: 84, h: sideH - 6 } },
    { zone: "bottomLeft", rect: { x: lx, y: h - 108, w: w / 2 - 6 - lx, h: 96 } },
    { zone: "bottomRight", rect: { x: w / 2 + 6, y: h - 108, w: w / 2 - 18, h: 96 } },
  ];
  const previewZone = drag?.target?.zone;
  const preview = drag && previewZone ? computeRects(withShownIn(layout, drag.id, previewZone), w, h).zones[previewZone] : undefined;
  const px = (r: Rect) => ({ left: r.x, top: r.y, width: r.w, height: r.h });

  return (
    <div ref={box} className="relative h-full min-w-0 flex-1 overflow-hidden">
      {size && (
        <>
          <div className="absolute flex flex-col" style={px(g.chat)}>{chat}</div>
          {panels.map((p) => {
            const zone = ZONES.find((z) => o[z] === p.id) ?? null;
            const rect = zone ? g.zones[zone] : undefined;
            const isExpanded = expanded === p.id && !!rect;
            const home = zone ?? zoneOf(layout, p.id) ?? "rightTop";
            return (
              <PanelContext.Provider
                key={p.id}
                value={{
                  id: p.id, zone: home, label: p.label, expandable: !!p.expandable, expanded: isExpanded,
                  onExpand: () => onExpand(isExpanded ? null : p.id), onMove: (z) => onMove(p.id, z), onHide: () => onHide(p.id),
                  onDragStart: (e) => onDragStart(p.id, p.label, e),
                }}
              >
                {isExpanded && <div className="fixed inset-0 z-40 bg-black/50" onClick={() => onExpand(null)} />}
                <section
                  aria-label={p.label}
                  className={cn(
                    "flex flex-col overflow-hidden bg-background",
                    !rect && "hidden",
                    isExpanded ? "fixed inset-x-[3vw] inset-y-[5vh] z-50 rounded-lg border shadow-lg" : cn("absolute", zone && borders(zone, o)),
                  )}
                  style={rect && !isExpanded ? px(rect) : undefined}
                >
                  {p.children}
                </section>
              </PanelContext.Provider>
            );
          })}
          {handles.map((hd) => <DockHandle key={hd.kind} {...hd} onResize={onResize} />)}
          {drag && (
            <>
              {preview && (
                <div aria-hidden className="pointer-events-none absolute z-30 grid place-items-center border-[1.5px] border-blue-500/75 bg-blue-500/15" style={px(preview)}>
                  <span className="rounded bg-background/80 px-2 py-1 text-xs font-semibold">Move {drag.label} to {ZONE_LABEL[previewZone!]}</span>
                </div>
              )}
              {pads.map((pad) => (
                <div
                  key={pad.zone}
                  data-drop-zone={pad.zone}
                  className={cn(
                    "absolute z-[35] grid place-items-center rounded-lg border-[1.5px] border-dashed text-center text-[11px] font-semibold",
                    previewZone === pad.zone ? "border-blue-500 bg-blue-500/25" : "border-blue-500/45 bg-background/60",
                  )}
                  style={px(pad.rect)}
                >
                  {ZONE_LABEL[pad.zone]}
                </div>
              ))}
            </>
          )}
        </>
      )}
    </div>
  );
}
