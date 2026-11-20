import { storedNumber, type TaskSummary } from "@harness/api";
import { clamp, useDragDelta } from "@harness/ui";
import { type RefObject, useLayoutEffect, useRef, useState } from "react";
import type { PanelCtx } from "../../panels/contract";
import { TaskDetail } from "./TaskDetail";
import type { TaskApi } from "./taskApi";

/** The sheet height the user picked (0: half of the space it sits in). Per window. */
const heightStore = storedNumber("harness.tasks.sheetHeight");
const SHEET_MIN = 160;
/** Room always left above the sheet for the tasks, plus the sheet's bottom margin. */
const SHEET_ROOM = 120 + 8;
/** Arrow keys on the handle resize by this much. */
const STEP = 16;
/** The height while the space is not laid out yet (no size). */
const FALLBACK = 320;

/**
 * The height of `ref`, kept current; 0 until it is laid out. The panel measures the sheet's space before the sheet
 * opens, so the sheet gets its height in its first render (and the open task scrolls into view above it).
 */
export function useHeight(ref: RefObject<HTMLElement | null>): number {
   const [height, setHeight] = useState(0);
   useLayoutEffect(() => {
      const el = ref.current;
      if (!el) return;
      const read = () => setHeight(el.clientHeight);
      read();
      if (typeof ResizeObserver === "undefined") return;
      const ro = new ResizeObserver(read);
      ro.observe(el);
      return () => ro.disconnect();
   }, [ref]);
   return height;
}

/**
 * The Tasks & Notes panel's task sheet (board "PanelTaskOpen"): the task in full on a card at the bottom of the
 * tasks area, above the note bar. The tasks above end at its top, so each stays reachable. Drag its handle (or
 * ArrowUp/ArrowDown on it) to resize; double-click resets to half the space. The height is kept per window and
 * clamped to the space: at least `SHEET_MIN`, and always `SHEET_ROOM` left for the tasks.
 */
export function TaskSheet({
   api,
   id,
   tasks,
   host,
   room,
   onClose,
   onOpen,
}: {
   api: TaskApi;
   id: string;
   tasks: readonly TaskSummary[] | null;
   host: PanelCtx["host"];
   /** The height of the space the sheet sits in (`useHeight`); 0: not laid out. */
   room: number;
   onClose: () => void;
   onOpen: (id: string) => void;
}) {
   const [want, setWant] = useState(() => heightStore.get());
   const max = room ? Math.max(SHEET_MIN, room - SHEET_ROOM) : Number.POSITIVE_INFINITY;
   const height = Math.round(clamp(want || (room ? room / 2 : FALLBACK), SHEET_MIN, max));
   const resize = (h: number) => {
      const next = Math.round(clamp(h, SHEET_MIN, max));
      setWant(next);
      heightStore.set(next);
   };

   const drag = useRef({ start: height, last: height });
   const onPointerDown = useDragDelta({
      cursor: "row-resize",
      onStart: () => {
         drag.current = { start: height, last: height };
      },
      onDelta: (_, dy) => {
         const d = drag.current;
         d.last = Math.round(clamp(d.start - dy, SHEET_MIN, max));
         setWant(d.last);
      },
      onEnd: () => void heightStore.set(drag.current.last),
   });

   return (
      <section
         aria-label="Task"
         data-task-sheet
         className="mx-2 mb-2 flex shrink-0 flex-col overflow-hidden rounded-xl border bg-card shadow-[0_-8px_24px_-6px_rgb(0_0_0/0.18),0_2px_8px_rgb(0_0_0/0.08)] dark:shadow-[0_-12px_32px_rgb(0_0_0/0.45),0_2px_8px_rgb(0_0_0/0.4)]"
         style={{ height }}
      >
         <div
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize task"
            aria-valuenow={height}
            aria-valuemin={SHEET_MIN}
            aria-valuemax={Number.isFinite(max) ? max : undefined}
            tabIndex={0}
            className="group/handle flex h-3 shrink-0 cursor-row-resize touch-none items-center justify-center outline-none"
            onPointerDown={onPointerDown}
            onDoubleClick={() => {
               setWant(0);
               heightStore.remove();
            }}
            onKeyDown={(e) => {
               if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
               e.preventDefault();
               resize(height + (e.key === "ArrowUp" ? STEP : -STEP));
            }}
         >
            <span className="h-1 w-8 rounded-full bg-muted-foreground/30 transition-colors group-hover/handle:bg-muted-foreground/60 group-focus-visible/handle:bg-ring" />
         </div>
         <TaskDetail
            key={id}
            api={api}
            id={id}
            tasks={tasks}
            host={host}
            sessions={host.sessions}
            onClose={onClose}
            onOpen={onOpen}
         />
      </section>
   );
}
