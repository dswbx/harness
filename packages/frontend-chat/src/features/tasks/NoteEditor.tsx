import {
   type AttachmentInput,
   errText,
   formatAgeAgo,
   type SessionApi,
   useNote,
} from "@harness/api";
import { Button, cn, ScrollArea } from "@harness/ui";
import { ChevronDown, ListPlus } from "lucide-react";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { useNow } from "../../lib/time";
import { PromptEditor } from "../prompt/PromptEditor";
import { AddFilesButton, AssetStrip, type StripAsset } from "./AssetStrip";
import { taskFromText } from "./listModel";
import type { AutosaveStatus } from "./useAutosave";
import { useAutosavedMarkdown } from "./useAutosavedMarkdown";
import { useFileDrop } from "./useFileDrop";

const noop = () => {};

/** The text selected inside `box` ("" when the selection is empty or elsewhere). */
function useSelectedText(box: RefObject<HTMLElement | null>): string {
   const [text, setText] = useState("");
   useEffect(() => {
      const update = () => {
         const sel = document.getSelection();
         const el = box.current;
         const inside =
            !!sel &&
            !sel.isCollapsed &&
            !!el &&
            el.contains(sel.anchorNode) &&
            el.contains(sel.focusNode);
         setText(inside ? sel.toString() : "");
      };
      document.addEventListener("selectionchange", update);
      return () => document.removeEventListener("selectionchange", update);
   }, [box]);
   return text;
}

/** A stored note image's name without the id the core puts in front (`<uuid>-shot.png` → `shot.png`). */
const noteImageName = (path: string) =>
   (path.split("/").pop() ?? path).replace(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}-/i, "");

function statusText(status: AutosaveStatus, updatedMs: number | null, now: number): string | null {
   if (status === "pending" || status === "saving") return "Saving…";
   if (updatedMs === null) return null;
   return `Saved · ${formatAgeAgo(updatedMs, now)}`;
}

/**
 * The Session Note (ADR 0028), typed in place: Markdown, saved 600 ms after typing stops, on blur and when the panel
 * goes away. A note written elsewhere loads in unless there are unsaved changes; then the save is refused and the
 * user reloads. Images pasted, dropped or attached go to the note's `attachments/note/`. Its header folds it
 * (`onCollapse`).
 */
export function NoteEditor({ api, onCollapse }: { api: SessionApi; onCollapse: () => void }) {
   const [note, setNote] = useNote(api);
   const [error, setError] = useState<string | null>(null);
   const now = useNow();
   const box = useRef<HTMLDivElement>(null);
   const selected = useSelectedText(box);
   const fromSelection = selected ? taskFromText(selected) : null;
   const makeTask = () => {
      if (!fromSelection) return;
      setError(null);
      api.createTask(fromSelection).catch((e) => setError(errText(e)));
      document.getSelection()?.collapseToEnd();
   };

   const addImages = (files: AttachmentInput[]) => {
      setError(null);
      api.addNoteImages(files).then(setNote, (e) => setError(errText(e)));
   };
   // Files dropped on the note go to its images (not to a prompt box).
   const drop = useFileDrop(box, addImages, setError);

   const md = useAutosavedMarkdown({
      value: note,
      baseOf: (n) => n.hash,
      textOf: (n) => n.content,
      write: (content, base) => api.writeNote(content, base),
      read: () => api.readNote(),
      onStored: setNote,
      onFiles: addImages,
      onError: setError,
   });
   const reload = () => {
      setError(null);
      md.reload();
   };

   const images = useMemo<StripAsset[]>(
      () =>
         (note?.images ?? []).map((path) => ({
            key: path,
            name: noteImageName(path),
            image: true,
            read: () => api.readAttachment(path),
            remove: () => {
               setError(null);
               api.removeNoteImage(path).then(setNote, (e) => setError(errText(e)));
            },
         })),
      [note?.images, api, setNote],
   );

   const status = md.status;
   const shown = statusText(status, note?.updated_ms ?? null, now);
   const problem = status === "error" ? md.error : error;

   return (
      <section aria-label="Session note" className="flex min-h-0 flex-1 flex-col">
         <div className="flex h-9 shrink-0 items-center gap-2 pl-3.5 pr-3 text-xs text-muted-foreground">
            <button
               type="button"
               aria-expanded
               onClick={onCollapse}
               className="-my-1 flex min-w-0 flex-1 items-center gap-2 self-stretch text-left outline-none hover:text-foreground focus-visible:underline"
            >
               <ChevronDown className="size-3 shrink-0" />
               <span className="font-medium text-foreground">Session note</span>
            </button>
            {status === "conflict" ? (
               <span className="flex items-center gap-1.5 text-amber-500">
                  Changed elsewhere
                  <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={reload}>
                     Reload
                  </Button>
               </span>
            ) : (
               shown && <span className="shrink-0 text-[11px]">{shown}</span>
            )}
         </div>
         {problem && (
            <div role="alert" className="px-3.5 pb-1.5 text-xs text-destructive">
               {problem}
            </div>
         )}
         <div className="flex min-h-0 flex-1 flex-col px-2.5 pb-2.5">
            <div
               ref={box}
               className={cn(
                  "flex min-h-0 flex-1 flex-col rounded-xl border bg-card px-3 pb-1.5 pt-2.5 transition-colors",
                  "focus-within:border-ring/50 dark:focus-within:border-border",
                  drop.over && "border-ring bg-accent/40",
               )}
               {...md.box}
               {...drop.handlers}
            >
               <ScrollArea className="min-h-0 flex-1">
                  {note ? (
                     <PromptEditor
                        ref={md.editor}
                        label="Session note"
                        placeholder="Notes for this session…"
                        newlineOnEnter
                        menuOpen={false}
                        onMenuKey={noop}
                        onSubmit={md.onSubmit}
                        onChange={md.onChange}
                        maxHeightClassName="max-h-none"
                        minHeightClassName="min-h-40"
                     />
                  ) : (
                     <div className="min-h-40 px-1 text-sm text-muted-foreground/50">Loading…</div>
                  )}
                  <AssetStrip assets={images} />
               </ScrollArea>
               <div className="mt-auto flex items-center gap-1 border-t pt-1.5">
                  <AddFilesButton
                     label="Attach images"
                     accept="image/*"
                     onAdd={addImages}
                     onError={setError}
                  />
                  <span className="flex-1 text-[11px] text-muted-foreground">
                     Markdown · autosaves
                  </span>
                  {fromSelection ? (
                     <Button
                        size="sm"
                        variant="outline"
                        className="h-6 gap-1 px-2 text-xs"
                        // Keeps the selection (and the editor's focus) while clicking.
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={makeTask}
                     >
                        <ListPlus className="size-3" /> Make task
                     </Button>
                  ) : (
                     <span className="text-[11px] text-muted-foreground/70">
                        Select text → Make task
                     </span>
                  )}
               </div>
            </div>
         </div>
      </section>
   );
}
