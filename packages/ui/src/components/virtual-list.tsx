import * as React from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
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

/** Windowed list with dynamic row heights and stick-to-bottom while streaming. */
export function VirtualList({
  count, getKey, renderRow, estimateSize = 80, gap = 0, className, scrollbarClassName, innerClassName, empty, footer, stickToBottom = true, overscan = 8, handle,
}: Props) {
  const scroller = React.useRef<HTMLDivElement>(null);
  const stick = React.useRef(stickToBottom);
  const v = useVirtualizer({
    count,
    getScrollElement: () => scroller.current,
    estimateSize: () => estimateSize,
    getItemKey: getKey,
    overscan,
    paddingStart: 16,
  });
  const total = v.getTotalSize();

  React.useImperativeHandle(handle, () => ({
    scrollToKey(key) {
      for (let i = 0; i < count; i++) {
        if (getKey(i) !== key) continue;
        // Jumping away from the bottom stops following it.
        stick.current = false;
        v.scrollToIndex(i, { align: "center" });
        return true;
      }
      return false;
    },
  }), [count, getKey, v]);

  // Re-enabling follow mode jumps back to the bottom.
  React.useLayoutEffect(() => {
    stick.current = stickToBottom;
  }, [stickToBottom]);

  // Follow the bottom as rows are added or grow (streaming), unless the user scrolled up.
  React.useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [total, count, footer, stickToBottom]);

  return (
    <ScrollArea
      viewportRef={scroller}
      className={cn("min-h-0 flex-1", className)}
      scrollbarClassName={scrollbarClassName}
      onViewportScroll={(e) => {
        if (!stickToBottom) return;
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      <div className={innerClassName}>
        {count === 0 ? (
          empty
        ) : (
          <div style={{ height: total, position: "relative" }}>
            {v.getVirtualItems().map((row) => (
              <div
                key={row.key}
                data-index={row.index}
                data-key={String(row.key)}
                ref={v.measureElement}
                style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${row.start}px)`, paddingBottom: gap }}
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
