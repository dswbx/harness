import { type AttachmentInput, errText } from "@harness/api";
import { type DragEvent, type RefObject, useEffect, useRef, useState } from "react";
import { registerDropZone } from "../prompt/fileDropTargets";
import { filesToInputs } from "./AssetStrip";

const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes("Files");

/**
 * Files dropped on `ref` go to `onAdd`, not to a prompt box: HTML5 drops (browser) through the returned handlers,
 * window path drops (Tauri) through the drop zone registry. `over`: files are dragged over it.
 */
export function useFileDrop(
   ref: RefObject<HTMLElement | null>,
   onAdd: (files: AttachmentInput[]) => void,
   onError: (message: string) => void,
) {
   const [over, setOver] = useState(false);
   const depth = useRef(0);
   const latest = useRef({ onAdd, onError });
   latest.current = { onAdd, onError };

   useEffect(
      () =>
         registerDropZone({
            el: () => ref.current,
            over: setOver,
            drop: (paths) => latest.current.onAdd(paths.map((path) => ({ type: "path", path }))),
         }),
      [ref],
   );

   const handlers = {
      onDragEnter: (e: DragEvent) => {
         if (!hasFiles(e)) return;
         depth.current++;
         setOver(true);
      },
      onDragLeave: (e: DragEvent) => {
         if (!hasFiles(e)) return;
         depth.current = Math.max(0, depth.current - 1);
         if (depth.current === 0) setOver(false);
      },
      onDragOver: (e: DragEvent) => {
         if (hasFiles(e)) e.preventDefault();
      },
      onDrop: (e: DragEvent) => {
         depth.current = 0;
         setOver(false);
         const list = [...e.dataTransfer.files];
         if (!list.length) return;
         e.preventDefault();
         e.stopPropagation();
         filesToInputs(list).then(
            (files) => latest.current.onAdd(files),
            (err) => latest.current.onError(errText(err)),
         );
      },
   };
   return { over, handlers };
}
