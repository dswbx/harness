import { cn } from "@harness/ui";
import { X } from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useRef } from "react";
import type { FileTab } from "./fileTabs";

/** How far the pointer moves before a press on a tab becomes a drag. */
const DRAG_PX = 4;

/**
 * The Files panel's tabs: click shows, double-click pins (a preview tab is in italics), middle-click or × closes,
 * dragging a tab sideways moves it (`onMove`: the tab's new index).
 */
export function FileTabStrip({
   tabs,
   active,
   onShow,
   onPin,
   onClose,
   onMove,
}: {
   tabs: FileTab[];
   active: string | null;
   onShow: (path: string) => void;
   onPin: (path: string) => void;
   onClose: (path: string) => void;
   onMove: (path: string, to: number) => void;
}) {
   const strip = useRef<HTMLDivElement>(null);
   /** A drag just ended: the click that follows it is not a click on the tab. */
   const dragged = useRef(false);

   const press = (e: ReactPointerEvent, path: string) => {
      if (e.button !== 0 || (e.target as Element).closest("[data-tab-close]")) return;
      // The panel header would start dragging the whole panel.
      e.stopPropagation();
      const x0 = e.clientX;
      let moving = false;
      dragged.current = false;
      const move = (m: PointerEvent) => {
         if (!moving && Math.abs(m.clientX - x0) < DRAG_PX) return;
         moving = true;
         dragged.current = true;
         const others = [
            ...(strip.current?.querySelectorAll<HTMLElement>("[data-tab]") ?? []),
         ].filter((el) => el.dataset.tab !== path);
         const to = others.filter((el) => {
            const r = el.getBoundingClientRect();
            return r.left + r.width / 2 < m.clientX;
         }).length;
         onMove(path, to);
      };
      const up = () => {
         window.removeEventListener("pointermove", move);
         window.removeEventListener("pointerup", up);
         window.removeEventListener("pointercancel", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
   };

   return (
      <div
         ref={strip}
         role="tablist"
         aria-label="Open files"
         className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]"
      >
         {tabs.map((t) => {
            const on = t.path === active;
            const name = t.path.slice(t.path.lastIndexOf("/") + 1);
            return (
               <div
                  key={t.path}
                  data-tab={t.path}
                  className={cn(
                     "flex h-[26px] max-w-[170px] shrink-0 items-center gap-1 rounded-md pl-2.5 pr-[3px] text-xs",
                     on
                        ? "bg-accent text-accent-foreground"
                        : "text-muted-foreground hover:bg-accent/50",
                  )}
                  onPointerDown={(e) => press(e, t.path)}
                  onAuxClick={(e) => e.button === 1 && onClose(t.path)}
               >
                  <button
                     type="button"
                     role="tab"
                     aria-selected={on}
                     aria-label={t.pinned ? t.path : `${t.path} (preview)`}
                     className={cn("min-w-0 truncate", !t.pinned && "italic")}
                     ref={on ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
                     onClick={() => {
                        if (dragged.current) dragged.current = false;
                        else if (!on) onShow(t.path);
                     }}
                     onDoubleClick={() => onPin(t.path)}
                  >
                     {name}
                  </button>
                  <button
                     type="button"
                     data-tab-close
                     className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-background/60 hover:text-accent-foreground"
                     aria-label={`Close ${name}`}
                     onClick={() => onClose(t.path)}
                  >
                     <X className="size-3" />
                  </button>
               </div>
            );
         })}
      </div>
   );
}
