import {
   type AttachmentInput,
   errText,
   formatAgeAgo,
   type Note,
   type SessionApi,
   useNote,
} from "@harness/api";
import { Button, cn, ScrollArea } from "@harness/ui";
import { ListPlus } from "lucide-react";
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNow } from "../../lib/time";
import { PromptEditor, type PromptEditorHandle } from "../prompt/PromptEditor";
import { AddFilesButton, AssetStrip, filesToInputs, type StripAsset } from "./AssetStrip";
import { taskFromText } from "./listModel";
import { type AutosaveStatus, useAutosave } from "./useAutosave";
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
 * user reloads. Images pasted, dropped or attached go to the note's `attachments/note/`.
 */
export function NoteEditor({ api }: { api: SessionApi }) {
   const [note, setNote] = useNote(api);
   const editor = useRef<PromptEditorHandle>(null);
   /** The hash of the note the editor holds (loaded or saved); writes are checked against it. */
   const base = useRef<string | null>(null);
   /** The Markdown last loaded or seen, so a selection change or a load does not save. */
   const lastMd = useRef<string | null>(null);
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

   const autosave = useAutosave<string>(async (md) => {
      const saved = await api.writeNote(md, base.current);
      base.current = saved.hash;
      setNote(saved);
   });

   const load = useCallback((n: Note) => {
      const ed = editor.current;
      if (!ed) return;
      base.current = n.hash;
      lastMd.current = null;
      ed.loadMarkdown(n.content);
      lastMd.current = ed.getMarkdown();
   }, []);

   // The first read, and notes written in other windows while nothing here waits to be saved.
   const { dirty } = autosave;
   useEffect(() => {
      if (!note || note.hash === base.current) return;
      if (base.current !== null && dirty()) return;
      load(note);
   }, [note, load, dirty]);

   const reload = () => {
      autosave.reset();
      setError(null);
      api.readNote().then(
         (n) => {
            setNote(n);
            load(n);
         },
         (e) => setError(errText(e)),
      );
   };

   const addImages = (files: AttachmentInput[]) => {
      setError(null);
      api.addNoteImages(files).then(setNote, (e) => setError(errText(e)));
   };
   // Files dropped on the note go to its images (not to a prompt box).
   const drop = useFileDrop(box, addImages, setError);

   const images = useMemo<StripAsset[]>(
      () =>
         (note?.images ?? []).map((path) => ({
            key: path,
            name: noteImageName(path),
            image: true,
            read: () => api.readAttachment(path),
         })),
      [note?.images, api],
   );

   const status = autosave.status;
   const shown = statusText(status, note?.updated_ms ?? null, now);
   const problem = status === "error" ? autosave.error : error;

   return (
      <section aria-label="Session note" className="flex min-h-0 flex-1 flex-col">
         <div className="flex items-center gap-2 px-3.5 pb-1.5 pt-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            <span className="flex-1">Session note</span>
            {status === "conflict" ? (
               <span className="flex items-center gap-1.5 normal-case tracking-normal text-amber-500">
                  Changed elsewhere
                  <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={reload}>
                     Reload
                  </Button>
               </span>
            ) : (
               shown && <span className="font-normal normal-case tracking-normal">{shown}</span>
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
               onBlur={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null))
                     void autosave.flush();
               }}
               onPasteCapture={(e) => {
                  const files = [...e.clipboardData.files];
                  if (!files.length) return;
                  e.preventDefault();
                  e.stopPropagation();
                  filesToInputs(files).then(addImages, (err) => setError(errText(err)));
               }}
               {...drop.handlers}
            >
               <ScrollArea className="min-h-0 flex-1">
                  {note ? (
                     <PromptEditor
                        ref={editor}
                        label="Session note"
                        placeholder="Notes for this session…"
                        newlineOnEnter
                        menuOpen={false}
                        onMenuKey={noop}
                        onSubmit={() => void autosave.flush()}
                        onChange={(_, md) => {
                           if (lastMd.current === null || md === lastMd.current) return;
                           lastMd.current = md;
                           autosave.change(md);
                        }}
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
