import { Button } from "@harness/ui";
import { MessageSquarePlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { PromptEditor, type PromptEditorHandle } from "./PromptEditor";
import { addReviewComment, composerKey } from "./reviewComments";

/** Elements whose selected text can be commented on (chat messages). */
export const QUOTABLE = "data-quotable";

/**
 * Marks a message of a Thread as quotable (`data-side`: its quote goes to that Side Thread's prompt box).
 * `from`: the quote comes from the plan or an artifact (named by `label`), not a message. Without a thread id,
 * the quote goes to the Main Thread's prompt box.
 */
export function quotableAttrs(
   threadId: string | null,
   side: boolean,
   from: { source?: "plan" | "artifact"; label?: string } = {},
) {
   return {
      [QUOTABLE]: "",
      ...(threadId && { "data-thread-id": threadId }),
      "data-side": side ? "1" : "0",
      ...(from.source && { "data-source": from.source }),
      ...(from.label && { "data-label": from.label }),
   };
}

type Spot = {
   quote: string;
   range: Range;
   x: number;
   top: number;
   bottom: number;
   side: boolean;
   threadId: string | null;
   source?: "plan" | "artifact";
   label?: string;
};

/** CSS Custom Highlight that keeps the quote looking selected while the comment box has focus (styles.css). */
const HIGHLIGHT = "quote-comment";

const WIDTH = 420;
const clampX = (x: number, half: number) =>
   Math.min(window.innerWidth - half - 12, Math.max(half + 12, x));

/** The selection's text and place, when it lies within one quotable element; else null. */
function selectedSpot(): Spot | null {
   const sel = window.getSelection();
   if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
   const el = (n: Node | null) =>
      (n instanceof Element ? n : n?.parentElement)?.closest(`[${QUOTABLE}]`);
   const host = el(sel.anchorNode);
   if (!host || host !== el(sel.focusNode)) return null;
   const quote = sel.toString().trim();
   if (!quote) return null;
   const range = sel.getRangeAt(0).cloneRange();
   const r = range.getBoundingClientRect();
   const threadId = host.getAttribute("data-thread-id");
   const source = host.getAttribute("data-source");
   return {
      quote,
      range,
      x: r.left + r.width / 2,
      top: r.top,
      bottom: r.bottom,
      side: threadId !== null && host.getAttribute("data-side") === "1",
      threadId,
      ...((source === "plan" || source === "artifact") && {
         source,
         label: host.getAttribute("data-label") || undefined,
      }),
   };
}

/**
 * Select text in a chat message, then "Add comment": the quote and a comment go to the prompt box (like diff line
 * comments) and are sent with the next prompt.
 */
export function SelectionComment({
   sessionId,
   onAskSideThread,
}: {
   sessionId: string;
   onAskSideThread?: (quote: string) => void;
}) {
   const [spot, setSpot] = useState<Spot | null>(null);
   const [editing, setEditing] = useState(false);
   const [text, setText] = useState("");
   const box = useRef<HTMLDivElement>(null);
   const editor = useRef<PromptEditorHandle>(null);
   const editingRef = useRef(false);
   editingRef.current = editing;

   useEffect(() => {
      // Offer the button once the mouse (or Shift+arrows) settles the selection, not during the drag.
      const settle = (e: Event) => {
         if (box.current?.contains(e.target as Node)) return;
         setTimeout(() => !editingRef.current && setSpot(selectedSpot()));
      };
      const onSelection = () => {
         if (!editingRef.current && window.getSelection()?.isCollapsed) setSpot(null);
      };
      const onScroll = () => !editingRef.current && setSpot(null);
      document.addEventListener("mouseup", settle);
      document.addEventListener("keyup", settle);
      document.addEventListener("selectionchange", onSelection);
      document.addEventListener("scroll", onScroll, true);
      return () => {
         document.removeEventListener("mouseup", settle);
         document.removeEventListener("keyup", settle);
         document.removeEventListener("selectionchange", onSelection);
         document.removeEventListener("scroll", onScroll, true);
      };
   }, []);

   // Typing in the box takes the selection away; paint the quote as selected instead (where supported).
   useEffect(() => {
      if (!editing || !spot || typeof CSS === "undefined" || !CSS.highlights) return;
      CSS.highlights.set(HIGHLIGHT, new Highlight(spot.range));
      return () => void CSS.highlights.delete(HIGHLIGHT);
   }, [editing, spot]);

   useEffect(() => {
      if (editing) editor.current?.focus();
   }, [editing]);

   // Close the form on a click outside it.
   useEffect(() => {
      if (!editing) return;
      const down = (e: MouseEvent) => !box.current?.contains(e.target as Node) && close();
      document.addEventListener("mousedown", down);
      return () => document.removeEventListener("mousedown", down);
   }, [editing]);

   const close = () => {
      setEditing(false);
      setSpot(null);
      setText("");
   };
   const submit = () => {
      const comment = editor.current?.getMarkdown().trim();
      if (!spot || !comment) return;
      addReviewComment(composerKey(sessionId, spot.side ? spot.threadId : null), {
         kind: "quote",
         quote: spot.quote,
         text: comment,
         ...(spot.source && { source: spot.source, ...(spot.label && { label: spot.label }) }),
      });
      window.getSelection()?.removeAllRanges();
      close();
   };

   const ask = () => {
      if (!spot || !onAskSideThread) return;
      onAskSideThread(spot.quote);
      window.getSelection()?.removeAllRanges();
      close();
   };

   if (!spot) return null;
   // Above the selection, or below it when there is no room.
   const above = spot.top > (editing ? 160 : 56);
   const style = {
      left: clampX(spot.x, editing ? WIDTH / 2 : 60),
      top: above ? spot.top - 8 : spot.bottom + 8,
      transform: `translate(-50%, ${above ? "-100%" : "0"})`,
      width: editing ? WIDTH : undefined,
   };
   return (
      <div
         ref={box}
         style={style}
         className="fixed z-50 rounded-xl border bg-popover p-1 text-popover-foreground shadow-lg"
      >
         {editing ? (
            <form
               className="grid gap-2 p-2"
               onKeyDownCapture={(e) => {
                  if (e.key !== "Escape") return;
                  // Cancel: give the reader their selection back.
                  e.preventDefault();
                  const sel = window.getSelection();
                  sel?.removeAllRanges();
                  sel?.addRange(spot.range);
                  close();
               }}
               onSubmit={(e) => {
                  e.preventDefault();
                  submit();
               }}
            >
               <div className="line-clamp-3 border-l-2 pl-2 text-xs text-muted-foreground">
                  {spot.quote}
               </div>
               <div className="flex items-end gap-2">
                  <div className="min-w-0 flex-1 py-1.5">
                     <PromptEditor
                        ref={editor}
                        label="Comment"
                        placeholder="Add a comment"
                        maxHeightClassName="max-h-40"
                        minHeightClassName="min-h-5"
                        menuOpen={false}
                        onMenuKey={() => {}}
                        onChange={(_, md) => setText(md)}
                        onSubmit={submit}
                     />
                  </div>
                  <Button
                     type="submit"
                     size="icon"
                     variant="ghost"
                     className="size-8 shrink-0"
                     aria-label="Add comment"
                     disabled={!text.trim()}
                  >
                     <MessageSquarePlus />
                  </Button>
               </div>
            </form>
         ) : (
            <div className="flex">
               <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 rounded-lg"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setEditing(true)}
               >
                  Add comment
               </Button>
               {onAskSideThread && (
                  <Button
                     size="sm"
                     variant="ghost"
                     className="h-8 rounded-lg"
                     onMouseDown={(e) => e.preventDefault()}
                     onClick={ask}
                  >
                     Ask in side thread
                  </Button>
               )}
            </div>
         )}
      </div>
   );
}
