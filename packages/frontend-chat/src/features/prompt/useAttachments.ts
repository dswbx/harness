import { pickFiles, type SessionApi } from "@harness/api";
import {
   type ChangeEvent,
   type ClipboardEvent,
   type DragEvent,
   type RefObject,
   useEffect,
   useRef,
   useState,
} from "react";
import { errorMessage } from "../../lib/errors";
import type { ChatState } from "../../state/reducer";
import { fromFile, fromPickedPath, type PendingAttachment } from "./attachments";
import { useDraftAttachments } from "./drafts";
import { registerDropTarget } from "./fileDropTargets";

/**
 * The files and images waiting to be sent from the composer `key`: added from the file picker, a paste,
 * an HTML5 drop or (in Tauri) a path drop on `boxRef`. `caps`: what the Agent accepts. `setError`
 * shows why something was refused.
 */
export function useAttachments({
   key,
   api,
   caps,
   boxRef,
   main,
   setError,
}: {
   key: string;
   api: SessionApi;
   caps: ChatState["promptCaps"];
   boxRef: RefObject<HTMLDivElement | null>;
   /** The box of the Main Thread (a Side Thread's box is not). */
   main: boolean;
   setError: (message: string | null) => void;
}) {
   const [attachments, setAttachments] = useDraftAttachments(key);
   const [dragging, setDragging] = useState(false);
   const fileInput = useRef<HTMLInputElement>(null);

   const addAttachments = (items: PendingAttachment[]) => {
      if (caps && !caps.image && items.some((a) => a.kind === "image")) {
         setError("This Agent does not accept images.");
         items = items.filter((a) => a.kind !== "image");
      }
      if (items.length) setAttachments((cur) => [...cur, ...items]);
   };
   const addFiles = (files: File[]) => {
      Promise.all(files.map(fromFile)).then(addAttachments, (err) => setError(errorMessage(err)));
   };
   const addPaths = (paths: string[]) => {
      Promise.all(paths.map((p) => fromPickedPath(p, api.readImageFile))).then(
         addAttachments,
         (err) => setError(errorMessage(err)),
      );
   };
   const attach = async () => {
      const paths = await pickFiles();
      if (paths === null) fileInput.current?.click();
      else addPaths(paths);
   };
   // Tauri delivers file drops as paths to the window (no HTML5 drop). With several prompt boxes
   // (a Side Thread panel) one of them takes it: see `pickTarget`. The region is the `data-drop-region`
   // element around the box: the chat column, or the Side chat panel body.
   const addRef = useRef(addPaths);
   addRef.current = addPaths;
   useEffect(
      () =>
         registerDropTarget({
            el: () => boxRef.current,
            region: () => boxRef.current?.closest<HTMLElement>("[data-drop-region]") ?? null,
            main,
            over: setDragging,
            drop: (paths) => addRef.current(paths),
         }),
      [boxRef, main],
   );

   /** Props for the box element: paste and HTML5 drop. */
   const boxHandlers = {
      onPasteCapture: (e: ClipboardEvent) => {
         const files = [...e.clipboardData.files];
         if (!files.length) return;
         e.preventDefault();
         e.stopPropagation();
         addFiles(files);
      },
      onDragOver: (e: DragEvent) => {
         if (!e.dataTransfer.types.includes("Files")) return;
         e.preventDefault();
         setDragging(true);
      },
      onDragLeave: () => setDragging(false),
      onDrop: (e: DragEvent) => {
         if (!e.dataTransfer.files.length) return;
         e.preventDefault();
         setDragging(false);
         addFiles([...e.dataTransfer.files]);
      },
   };
   /** Props for the hidden `<input type="file">` behind the paperclip. */
   const inputProps = {
      onChange: (e: ChangeEvent<HTMLInputElement>) => {
         addFiles([...(e.target.files ?? [])]);
         e.target.value = "";
      },
   };
   return { attachments, setAttachments, dragging, fileInput, attach, boxHandlers, inputProps };
}
