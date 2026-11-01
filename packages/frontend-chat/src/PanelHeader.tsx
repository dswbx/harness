import { createContext, useContext, type PointerEvent, type ReactNode } from "react";
import { Check, Maximize2, Minimize2, Minus, MoreVertical, MoveUpRight } from "lucide-react";
import {
  Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent,
  DropdownMenuSubTrigger, DropdownMenuTrigger, Tooltip, cn,
} from "@harness/ui";
import { ZONES, ZONE_LABEL, type PanelId, type Zone } from "./panelLayout";

/** What the dock tells the panel it is in, for its header: where it sits and what the header can do. */
export type PanelCtx = {
  id: PanelId;
  zone: Zone;
  label: string;
  /** Offers Expand in the menu. */
  expandable: boolean;
  expanded: boolean;
  onExpand: () => void;
  onMove: (zone: Zone) => void;
  onHide: () => void;
  /** Pointer down on the header: drags the panel to another zone. */
  onDragStart: (e: PointerEvent) => void;
};

export const PanelContext = createContext<PanelCtx | null>(null);

/**
 * The header every panel shares: `title`, the panel's own controls (`children`), a menu (Expand, Move to,
 * Hide) and the hide button. Dragging the header drags the panel to another zone.
 */
export function PanelHeader({ title, titleHint, children, className }: { title?: ReactNode; titleHint?: string; children?: ReactNode; className?: string }) {
  const p = useContext(PanelContext);
  return (
    <div
      className={cn("flex shrink-0 items-center gap-1.5 border-b py-2 pr-2 pl-3", className)}
      onPointerDown={(e) => !p?.expanded && !(e.target as Element).closest("button, input, select, a, label, [role=tab]") && p?.onDragStart(e)}
    >
      {title != null && <span className="min-w-0 truncate text-sm font-medium" title={titleHint}>{title}</span>}
      {children}
      {p && (
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost" className="size-7 data-[state=open]:bg-accent" aria-label={`${p.label} options`}>
                <MoreVertical />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {p.expandable && (
                <>
                  <DropdownMenuItem onSelect={p.onExpand}>
                    {p.expanded ? <Minimize2 /> : <Maximize2 />} {p.expanded ? "Collapse" : "Expand"}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuSub>
                <DropdownMenuSubTrigger><MoveUpRight /> Move to</DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-44">
                  {ZONES.map((z) => (
                    <DropdownMenuItem key={z} onSelect={() => z !== p.zone && p.onMove(z)}>
                      {ZONE_LABEL[z]}
                      {z === p.zone && <Check className="ml-auto" />}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={p.onHide}><Minus /> Hide</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Tooltip content="Hide" side="bottom">
            <Button size="icon" variant="ghost" className="size-7" aria-label={`Hide ${p.label}`} onClick={p.onHide}>
              <Minus />
            </Button>
          </Tooltip>
        </div>
      )}
    </div>
  );
}
