import { useVirtualizer } from "@tanstack/react-virtual";
import * as React from "react";
import { cn } from "../lib/utils";
import { ScrollArea } from "./scroll-area";

type Props = {
   count: number;
   getKey: (index: number) => React.Key;
   renderRow: (index: number) => React.ReactNode;
   /** Initial height guess per row; rows are measured after render. */
   estimateSize?: number;
   /** Space below each row, in px (part of the measured row). */
   gap?: number;
   /** Scroll container classes. */
   className?: string;
   /** Scrollbar classes (e.g. to lift it over a bar that overlays the list). */
   scrollbarClassName?: string;
   /** Wrapper around rows and footer (e.g. a centered max-width column). */
   innerClassName?: string;
   /** Rendered instead of rows when `count` is 0. */
   empty?: React.ReactNode;
   /** Space above the first row, in px. */
   paddingStart?: number;
   /** Rendered after the last row (inside the scroll area). */
   footer?: React.ReactNode;
   /** Keep the bottom in view while content grows, until the user scrolls up. Default true. */
   stickToBottom?: boolean;
   /** Rows rendered outside the viewport on each side. */
   overscan?: number;
   /** Scrolls a row into view by key (it renders with `data-key`), e.g. to jump to a message. */
   handle?: React.Ref<VirtualListHandle>;
};

export type VirtualListHandle = { scrollToKey: (key: React.Key) => boolean };

const noAdjust = () => false;

/** Windowed list with dynamic row heights and stick-to-bottom while streaming. */
export function VirtualList({
   count,
   getKey,
   renderRow,
   estimateSize = 80,
   gap = 0,
   className,
   scrollbarClassName,
   innerClassName,
   empty,
   footer,
   stickToBottom = true,
   overscan = 8,
   handle,
   paddingStart = 16,
}: Props) {
   const scroller = React.useRef<HTMLDivElement>(null);
   const stick = React.useRef(stickToBottom);
   // Time of the last user scroll input (wheel, touch, key) and whether a pointer is down (scrollbar
   // drag, text selection). Only these may stop following the bottom.
   const userInput = React.useRef(0);
   const pointerDown = React.useRef(false);
   const v = useVirtualizer({
      count,
      getScrollElement: () => scroller.current,
      estimateSize: () => estimateSize,
      getItemKey: getKey,
      overscan,
      paddingStart,
   });
   // While following the bottom, the effects below pin it. The virtualizer's own shift for a resized row
   // starts from its cached offset, which is stale after we set scrollTop, and can leave the view short of
   // the bottom. Not following: the library default.
   v.shouldAdjustScrollPositionOnItemSizeChange = stick.current ? noAdjust : undefined;
   const setStick = React.useCallback(
      (on: boolean) => {
         stick.current = on;
         v.shouldAdjustScrollPositionOnItemSizeChange = on ? noAdjust : undefined;
      },
      [v],
   );
   const total = v.getTotalSize();
   const items = v.getVirtualItems();

   React.useImperativeHandle(
      handle,
      () => ({
         scrollToKey(key) {
            for (let i = 0; i < count; i++) {
               if (getKey(i) !== key) continue;
               // Jumping away from the bottom stops following it.
               setStick(false);
               v.scrollToIndex(i, { align: "center" });
               return true;
            }
            return false;
         },
      }),
      [count, getKey, v, setStick],
   );

   // Re-enabling follow mode jumps back to the bottom.
   React.useLayoutEffect(() => {
      setStick(stickToBottom);
   }, [stickToBottom, setStick]);

   // Follow the bottom as rows are added or grow (streaming), unless the user scrolled up.
   React.useLayoutEffect(() => {
      const el = scroller.current;
      if (el && stick.current) el.scrollTop = el.scrollHeight;
   }, [total, count, footer, stickToBottom]);

   // Keep the bottom when the viewport changes size (window resize, a panel or terminal that opens
   // after the Session view mounts).
   React.useLayoutEffect(() => {
      const el = scroller.current;
      if (!el) return;
      const ro = new ResizeObserver(() => {
         if (stick.current) el.scrollTop = el.scrollHeight;
      });
      ro.observe(el);
      const up = () => {
         pointerDown.current = false;
      };
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
      return () => {
         ro.disconnect();
         window.removeEventListener("pointerup", up);
         window.removeEventListener("pointercancel", up);
      };
   }, []);

   const noteInput = () => {
      userInput.current = performance.now();
   };

   return (
      <ScrollArea
         viewportRef={scroller}
         className={cn("min-h-0 flex-1", className)}
         scrollbarClassName={scrollbarClassName}
         onWheel={noteInput}
         onTouchMove={noteInput}
         onKeyDown={noteInput}
         onPointerDown={() => {
            pointerDown.current = true;
         }}
         onViewportScroll={(e) => {
            if (!stickToBottom) return;
            const el = e.currentTarget;
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            if (atBottom) return setStick(true);
            // A scroll the user did not make (layout change, clamping, a late row measure) never stops
            // following: put the bottom back in view.
            const byUser = pointerDown.current || performance.now() - userInput.current < 1500;
            if (byUser) setStick(false);
            else if (stick.current) el.scrollTop = el.scrollHeight;
         }}
      >
         <div className={innerClassName}>
            {count === 0 ? (
               empty
            ) : (
               // Rows in normal flow between two spacers, not absolutely placed: a row that grows (an opening
               // collapsible) pushes the rows below in the same frame, instead of overlapping them until it is
               // measured again.
               <div
                  style={{
                     paddingTop: items[0]?.start ?? 0,
                     paddingBottom: Math.max(0, total - (items.at(-1)?.end ?? 0)),
                  }}
               >
                  {items.map((row) => (
                     <div
                        key={row.key}
                        data-index={row.index}
                        data-key={String(row.key)}
                        ref={v.measureElement}
                        style={{ paddingBottom: gap }}
                     >
                        {renderRow(row.index)}
                     </div>
                  ))}
               </div>
            )}
            {footer}
         </div>
      </ScrollArea>
   );
}
