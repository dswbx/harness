import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { ArrowUp, FileText, MessageSquare, Paperclip, Square, X } from "lucide-react";
import { onFileDrop, pickFiles, type AttachmentInput, type SessionApi, type SlashCommand } from "@harness/api";
import { Button, Tooltip, cn } from "@harness/ui";
import { ConfigBar } from "./ConfigBar";
import { PromptEditor, type PromptEditorHandle } from "./PromptEditor";
import { lineCount } from "./promptMarkdown";
import { btwQuestion, matchCommands, withSideThreadCommand } from "./commands";
import { errorMessage } from "./errors";
import type { ChatState } from "./reducer";
import { fromFile, fromPickedPath, type PendingAttachment } from "./attachments";
import { composerKey, getReviewComments, removeReviewComment, setReviewComments, useReviewComments, withReviewComments, type ReviewComment } from "./reviewComments";

/** Files and images waiting to be sent: image thumbnails (pasted ones) or name chips. */
function AttachmentChips({ items, onRemove }: { items: PendingAttachment[]; onRemove: (id: string) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 pb-2" aria-label="Attachments">
      {items.map((a) => (
        <Tooltip key={a.id} content={a.input.type === "path" ? a.input.path : a.name}>
          <span className="group/att relative flex max-w-56 items-center gap-1.5 rounded-md border bg-muted text-xs">
            {a.preview ? (
              <img src={a.preview} alt={a.name} className="size-12 rounded-md object-cover" />
            ) : (
              <span className="flex min-w-0 items-center gap-1.5 py-1 pl-1.5 pr-6">
                <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{a.name}</span>
              </span>
            )}
            <button
              className="absolute right-0.5 top-0.5 rounded-full bg-background/80 p-0.5 text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover/att:opacity-100"
              aria-label={`Remove ${a.name}`}
              onClick={() => onRemove(a.id)}
            >
              <X className="size-3" />
            </button>
          </span>
        </Tooltip>
      ))}
    </div>
  );
}

/** Review comments from the diff views, sent with the next prompt. */
function CommentChips({ sessionId, comments }: { sessionId: string; comments: ReviewComment[] }) {
  return (
    <div className="flex flex-wrap gap-1 pb-1.5" aria-label="Review comments">
      {comments.map((c) => (
        <Tooltip
          key={c.id}
          className="max-w-96 whitespace-pre-wrap"
          content={
            c.kind === "quote"
              ? <><div className="my-1 border-l-2 pl-2 text-muted-foreground">{c.quote}</div><div>{c.text}</div></>
              : <><div className="font-mono text-muted-foreground">{c.path}:{c.line} ({c.side})</div><pre className="my-1 overflow-hidden font-mono">{c.code}</pre><div>{c.text}</div></>
          }
        >
          <span className="flex max-w-full items-center gap-1 rounded-md border bg-muted py-0.5 pl-1.5 pr-0.5 text-xs">
            <MessageSquare className="size-3 shrink-0 text-muted-foreground" />
            {c.kind === "quote"
              ? <span className="min-w-0 max-w-40 shrink-0 truncate text-muted-foreground">“{c.quote}”</span>
              : <span className="shrink-0 font-mono text-muted-foreground">{c.path.split("/").pop()}:{c.line}</span>}
            <span className="min-w-0 max-w-64 truncate">{c.text}</span>
            <button className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground" aria-label={c.kind === "quote" ? "Remove comment" : `Remove comment on ${c.path}:${c.line}`} onClick={() => removeReviewComment(sessionId, c.id)}>
              <X className="size-3" />
            </button>
          </span>
        </Tooltip>
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
    <Tooltip
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
      <button type="button" className="grid size-8 place-items-center rounded-full hover:bg-accent hover:text-accent-foreground" aria-label={`Context window ${pct}% used`}>
        <svg viewBox="0 0 20 20" className="size-5 -rotate-90" aria-hidden>
          <circle cx="10" cy="10" r={r} fill="none" strokeWidth="2.5" className="stroke-muted" />
          <circle cx="10" cy="10" r={r} fill="none" strokeWidth="2.5" strokeLinecap="round" strokeDasharray={`${(c * pct) / 100} ${c}`} className={pct > 85 ? "stroke-destructive" : "stroke-muted-foreground"} />
        </svg>
      </button>
    </Tooltip>
  );
}

/** Box content width (px) under which the footer's option pickers collapse into one menu. */
const NARROW_BOX = 460;

export type PromptBoxHandle = { focus(): void };

/**
 * The prompt box of the Main Thread, or of a Side Thread (`threadId`). Comments and quotes waiting in it are
 * kept per Thread. In the Main Thread, `/btw <question>` goes to `onSideThread` instead of being sent.
 */
export function PromptBox({ api, state, threadId = null, onSideThread, ref: handle }: {
  api: SessionApi;
  state: ChatState;
  threadId?: string | null;
  /** Starts a Side Thread and sends it `text` (Main Thread only). */
  onSideThread?: (text: string, attachments: AttachmentInput[]) => Promise<void>;
  ref?: Ref<PromptBoxHandle>;
}) {
  const [text, setText] = useState("");
  const [lines, setLines] = useState(0);
  const [overflow, setOverflow] = useState(false);
  const [sel, setSel] = useState(0);
  const ref = useRef<PromptEditorHandle>(null);
  useImperativeHandle(handle, () => ({ focus: () => ref.current?.focus() }), []);
  const key = composerKey(api.sessionId, threadId);
  const running = state.turnId !== null;
  const matches = useMemo(() => matchCommands(threadId || !onSideThread ? state.commands : withSideThreadCommand(state.commands), text), [state.commands, text, threadId, onSideThread]);
  const pct = state.usage ? Math.min(100, Math.round((state.usage.used / state.usage.size) * 100)) : null;

  const [error, setError] = useState<string | null>(null);
  const readOnly = state.readOnly;
  const comments = useReviewComments(key);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  // Width of the box itself (not the window): a side panel or narrow column collapses the option pickers.
  const [narrow, setNarrow] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setNarrow(e.contentRect.width < NARROW_BOX));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const caps = state.promptCaps;

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
    Promise.all(paths.map((p) => fromPickedPath(p, api.readImageFile))).then(addAttachments, (err) => setError(errorMessage(err)));
  };
  const attach = async () => {
    const paths = await pickFiles();
    if (paths === null) fileInput.current?.click();
    else addPaths(paths);
  };
  // Tauri delivers file drops as paths to the window (no HTML5 drop); any drop on this window lands here.
  const addRef = useRef(addPaths);
  addRef.current = addPaths;
  useEffect(() => {
    let off: (() => void) | null = null;
    let gone = false;
    void onFileDrop((e) => {
      setDragging(e.type === "over");
      if (e.type === "drop") addRef.current(e.paths);
    }).then((u) => (gone ? u?.() : (off = u)));
    return () => {
      gone = true;
      off?.();
    };
  }, []);

  // Restore uses the exact pre-send editor state, not the sent Markdown (re-parsing could turn literal `*x*` into formatting).
  const send = () => {
    const ed = ref.current;
    const t = ed?.getMarkdown().trim() ?? "";
    const sent = getReviewComments(key);
    const files = attachments;
    if (!ed || (!t && sent.length === 0 && files.length === 0) || readOnly) return;
    const snap = ed.snapshot();
    ed.clear();
    setReviewComments(key, []);
    setAttachments([]);
    setError(null);
    // Our `/btw <question>` wins over an Agent command of the same name (Claude Code has one).
    const btw = threadId || !onSideThread ? null : btwQuestion(t);
    const inputs = files.map((a) => a.input);
    (btw && onSideThread ? onSideThread(withReviewComments(btw, sent), inputs) : api.prompt(withReviewComments(t, sent), inputs, threadId)).catch((err) => {
      setError(errorMessage(err));
      ref.current?.restore(snap);
      setAttachments((cur) => [...files, ...cur]);
      // Put them back ahead of any added since.
      setReviewComments(key, [...sent, ...getReviewComments(key)]);
    });
  };
  const continueWithSummary = () => {
    const ed = ref.current;
    const t = ed?.getMarkdown().trim() ?? "";
    const snap = ed?.snapshot();
    ed?.clear();
    setError(null);
    api.continueWithSummary(t || null, threadId).catch((err) => {
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
            <Tooltip key={c.name} content={c.description} side="right" open={i === sel && !!c.description}>
              <button
                ref={i === sel ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
                role="option"
                aria-selected={i === sel}
                aria-description={c.description || undefined}
                className={cn("flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left text-sm", i === sel && "bg-accent text-accent-foreground")}
                onMouseMove={() => i !== sel && setSel(i)}
                onClick={() => pick(c)}
              >
                <span className="truncate">/{c.name}</span>
                {c.hint && <span className="shrink-0 truncate text-xs text-muted-foreground">{c.hint}</span>}
              </button>
            </Tooltip>
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
      <div
        ref={boxRef}
        className={cn("rounded-2xl border bg-card px-3 pb-2 pt-3 shadow-sm transition-colors", dragging && "border-ring bg-accent/40")}
        onPasteCapture={(e) => {
          const files = [...e.clipboardData.files];
          if (!files.length) return;
          e.preventDefault();
          e.stopPropagation();
          addFiles(files);
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          setDragging(false);
          addFiles([...e.dataTransfer.files]);
        }}
      >
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => { addFiles([...(e.target.files ?? [])]); e.target.value = ""; }} />
        {attachments.length > 0 && <AttachmentChips items={attachments} onRemove={(id) => setAttachments((cur) => cur.filter((a) => a.id !== id))} />}
        {comments.length > 0 && <CommentChips sessionId={key} comments={comments} />}
        <PromptEditor
          ref={ref}
          placeholder={running ? "Agent is working... (you can still queue a prompt)" : threadId ? "Ask in this side thread" : "Message the Agent. Type / for commands."}
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
          <Tooltip content="Attach files or images">
            <button
              type="button"
              className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
              aria-label="Attach files or images"
              disabled={readOnly}
              onClick={() => void attach().catch((err) => setError(errorMessage(err)))}
            >
              <Paperclip className="size-4" />
            </button>
          </Tooltip>
          {/* Side Threads follow Main's config except the mode, which they own: only the mode picker there. */}
          <ConfigBar
            compact={narrow}
            modeOnly={!!threadId}
            options={state.configOptions}
            onChange={(id, value) => {
              setError(null);
              api.setConfigOption(id, value, threadId).catch((err) => setError(errorMessage(err)));
            }}
          />
          <div className="flex-1" />
          {overflow && <span className="text-xs tabular-nums text-muted-foreground">{lines} lines</span>}
          {pct != null && <ContextRing pct={pct} used={state.usage!.used} size={state.usage!.size} />}
          {running ? (
            <Tooltip content="Stop Agent">
              <Button size="icon" className="size-8 rounded-full" onClick={() => { setError(null); api.cancel(threadId).catch((err) => setError(errorMessage(err))); }} aria-label="Stop Agent">
                <Square className="size-3 fill-current" />
              </Button>
            </Tooltip>
          ) : (
            <Button size="icon" className="size-8 rounded-full" disabled={(!text.trim() && comments.length === 0 && attachments.length === 0) || readOnly} onClick={send} aria-label="Send">
              <ArrowUp />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
