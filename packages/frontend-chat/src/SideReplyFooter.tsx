import { useEffect, useState } from "react";
import { Check, Copy, Undo2 } from "lucide-react";
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Popover, PopoverAnchor, PopoverContent, Textarea, Tooltip } from "@harness/ui";
import { addReviewComment } from "./reviewComments";

/** True for ~1.5s after `set()`, for "done" check marks. */
function useFlash() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!on) return;
    const t = setTimeout(() => setOn(false), 1500);
    return () => clearTimeout(t);
  }, [on]);
  return [on, () => setOn(true)] as const;
}

const iconButton = "size-6 text-muted-foreground hover:text-accent-foreground";

/** Under a finished reply in a Side Thread: copy it, or send it to the Main composer as a quote (optionally with a note). */
export function SideReplyFooter({ sessionId, text }: { sessionId: string; text: string }) {
  const [copied, flashCopied] = useFlash();
  const [sent, flashSent] = useFlash();
  const [commenting, setCommenting] = useState(false);
  const [note, setNote] = useState("");
  const send = (comment: string) => {
    const quote = text.trim();
    if (!quote) return;
    addReviewComment(sessionId, { kind: "quote", quote, text: comment.trim(), source: "side_thread" });
    flashSent();
  };
  return (
    <div className="mt-1 flex items-center gap-0.5">
      <Tooltip content={copied ? "Copied" : "Copy"} delay={100}>
        <Button
          size="icon"
          variant="ghost"
          className={iconButton}
          aria-label={copied ? "Copied" : "Copy reply"}
          onClick={() => void navigator.clipboard.writeText(text).then(flashCopied, () => {})}
        >
          {copied ? <Check /> : <Copy />}
        </Button>
      </Tooltip>
      <Popover open={commenting} onOpenChange={setCommenting}>
        <PopoverAnchor asChild>
          <span className="inline-flex">
            <DropdownMenu>
              <Tooltip content={sent ? "Added to Main" : "Send to main"} delay={100}>
                <DropdownMenuTrigger asChild>
                  <Button size="icon" variant="ghost" className={iconButton} aria-label={sent ? "Added to Main" : "Send to main"}>
                    {sent ? <Check /> : <Undo2 />}
                  </Button>
                </DropdownMenuTrigger>
              </Tooltip>
              <DropdownMenuContent align="start" className="w-56" onCloseAutoFocus={(e) => commenting && e.preventDefault()}>
                <DropdownMenuItem className="flex-col items-start gap-0" onSelect={() => send("")}>
                  <span>Send to main</span>
                  <span className="text-[11px] text-muted-foreground">Adds this reply to the main prompt box</span>
                </DropdownMenuItem>
                <DropdownMenuItem className="flex-col items-start gap-0" onSelect={() => { setNote(""); setCommenting(true); }}>
                  <span>Send with a comment…</span>
                  <span className="text-[11px] text-muted-foreground">Say what main should do with it</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        </PopoverAnchor>
        <PopoverContent align="start" className="w-72 space-y-2 p-2" aria-label="Comment for Main">
          <Textarea
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && note.trim()) {
                e.preventDefault();
                send(note);
                setCommenting(false);
              }
            }}
            placeholder="What should main do with this?"
            className="min-h-16 text-xs"
          />
          <div className="flex justify-end gap-1.5">
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setCommenting(false)}>Cancel</Button>
            <Button size="sm" className="h-7 px-2 text-xs" disabled={!note.trim()} onClick={() => { send(note); setCommenting(false); }}>Send</Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
