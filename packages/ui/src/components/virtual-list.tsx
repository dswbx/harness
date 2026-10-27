import * as React from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "../lib/utils";

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
};

/** Windowed list with dynamic row heights and stick-to-bottom while streaming. */
export function VirtualList({
  count, getKey, renderRow, estimateSize = 80, gap = 0, className, innerClassName, empty, footer, stickToBottom = true, overscan = 8,
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
    <div
      ref={scroller}
      className={cn("min-h-0 flex-1 overflow-auto", className)}
      onScroll={(e) => {
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
    </div>
  );
}
