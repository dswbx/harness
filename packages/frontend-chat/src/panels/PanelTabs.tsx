import { cn } from "@harness/ui";
import { X } from "lucide-react";
import {
   type ReactNode,
   type PointerEvent as ReactPointerEvent,
   useLayoutEffect,
   useRef,
} from "react";

/** How far the pointer moves before a press on a tab becomes a drag. */
const DRAG_PX = 4;

export type PanelTab<Id extends string | number = string> = {
   id: Id;
   /** Plain name: the tab's text and its close button's label. */
   name: string;
   /** Shown in place of `name`. */
   label?: ReactNode;
   /** The tab button's accessible name (default `name`). */
   ariaLabel?: string;
   /** On the tab (e.g. a bold title for unread). */
   className?: string;
   /** On the label (e.g. italic for a preview tab). */
   labelClassName?: string;
   /** After the label: status dots. */
   after?: ReactNode;
   onDoubleClick?: () => void;
};

/**
 * The tabs in a panel header (side chats, files, terminals). They scroll sideways with no scrollbar (the
 * wheel scrolls them too) and reach the header's left edge, so a scrolled tab goes under the panel's border,
 * not the header's padding. Click selects, × or middle-click closes, dragging a tab sideways moves it
 * (`onMove`: in front of tab `before`, null: to the end). `children` (a "new" button) follow the last tab,
 * outside the scrolling, so they stay in view. The strip takes only the room its tabs need: put a spacer after
 * it to push later controls to the right.
 */
export function PanelTabs<Id extends string | number = string>({
   tabs,
   active,
   label,
   onSelect,
   onClose,
   onMove,
   children,
}: {
   tabs: PanelTab<Id>[];
   active: Id | null;
   /** The tablist's accessible name. */
   label: string;
   onSelect: (id: Id) => void;
   onClose: (id: Id) => void;
   onMove?: (id: Id, before: Id | null) => void;
   children?: ReactNode;
}) {
   const strip = useRef<HTMLDivElement>(null);
   /** A drag just ended: the click that follows it is not a click on the tab. */
   const dragged = useRef(false);

   // The active tab shows in full: when it changes, and when any tab or the strip changes size (a title
   // arriving, a status dot coming or going, the panel resized). Only the strip scrolls, never the panel.
   const order = tabs.map((t) => t.id).join("\n");
   // biome-ignore lint/correctness/useExhaustiveDependencies: `order`: a tab added or moved shifts the active one.
   useLayoutEffect(() => {
      const s = strip.current;
      const tab =
         active === null
            ? null
            : s?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(String(active))}"]`);
      if (!s || !tab) return;
      const reveal = () => {
         const pad = Number.parseFloat(getComputedStyle(s).paddingLeft) || 0;
         // The strip is the tab's offset parent (`relative`): its own content coordinates.
         const left = tab.offsetLeft;
         const right = left + tab.offsetWidth;
         if (left - pad < s.scrollLeft) s.scrollLeft = left - pad;
         else if (right > s.scrollLeft + s.clientWidth) s.scrollLeft = right - s.clientWidth;
      };
      reveal();
      const ro = new ResizeObserver(reveal);
      ro.observe(s);
      for (const el of s.querySelectorAll("[data-tab]")) ro.observe(el);
      return () => ro.disconnect();
   }, [active, order]);

   const press = (e: ReactPointerEvent, id: Id) => {
      if (!onMove || e.button !== 0 || (e.target as Element).closest("[data-tab-close]")) return;
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
         ].filter((el) => el.dataset.tab !== String(id));
         const before = others.find((el) => {
            const r = el.getBoundingClientRect();
            return r.left + r.width / 2 >= m.clientX;
         });
         onMove(id, tabs.find((t) => String(t.id) === before?.dataset.tab)?.id ?? null);
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
      <>
         <div
            ref={strip}
            role="tablist"
            aria-label={label}
            // Out to the header's left edge (its `pl-2.5`), with the same padding inside.
            className="relative -ml-2.5 flex min-w-0 items-center gap-1 self-stretch overflow-x-auto overscroll-x-none pl-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            onWheel={(e) => {
               const el = e.currentTarget;
               if (e.deltaX === 0 && e.deltaY !== 0 && el.scrollWidth > el.clientWidth)
                  el.scrollLeft += e.deltaY;
            }}
         >
            {tabs.map((t) => {
               const on = t.id === active;
               return (
                  <div
                     key={t.id}
                     data-tab={t.id}
                     className={cn(
                        "flex h-[26px] max-w-[170px] shrink-0 items-center gap-1 rounded-md pl-2.5 pr-[3px] text-xs",
                        on
                           ? "bg-accent text-accent-foreground"
                           : "text-muted-foreground hover:bg-accent/50",
                        t.className,
                     )}
                     onPointerDown={(e) => press(e, t.id)}
                     onAuxClick={(e) => e.button === 1 && onClose(t.id)}
                  >
                     <button
                        type="button"
                        role="tab"
                        aria-selected={on}
                        aria-label={t.ariaLabel}
                        className={cn("min-w-0 truncate", t.labelClassName)}
                        onClick={() => {
                           if (dragged.current) dragged.current = false;
                           else if (!on) onSelect(t.id);
                        }}
                        onDoubleClick={t.onDoubleClick}
                     >
                        {t.label ?? t.name}
                     </button>
                     {t.after}
                     <button
                        type="button"
                        data-tab-close
                        className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-background/60 hover:text-accent-foreground"
                        aria-label={`Close ${t.name}`}
                        onClick={() => onClose(t.id)}
                     >
                        <X className="size-3" />
                     </button>
                  </div>
               );
            })}
         </div>
         {children}
      </>
   );
}
