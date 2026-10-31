import { memo, useEffect, useMemo, useState, type Ref } from "react";
import { AlertTriangle, Brain, ChevronRight, FileText, Info, Loader2, ShieldCheck, ShieldX } from "lucide-react";
import type { Attachment, SessionApi } from "@harness/api";
import { groupSubagents, type Subagent } from "@harness/api";
import { Dialog, DialogContent, DialogTitle, Tooltip, VirtualList, cn, type VirtualListHandle } from "@harness/ui";
import { FileStat, type DiffScope } from "./DiffPanel";
import { Markdown } from "./Markdown";
import { MessageFooter } from "./MessageFooter";
import { SideReplyFooter } from "./SideReplyFooter";
import { formatDuration } from "./time";
import { AuthCard } from "./Auth";
import { PermissionCard } from "./Permission";
import { FrontendToolRow } from "./FrontendToolCard";
import { quotableAttrs } from "./SelectionComment";
import type { UiEnv } from "./RenderUi";
import { splitRenderUi } from "./slots";
import type { RawNode } from "./tools";
import { groupTools, useToolDisplay, type ToolGroup } from "./toolDisplay";
import { splitDetails } from "./errors";
import type { ChatState, Item } from "./reducer";

type Tool = Extract<Item, { type: "tool" }>;

function ChangesRow({ item, onOpen }: { item: Extract<Item, { type: "changes" }>; onOpen: () => void }) {
  const [open, setOpen] = useState(false);
  const n = item.files.length;
  return (
    <div className="rounded-lg border bg-card text-sm">
      <div className="flex items-center">
        <button className="p-2" aria-label={open ? "Hide files" : "Show files"} aria-expanded={open} onClick={() => setOpen(!open)}>
          <ChevronRight className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-90")} />
        </button>
        <Tooltip content="Open diff for this turn">
          <button className="flex-1 py-2 pr-3 text-left hover:underline" onClick={onOpen}>
            Changed {n} {n === 1 ? "file" : "files"}
          </button>
        </Tooltip>
      </div>
      {open && (
        <ul className="space-y-1 border-t px-3 py-2">
          {item.files.map((f) => (
            <li key={f.path}><FileStat f={f} /></li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Notice({ item }: { item: Extract<Item, { type: "notice" }> }) {
  if (item.level === "error") {
    const { head, details } = splitDetails(item.text);
    return (
      <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{head}</span>
        </div>
        {details && (
          <details className="mt-1.5 pl-5">
            <summary className="cursor-pointer select-none">Details</summary>
            <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-background/60 p-2 font-mono text-[11px] text-foreground">{details}</pre>
          </details>
        )}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      <div className="h-px flex-1 bg-border" />
      <span className="whitespace-pre-wrap text-center">{item.text}</span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

function AgentNotice({ item }: { item: Extract<Item, { type: "agent_notice" }> }) {
  const warn = item.severity === "warning" || item.severity === "error";
  const Icon = warn ? AlertTriangle : Info;
  return (
    <div
      role={item.severity === "error" ? "alert" : "note"}
      className={cn(
        "flex items-start gap-2 rounded-lg border px-3 py-2 text-xs",
        item.severity === "error" ? "border-destructive/30 bg-destructive/5 text-destructive"
          : warn ? "border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-400"
          : "bg-muted/40 text-muted-foreground",
      )}
    >
      <Icon className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{item.title}</div>
        {item.description && <div className="mt-0.5 whitespace-pre-wrap break-words">{item.description}</div>}
      </div>
    </div>
  );
}

/** Always takes its height, so the layout doesn't shift as Turns start and end. */
export function Working({ since }: { since: number | null }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (since === null) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since]);
  return (
    <div className="flex h-5 items-center gap-2 text-sm text-muted-foreground" role="status">
      {since !== null && (
        <>
          <Loader2 className="size-4 animate-spin" /> Working... <span className="tabular-nums">{formatDuration(now - since)}</span>
        </>
      )}
    </div>
  );
}

/** Stored image path -> data URL, so thumbnails load once per window. */
const imageCache = new Map<string, Promise<string>>();

function AttachmentImage({ api, a }: { api: SessionApi; a: Attachment }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let p = imageCache.get(a.path);
    if (!p) {
      p = api.readAttachment(a.path).then((r) => `data:${r.mime};base64,${r.data}`);
      p.catch(() => imageCache.delete(a.path));
      imageCache.set(a.path, p);
    }
    let live = true;
    p.then((u) => live && setUrl(u), () => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [api, a.path]);
  if (failed) return <FileChip a={a} />;
  return (
    <>
      <Tooltip content={a.name}>
        <button className="size-20 overflow-hidden rounded-lg border bg-muted" aria-label={`Open ${a.name}`} onClick={() => setOpen(true)}>
          {url && <img src={url} alt={a.name} className="size-full object-cover" />}
        </button>
      </Tooltip>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-auto max-w-[90vw] p-2">
          <DialogTitle className="sr-only">{a.name}</DialogTitle>
          {url && <img src={url} alt={a.name} className="max-h-[85vh] max-w-full rounded object-contain" />}
        </DialogContent>
      </Dialog>
    </>
  );
}

function FileChip({ a }: { a: Attachment }) {
  return (
    <Tooltip content={a.path}>
      <span className="flex max-w-64 items-center gap-1.5 rounded-md border bg-muted px-2 py-1 text-xs">
        <FileText className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{a.name}</span>
      </span>
    </Tooltip>
  );
}

function UserAttachments({ api, items }: { api: SessionApi; items: Attachment[] }) {
  return (
    <div className="mb-1.5 flex max-w-[80%] flex-wrap justify-end gap-1.5">
      {items.map((a) => (a.kind === "image" ? <AttachmentImage key={a.path} api={api} a={a} /> : <FileChip key={a.path} a={a} />))}
    </div>
  );
}

/** What the core sent the Agent before this message (`<harness_context>`), on request. */
function HarnessContext({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const body = text.replace(/^<harness_context>\n?/, "").replace(/\n?<\/harness_context>$/, "");
  return (
    <>
      <Tooltip content="Context the Harness sent the Agent with this message" delay={100}>
        <button type="button" onClick={() => setOpen(true)} className="flex h-6 items-center gap-1 rounded px-1.5 hover:bg-accent hover:text-accent-foreground">
          <Info className="size-3.5" /> Harness context
        </button>
      </Tooltip>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogTitle>Harness context</DialogTitle>
          <p className="text-xs text-muted-foreground">Sent to the Agent before this message, inside a {"<harness_context>"} block.</p>
          <Markdown className="max-h-[60vh] overflow-y-auto rounded-md bg-muted p-3 text-sm">{body}</Markdown>
        </DialogContent>
      </Dialog>
    </>
  );
}

export const Row = memo(function Row({ item, api, env, view, onOpenDiff, subagents, active, streaming, threadId, side }: {
  item: Item | ToolGroup; api: SessionApi; env: UiEnv; view?: { root: RawNode; files: Record<string, string> } | null;
  /** The Thread this row belongs to; `side`: it is a Side Thread (its comments go to its own composer). */
  threadId: string; side: boolean;
  onOpenDiff: (s: DiffScope) => void; subagents: Map<string, Subagent<Tool>>;
  /** A Turn is running. */
  active: boolean;
  /** The last row while a Turn runs: an agent message is still coming in. */
  streaming?: boolean;
}) {
  switch (item.type) {
    case "changes":
      return (
        <ChangesRow
          item={item}
          onOpen={() => onOpenDiff({ from: item.fromTree, to: item.toTree, label: `Turn changes (${item.files.length})` })}
        />
      );
    case "user":
      return (
        <div className="group flex flex-col items-end">
          {item.attachments.length > 0 && <UserAttachments api={api} items={item.attachments} />}
          {item.text && <Markdown breaks className="max-w-[80%] rounded-2xl border bg-card px-3.5 py-2 text-card-foreground">{item.text}</Markdown>}
          <MessageFooter text={item.text} ts={item.ts} align="end">
            {item.context && <HarnessContext text={item.context} />}
          </MessageFooter>
        </div>
      );
    case "agent":
      return (
        <div className="group">
          <div {...quotableAttrs(threadId, side)}>
            <Markdown>{item.text}</Markdown>
          </div>
          {/* Only a Turn's final message (it carries the duration); the streaming one keeps the space. */}
          {(item.durationMs !== undefined || streaming) && !side && <MessageFooter text={item.text} ts={item.ts} durationMs={item.durationMs} hidden={streaming} />}
          {side && item.durationMs !== undefined && !streaming && <SideReplyFooter sessionId={api.sessionId} text={item.text} />}
        </div>
      );
    case "thought":
      return (
        <details className="text-sm text-muted-foreground">
          <summary className="flex cursor-pointer items-center gap-1.5 text-xs">
            <Brain className="size-3.5" /> Thinking
          </summary>
          <Markdown className="mt-1 border-l-2 pl-3 italic text-muted-foreground">{item.text}</Markdown>
        </details>
      );
    case "frontend_tool":
      return <FrontendToolRow item={item} env={env} view={view ?? undefined} />;
    case "tools":
      return <ToolGroupRow calls={item.calls} subagents={subagents} active={active} />;
    case "tool":
      return <ToolGroupRow calls={[item]} subagents={subagents} active={active} />;
    case "permission":
      if (item.auto) {
        return (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {item.auto.allowed ? <ShieldCheck className="size-3.5 text-emerald-500" /> : <ShieldX className="size-3.5 text-destructive" />}
            <span>
              {item.auto.allowed ? "Auto-allowed" : "Auto-denied"} {item.auto.ruleId ? "by rule" : "by default"}
              {item.toolCall.title ? `: ${item.toolCall.title}` : ""}
            </span>
          </div>
        );
      }
      return item.resolved ? null : <PermissionCard item={item} api={api} />;
    case "auth":
      return <AuthCard item={item} api={api} />;
    case "notice":
      return <Notice item={item} />;
    case "agent_notice":
      return <AgentNotice item={item} />;
  }
});

function ToolGroupRow(props: { calls: Tool[]; subagents: Map<string, Subagent<Tool>>; active: boolean }) {
  const { Group } = useToolDisplay();
  return <Group {...props} />;
}

/** A Thread's items split into rows: render_ui calls moved to slots, resolved permissions and subagent calls folded away. */
export function useRows(items: Item[]) {
  const ui = useMemo(() => splitRenderUi(items), [items]);
  // Resolved permission cards render nothing; keep them out of the virtual list. So do render_ui
  // calls that moved to a slot or were replaced by a later call with their id.
  // Subagent tool calls go inside their Task call's card.
  const { rows, subagents } = useMemo(() => {
    const g = groupSubagents(
      items.filter((i) => !(i.type === "permission" && !i.auto && i.resolved) && ui.inline.get(i.id) !== null),
      (i) => (i.type === "tool" ? i : null),
    );
    return { rows: groupTools(g.rows), subagents: g.subagents };
  }, [items, ui]);
  return { ui, rows, subagents };
}

/** The message list of one Thread (the Main Thread's, or a Side Thread's in the panel). */
export function MessageList({ handle, api, state, threadId, side, env, ui, rows, subagents, onOpenDiff, empty }: {
  api: SessionApi; state: ChatState; threadId: string; side: boolean; env: UiEnv;
  ui: ReturnType<typeof splitRenderUi>; rows: ReturnType<typeof useRows>["rows"]; subagents: Map<string, Subagent<Tool>>;
  onOpenDiff: (s: DiffScope) => void; empty: string; handle?: Ref<VirtualListHandle>;
}) {
  const running = state.turnId !== null;
  return (
    <VirtualList
      handle={handle}
      count={rows.length}
      getKey={(i) => rows[i]!.id}
      estimateSize={72}
      gap={24}
      innerClassName={cn("mx-auto px-10 pb-3 pt-4", side ? "px-4" : "max-w-3xl")}
      empty={<p className="py-16 text-center text-sm text-muted-foreground">{empty}</p>}
      renderRow={(i) => <Row item={rows[i]!} api={api} env={env} view={ui.inline.get(rows[i]!.id)} onOpenDiff={onOpenDiff} subagents={subagents} active={running} streaming={running && i === rows.length - 1} threadId={threadId} side={side} />}
      footer={<Working since={state.turnStartedAt} />}
    />
  );
}
