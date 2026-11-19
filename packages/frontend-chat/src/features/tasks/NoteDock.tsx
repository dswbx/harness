import { type SessionApi, storedNumber } from "@harness/api";
import { clamp, ResizeHandle, useDragDelta } from "@harness/ui";
import { useRef, useState } from "react";
import { NoteEditor } from "./NoteEditor";

const heightStore = storedNumber("harness:tasks-note-height");
const DEFAULT_HEIGHT = 300;
const MIN_HEIGHT = 120;
/** Room kept for the panel header and the task list above the note. */
const LIST_ROOM = 112;

/**
 * The Session Note docked at the bottom of the Tasks & Notes panel, like the commits pane of Changes: drag its top
 * edge to resize (double-click resets), remembered per window. The task list above takes the rest and scrolls.
 */
export function NoteDock({ api }: { api: SessionApi }) {
   const [height, setHeight] = useState(() => heightStore.get() || DEFAULT_HEIGHT);
   const box = useRef<HTMLDivElement>(null);
   const drag = useRef({ start: height, last: height, max: Number.POSITIVE_INFINITY });
   const onPointerDown = useDragDelta({
      cursor: "row-resize",
      onStart: () => {
         const el = box.current;
         const start = el?.offsetHeight || height;
         // Not laid out (no height): the CSS max height still keeps room for the list.
         const panel = el?.parentElement?.clientHeight || Number.POSITIVE_INFINITY;
         const room = panel - LIST_ROOM;
         drag.current = { start, last: start, max: Math.max(MIN_HEIGHT, room) };
      },
      onDelta: (_, dy) => {
         const d = drag.current;
         d.last = clamp(d.start - dy, MIN_HEIGHT, d.max);
         setHeight(d.last);
      },
      onEnd: () => void heightStore.set(drag.current.last),
   });
   return (
      <div
         ref={box}
         className="relative flex max-h-[calc(100%-7rem)] min-h-0 shrink-0 flex-col border-t"
         style={{ height }}
      >
         <ResizeHandle
            label="Resize session note"
            orientation="horizontal"
            style={{ left: 0, right: 0, top: -4, height: 8 }}
            onPointerDown={onPointerDown}
            onDoubleClick={() => {
               setHeight(DEFAULT_HEIGHT);
               heightStore.set(DEFAULT_HEIGHT);
            }}
         />
         <NoteEditor key={api.sessionId} api={api} />
      </div>
   );
}
