import { useEffect, useRef, useState } from "react";
import { MessageSquarePlus } from "lucide-react";
import { Button, Textarea } from "@harness/ui";
import { addReviewComment } from "./reviewComments";

/** Elements whose selected text can be commented on (chat messages). */
export const QUOTABLE = "data-quotable";

type Spot = { quote: string; range: Range; x: number; top: number; bottom: number };

/** CSS Custom Highlight that keeps the quote looking selected while the comment box has focus (styles.css). */
const HIGHLIGHT = "quote-comment";

const WIDTH = 420;
const clampX = (x: number, half: number) => Math.min(window.innerWidth - half - 12, Math.max(half + 12, x));

/** The selection's text and place, when it lies within one quotable element; else null. */
function selectedSpot(): Spot | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const el = (n: Node | null) => (n instanceof Element ? n : n?.parentElement)?.closest(`[${QUOTABLE}]`);
  const host = el(sel.anchorNode);
  if (!host || host !== el(sel.focusNode)) return null;
  const quote = sel.toString().trim();
  if (!quote) return null;
  const range = sel.getRangeAt(0).cloneRange();
  const r = range.getBoundingClientRect();
  return { quote, range, x: r.left + r.width / 2, top: r.top, bottom: r.bottom };
}

/**
 * Select text in a chat message, then "Add comment": the quote and a comment go to the prompt box (like diff line
 * comments) and are sent with the next prompt.
 */
export function SelectionComment({ sessionId }: { sessionId: string }) {
  const [spot, setSpot] = useState<Spot | null>(null);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const box = useRef<HTMLDivElement>(null);
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
    if (!spot || !text.trim()) return;
    addReviewComment(sessionId, { kind: "quote", quote: spot.quote, text: text.trim() });
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
    <div ref={box} style={style} className="fixed z-50 rounded-xl border bg-popover p-1 text-popover-foreground shadow-lg">
      {editing ? (
        <form
          className="grid gap-2 p-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="line-clamp-3 border-l-2 pl-2 text-xs text-muted-foreground">{spot.quote}</div>
          <div className="flex items-end gap-2">
            <Textarea
              autoFocus
              rows={1}
              value={text}
              placeholder="Add a comment"
              aria-label="Comment"
              className="max-h-40 min-h-8 resize-none border-0 bg-transparent px-0 py-1 text-sm shadow-none focus-visible:ring-0"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  // Cancel: give the reader their selection back.
                  const sel = window.getSelection();
                  sel?.removeAllRanges();
                  sel?.addRange(spot.range);
                  close();
                }
                else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            <Button type="submit" size="icon" variant="ghost" className="size-8 shrink-0" aria-label="Add comment" disabled={!text.trim()}>
              <MessageSquarePlus />
            </Button>
          </div>
        </form>
      ) : (
        <Button size="sm" variant="ghost" className="h-8 rounded-lg" onMouseDown={(e) => e.preventDefault()} onClick={() => setEditing(true)}>
          Add comment
        </Button>
      )}
    </div>
  );
}
