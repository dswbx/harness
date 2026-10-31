import { useEffect, useMemo, useRef, useState } from "react";
import { Check, CornerUpLeft, Pencil, ShieldCheck } from "lucide-react";
import type { SessionApi } from "@harness/api";
import { Badge, Button, Tooltip, cn } from "@harness/ui";
import type { DiffScope } from "./DiffPanel";
import { MessageList, useRows } from "./Messages";
import { PromptBox, type PromptBoxHandle } from "./PromptBox";
import { errorMessage } from "./errors";
import { addReviewComment } from "./reviewComments";
import type { ChatState } from "./reducer";
import type { UiEnv } from "./RenderUi";

/** How the Side Thread's Agent Session started; pending until its first `AgentSessionStarted` arrives. */
export function startText(t: Pick<ChatState, "startBoundary" | "forkedFrom">): string {
  if (t.startBoundary === null) return "Starts with your first message";
  if (t.startBoundary === "forked") return t.forkedFrom ? `Forked at Turn ${t.forkedFrom.turn}` : "Forked";
  return "Fresh (summary)";
}

/** The text selected inside `root`, if any. */
function selectionIn(root: HTMLElement | null): string {
  const sel = window.getSelection();
  if (!root || !sel || sel.isCollapsed || sel.rangeCount === 0) return "";
  const inside = (n: Node | null) => !!n && root.contains(n);
  return inside(sel.anchorNode) && inside(sel.focusNode) ? sel.toString().trim() : "";
}

/** A Side Thread in the right panel: header, its messages, and its own prompt box. */
export function ThreadView({ api, thread, threadId, env, onOpenDiff, focusKey }: {
  api: SessionApi;
  thread: ChatState;
  threadId: string;
  env: UiEnv;
  onOpenDiff: (s: DiffScope) => void;
  /** Changes when the prompt box should take focus (the tab was just created). */
  focusKey: number;
}) {
  const root = useRef<HTMLElement>(null);
  const prompt = useRef<PromptBoxHandle>(null);
  const { ui, rows, subagents } = useRows(thread.items);
  const sideEnv = useMemo<UiEnv>(() => ({ ...env, send: (text) => api.prompt(text, [], threadId) }), [env, api, threadId]);
  useEffect(() => {
    if (focusKey) prompt.current?.focus();
  }, [focusKey]);

  const [error, setError] = useState<string | null>(null);
  const toggleWrite = () => {
    setError(null);
    api.setThreadWritable(threadId, !thread.writable).catch((e) => setError(errorMessage(e)));
  };

  // "Send to main": the selection inside this Thread, else its last Agent reply, as a quote chip in the Main composer.
  const lastReply = useMemo(() => [...thread.items].reverse().find((i) => i.type === "agent"), [thread.items]);
  const [sent, setSent] = useState(false);
  useEffect(() => {
    if (!sent) return;
    const t = setTimeout(() => setSent(false), 1500);
    return () => clearTimeout(t);
  }, [sent]);
  const sendToMain = () => {
    const quote = selectionIn(root.current) || (lastReply?.type === "agent" ? lastReply.text.trim() : "");
    if (!quote) return;
    addReviewComment(api.sessionId, { kind: "quote", quote, text: "", source: "side_thread" });
    window.getSelection()?.removeAllRanges();
    setSent(true);
  };

  return (
    <aside ref={root} className="flex h-full w-full min-w-0 flex-col bg-background" aria-label="Side thread">
      <div className="space-y-2 border-b px-3 py-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{startText(thread)}</span>
          <Tooltip content={thread.writable ? "The Agent may edit files and run commands here. Click to make it read-only." : "The Agent cannot edit files or run commands here. Click to allow writes."} side="bottom">
            <button type="button" onClick={toggleWrite} aria-pressed={thread.writable} aria-label={thread.writable ? "Writes allowed. Make read-only" : "Read-only. Allow writes"}>
              <Badge variant={thread.writable ? "destructive" : "secondary"} className="cursor-pointer gap-1">
                {thread.writable ? <Pencil className="size-3" /> : <ShieldCheck className="size-3" />}
                {thread.writable ? "Can write" : "Read-only"}
              </Badge>
            </button>
          </Tooltip>
          <Tooltip content="Put the selection (else the last reply) in the Main prompt box as a quote" side="bottom">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1 px-2 text-xs"
              disabled={!lastReply}
              onMouseDown={(e) => e.preventDefault()}
              onClick={sendToMain}
            >
              {sent ? <Check className="size-3.5" /> : <CornerUpLeft className="size-3.5" />}
              {sent ? "Added to Main" : "Send to main"}
            </Button>
          </Tooltip>
        </div>
        {thread.excerpt && <div className={cn("line-clamp-3 border-l-2 pl-2 text-xs text-muted-foreground")}>{thread.excerpt.text}</div>}
        {error && <p role="alert" className="whitespace-pre-wrap text-xs text-destructive">{error}</p>}
      </div>
      <MessageList
        api={api}
        state={thread}
        threadId={threadId}
        side
        env={sideEnv}
        ui={ui}
        rows={rows}
        subagents={subagents}
        onOpenDiff={onOpenDiff}
        empty="Ask a question. The Main Thread never sees this."
      />
      <PromptBox ref={prompt} api={api} state={thread} threadId={threadId} />
    </aside>
  );
}
