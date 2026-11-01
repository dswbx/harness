import { Fragment, type PointerEvent, type ReactNode } from "react";
import { Button, Tooltip, cn } from "@harness/ui";
import type { DragState } from "./panelDrag";
import { ZONE_LABEL, type PanelId, type Zone } from "./panelLayout";

export type StripeItem = {
  id: PanelId;
  /** Position in its zone's full list (stripes show only the panels that exist), for drops. */
  index: number;
  label: string;
  tip: string;
  icon: ReactNode;
  on: boolean;
  /** Changed while it was closed. */
  dot: boolean;
};

/** Zones of a stripe, top to bottom: upper, lower, then the bottom corner (after the spacer). */
export type StripeGroup = { zone: Zone; items: StripeItem[] };

/**
 * A stripe of panel icons along the left or right edge: two side zones, a separator, and the bottom zone
 * at the foot. Click toggles a panel; dragging an icon moves it (a dashed slot shows where it lands).
 * `overlay`: the stripe is empty and hidden except while dragging, then it covers the edge as a drop target.
 */
export function Stripe({ side, groups, drag, overlay, onToggle, onPress }: {
  side: "left" | "right";
  groups: [StripeGroup, StripeGroup, StripeGroup];
  drag: DragState | null;
  overlay?: boolean;
  onToggle: (id: PanelId) => void;
  onPress: (item: StripeItem, e: PointerEvent) => void;
}) {
  const group = (g: StripeGroup) => {
    const hot = drag?.target?.zone === g.zone;
    const at = hot ? (drag.target!.index ?? Infinity) : -1;
    const marker = <div key="slot" aria-hidden className="size-8 shrink-0 rounded-md border-[1.5px] border-dashed border-blue-500 bg-blue-500/15" />;
    // The dashed slot goes before the first icon at or after the insert index.
    const before = g.items.findIndex((i) => i.index >= at);
    const slotAt = !hot ? -1 : before < 0 ? g.items.length : before;
    return (
      <div
        data-drop-zone={g.zone}
        role="group"
        aria-label={ZONE_LABEL[g.zone]}
        className={cn(
          "flex w-9 flex-col items-center gap-1 rounded-lg py-0.5",
          drag && "min-h-9 outline-1 outline-dashed outline-border",
          hot && "bg-blue-500/10 outline-blue-500/70",
        )}
      >
        {g.items.map((it, i) => (
          <Fragment key={it.id}>
            {i === slotAt && marker}
            <Tooltip content={it.tip} side={side === "left" ? "right" : "left"} className={drag ? "hidden" : undefined}>
              <Button
                size="icon"
                variant="ghost"
                data-drop-index={it.index}
                className={cn(
                  "relative size-8 touch-none text-muted-foreground hover:text-accent-foreground",
                  it.on && "bg-accent text-accent-foreground",
                  drag?.id === it.id && "opacity-35",
                )}
                aria-label={it.label}
                aria-pressed={it.on}
                onPointerDown={(e) => onPress(it, e)}
                onClick={() => onToggle(it.id)}
              >
                {it.icon}
                {it.dot && <span className="absolute right-1 top-1 size-1.5 rounded-full bg-primary" />}
              </Button>
            </Tooltip>
          </Fragment>
        ))}
        {slotAt === g.items.length && marker}
      </div>
    );
  };
  return (
    <nav
      aria-label={side === "left" ? "Left panels" : "Right panels"}
      className={cn(
        "flex w-11 shrink-0 flex-col items-center bg-background py-2",
        side === "left" ? "border-r" : "border-l",
        overlay && "absolute inset-y-0 left-0 z-40",
      )}
    >
      {group(groups[0])}
      {/* Only between two filled zones (and while dragging, to tell the two drop targets apart). */}
      {(drag || (groups[0].items.length > 0 && groups[1].items.length > 0)) && <div className="my-1.5 h-px w-5 shrink-0 bg-border" />}
      {group(groups[1])}
      <div className="flex-1" />
      {group(groups[2])}
    </nav>
  );
}
