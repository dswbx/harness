import { useMemo, useRef, useState } from "react";
import { ArrowUp, MessageSquare, Square, X } from "lucide-react";
import type { SessionApi, SlashCommand } from "@harness/api";
import { Button, HoverTip, cn } from "@harness/ui";
import { ConfigBar } from "./ConfigBar";
import { PromptEditor, type PromptEditorHandle } from "./PromptEditor";
import { lineCount } from "./promptMarkdown";
import { matchCommands } from "./commands";
import { errorMessage } from "./errors";
import type { ChatState } from "./reducer";
import { getReviewComments, removeReviewComment, setReviewComments, useReviewComments, withReviewComments, type ReviewComment } from "./reviewComments";

/** Review comments from the diff views, sent with the next prompt. */
function CommentChips({ sessionId, comments }: { sessionId: string; comments: ReviewComment[] }) {
  return (
    <div className="flex flex-wrap gap-1 pb-1.5" aria-label="Review comments">
      {comments.map((c) => (
        <span key={c.id} className="flex max-w-full items-center gap-1 rounded-md border bg-muted py-0.5 pl-1.5 pr-0.5 text-xs" title={`${c.path}:${c.line} (${c.side})\n${c.code}\n\n${c.text}`}>
          <MessageSquare className="size-3 shrink-0 text-muted-foreground" />
          <span className="shrink-0 font-mono text-muted-foreground">{c.path.split("/").pop()}:{c.line}</span>
          <span className="min-w-0 max-w-64 truncate">{c.text}</span>
          <button className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label={`Remove comment on ${c.path}:${c.line}`} onClick={() => removeReviewComment(sessionId, c.id)}>
            <X className="size-3" />
          </button>
        </span>
      ))}
    </div>
  );
}

/** Context window use as a ring; details on hover. */
function ContextRing({ pct, used, size }: { pct: number; used: number; size: number }) {
  const r = 8;
  const c = 2 * Math.PI * r;
  const fmt = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  return (
    <HoverTip
      side="top"
      align="end"
      className="w-56 max-w-56 p-3"
      content={
        <div className="flex flex-col gap-2">
          <div className="flex justify-between font-medium"><span>Context window</span><span>{pct}%</span></div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div className={cn("h-full", pct > 85 ? "bg-destructive" : "bg-primary")} style={{ width: `${pct}%` }} />
          </div>
          <div className="grid grid-cols-[1fr_auto] gap-y-0.5 text-muted-foreground">
            <span>Used</span><span className="tabular-nums">{fmt(used)} / {fmt(size)} tokens</span>
            <span>Remaining</span><span className="tabular-nums">{fmt(Math.max(0, size - used))}</span>
          </div>
        </div>
      }
    >
      <button type="button" className="grid size-8 place-items-center rounded-full hover:bg-accent" aria-label={`Context window ${pct}% used`}>
        <svg viewBox="0 0 20 20" className="size-5 -rotate-90" aria-hidden>
          <circle cx="10" cy="10" r={r} fill="none" strokeWidth="2.5" className="stroke-muted" />
          <circle cx="10" cy="10" r={r} fill="none" strokeWidth="2.5" strokeLinecap="round" strokeDasharray={`${(c * pct) / 100} ${c}`} className={pct > 85 ? "stroke-destructive" : "stroke-muted-foreground"} />
        </svg>
      </button>
    </HoverTip>
  );
}

export function PromptBox({ api, state }: { api: SessionApi; state: ChatState }) {
  const [text, setText] = useState("");
  const [lines, setLines] = useState(0);
  const [overflow, setOverflow] = useState(false);
  const [sel, setSel] = useState(0);
  const ref = useRef<PromptEditorHandle>(null);
  const running = state.turnId !== null;
  const matches = useMemo(() => matchCommands(state.commands, text), [state.commands, text]);
  const pct = state.usage ? Math.min(100, Math.round((state.usage.used / state.usage.size) * 100)) : null;

  const [error, setError] = useState<string | null>(null);
  const readOnly = state.readOnly;
  const comments = useReviewComments(api.sessionId);

  // Restore uses the exact pre-send editor state, not the sent Markdown (re-parsing could turn literal `*x*` into formatting).
  const send = () => {
    const ed = ref.current;
    const t = ed?.getMarkdown().trim() ?? "";
    const sent = getReviewComments(api.sessionId);
    if (!ed || (!t && sent.length === 0) || readOnly) return;
    const snap = ed.snapshot();
    ed.clear();
    setReviewComments(api.sessionId, []);
    setError(null);
    api.prompt(withReviewComments(t, sent)).catch((err) => {
      setError(errorMessage(err));
      ref.current?.restore(snap);
      // Put them back ahead of any added since.
      setReviewComments(api.sessionId, [...sent, ...getReviewComments(api.sessionId)]);
    });
  };
  const continueWithSummary = () => {
    const ed = ref.current;
    const t = ed?.getMarkdown().trim() ?? "";
    const snap = ed?.snapshot();
    ed?.clear();
    setError(null);
    api.continueWithSummary(t || null).catch((err) => {
      setError(errorMessage(err));
      if (t && snap) ref.current?.restore(snap);
    });
  };
  const pick = (c: SlashCommand) => ref.current?.setText(`/${c.name} `);

  return (
    <div className="relative mx-auto w-full max-w-3xl px-6 pb-5">
      {matches.length > 0 && (
        <div className="absolute bottom-full left-6 mb-1 max-h-72 w-72 max-w-[calc(100%-3rem)] overflow-auto rounded-lg border bg-popover p-1 shadow-md" role="listbox" aria-label="Commands">
          {matches.map((c, i) => (
            <HoverTip key={c.name} content={c.description} open={i === sel && !!c.description}>
              <button
                ref={i === sel ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
                role="option"
                aria-selected={i === sel}
                aria-description={c.description || undefined}
                className={cn("flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left text-sm", i === sel && "bg-accent")}
                onMouseMove={() => i !== sel && setSel(i)}
                onClick={() => pick(c)}
              >
                <span className="truncate">/{c.name}</span>
                {c.hint && <span className="shrink-0 truncate text-xs text-muted-foreground">{c.hint}</span>}
              </button>
            </HoverTip>
          ))}
        </div>
      )}
      {readOnly && (
        <div role="alert" className="mb-2 flex flex-wrap items-center gap-3 rounded-lg border bg-muted/50 px-3 py-2 text-sm">
          <span className="flex-1">The Agent can't continue its earlier session. Continue with a summary of this conversation?</span>
          <Button size="sm" onClick={continueWithSummary}>Continue with summary</Button>
        </div>
      )}
      {error && (
        <div role="alert" className="mb-2 whitespace-pre-wrap text-xs text-destructive">
          {error}
        </div>
      )}
      <div className="rounded-2xl border bg-card px-3 pb-2 pt-3 shadow-sm">
        {comments.length > 0 && <CommentChips sessionId={api.sessionId} comments={comments} />}
        <PromptEditor
          ref={ref}
          placeholder={running ? "Agent is working... (you can still queue a prompt)" : "Message the Agent. Type / for commands."}
          menuOpen={matches.length > 0}
          onMenuKey={(k) => {
            if (k === "down") setSel((sel + 1) % matches.length);
            else if (k === "up") setSel((sel + matches.length - 1) % matches.length);
            else pick(matches[sel]!);
          }}
          onChange={(t, md) => {
            if (t !== text) setSel(0);
            setText(t);
            setLines(lineCount(md));
          }}
          onSubmit={send}
          onOverflowChange={setOverflow}
        />
        <div className="flex flex-wrap items-center gap-1 pt-1">
          <ConfigBar
            options={state.configOptions}
            onChange={(id, value) => {
              setError(null);
              api.setConfigOption(id, value).catch((err) => setError(errorMessage(err)));
            }}
          />
          <div className="flex-1" />
          {overflow && <span className="text-xs tabular-nums text-muted-foreground">{lines} lines</span>}
          {pct != null && <ContextRing pct={pct} used={state.usage!.used} size={state.usage!.size} />}
          {running ? (
            <Button size="icon" className="size-8 rounded-full" onClick={() => { setError(null); api.cancel().catch((err) => setError(errorMessage(err))); }} aria-label="Stop Agent" title="Stop Agent">
              <Square className="size-3 fill-current" />
            </Button>
          ) : (
            <Button size="icon" className="size-8 rounded-full" disabled={(!text.trim() && comments.length === 0) || readOnly} onClick={send} aria-label="Send">
              <ArrowUp />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
