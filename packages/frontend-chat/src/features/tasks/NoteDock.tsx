import {
   codec,
   onOffText,
   type SessionApi,
   storedNumber,
   storedValue,
   useNote,
   useStoredValue,
} from "@harness/api";
import { clamp, ResizeHandle, useDragDelta } from "@harness/ui";
import { ChevronRight } from "lucide-react";
import { useRef, useState } from "react";
import { NoteEditor } from "./NoteEditor";

const heightStore = storedNumber("harness:tasks-note-height");
/** Open or folded, per window; null until the user toggles it (then: open when the note has text). */
const openStore = storedValue<boolean | null>({
   key: "harness.tasks.noteOpen",
   scope: "app",
   parse: (raw) => (raw === null ? null : codec.onOff(true)(raw)),
   serialize: (v) => onOffText(v ?? true),
   sync: false,
});
const DEFAULT_HEIGHT = 300;
const MIN_HEIGHT = 120;
/** Room kept for the panel header and the task list above the note. */
const LIST_ROOM = 112;

/** The note's first line with text, as plain text (Markdown marks dropped); "" when it has none. */
function firstLine(markdown: string): string {
   for (const raw of markdown.split("\n")) {
      const line = raw
         .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|>\s*)/, "")
         .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
         .replace(/\*+|`+|~~/g, "")
         .trim();
      if (line) return line;
   }
   return "";
}

/**
 * The Session Note, always the last row of the Tasks & Notes panel (boards "PanelNoteCollapsed", "PanelNoteOpen").
 * Folded, a bar with its first line. Open, docked like the commits pane of Changes: drag its top edge to resize
 * (double-click resets). Open or folded and the height are kept per window. A task open in the panel's sheet folds
 * it (`taskOpen`) without changing the kept state; opening the note then calls `onOpenNote` (the sheet closes).
 */
export function NoteDock({
   api,
   taskOpen,
   onOpenNote,
}: {
   api: SessionApi;
   taskOpen: boolean;
   onOpenNote: () => void;
}) {
   const [note] = useNote(api);
   const line = firstLine(note?.content ?? "");
   const stored = useStoredValue(openStore);
   const open = !taskOpen && (stored ?? line !== "");
   const toggle = () => {
      openStore.set(!open);
      if (!open && taskOpen) onOpenNote();
   };
   if (!open)
      return (
         <button
            type="button"
            aria-expanded={false}
            onClick={toggle}
            className="flex h-9 w-full shrink-0 items-center gap-2 border-t px-3.5 text-left text-xs text-muted-foreground outline-none hover:bg-accent/40 focus-visible:bg-accent/40"
         >
            <ChevronRight className="size-3 shrink-0" />
            <span className="shrink-0 font-medium text-foreground">Session note</span>
            <span className="min-w-0 flex-1 truncate">{line}</span>
            {note?.updated_ms != null && <span className="shrink-0 text-[11px]">Saved</span>}
         </button>
      );
   return <OpenNote api={api} onCollapse={toggle} />;
}

function OpenNote({ api, onCollapse }: { api: SessionApi; onCollapse: () => void }) {
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
         <NoteEditor key={api.sessionId} api={api} onCollapse={onCollapse} />
      </div>
   );
}
