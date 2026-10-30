import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Archive, Brain, Info, CheckCircle2, ChevronRight, CircleDashed, FileText, GitCompare, Loader2, PanelRight, ShieldCheck, ShieldX, X } from "lucide-react";
import type { Attachment, SessionApi } from "@harness/api";
import { groupSubagents, useSessionEvents, type Subagent } from "@harness/api";
import { Badge, Button, Dialog, DialogContent, DialogTitle, Portal, ResizeHandle, Tooltip, VirtualList, cn, useResizableWidth } from "@harness/ui";
import { ALL_CHANGES, DiffPanel, FileStat, type DiffScope } from "./DiffPanel";
import { PromptBox } from "./PromptBox";
import { DiffWindow, diffWindowScope } from "./DiffWindow";
import { Markdown } from "./Markdown";
import { MessageFooter } from "./MessageFooter";
import { formatDuration } from "./time";
import { AuthCard } from "./Auth";
import { PermissionCard } from "./Permission";
import { FrontendToolRow } from "./FrontendToolCard";
import { RenderUi, type UiEnv } from "./RenderUi";
import { splitRenderUi, type Slot } from "./slots";
import type { RawNode } from "./tools";
import { groupTools, useToolDisplay, type ToolGroup } from "./toolDisplay";
import { splitDetails } from "./errors";
import { initialState, reduce, reduceBatch, type Item, type ChatState } from "./reducer";

type Tool = Extract<Item, { type: "tool" }>;

function TaskListPanel({ entries }: { entries: ChatState["taskList"] }) {
  if (entries.length === 0) return null;
  const done = entries.filter((e) => e.status === "completed").length;
  return (
    <div className="border-b bg-muted/40 px-4 py-2 text-sm">
      <div className="mb-1 text-xs font-medium text-muted-foreground">
        Task List ({done}/{entries.length})
      </div>
      <ul className="space-y-0.5">
        {entries.map((t, i) => (
          <li key={i} className={cn("flex items-center gap-2", t.status === "completed" && "text-muted-foreground line-through")}>
            {t.status === "completed" ? <CheckCircle2 className="size-3.5 text-emerald-500" /> : t.status === "in_progress" ? <Loader2 className="size-3.5 animate-spin" /> : <CircleDashed className="size-3.5 text-muted-foreground" />}
            {t.content}
          </li>
        ))}
      </ul>
    </div>
  );
}

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
function Working({ since }: { since: number | null }) {
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
        <button type="button" onClick={() => setOpen(true)} className="flex h-6 items-center gap-1 rounded px-1.5 hover:bg-accent hover:text-foreground">
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

const Row = memo(function Row({ item, api, env, view, onOpenDiff, subagents, active, streaming }: {
  item: Item | ToolGroup; api: SessionApi; env: UiEnv; view?: { root: RawNode; files: Record<string, string> } | null;
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
          {item.text && <Markdown breaks className="max-w-[80%] rounded-2xl bg-secondary px-3.5 py-2">{item.text}</Markdown>}
          <MessageFooter text={item.text} ts={item.ts} align="end">
            {item.context && <HarnessContext text={item.context} />}
          </MessageFooter>
        </div>
      );
    case "agent":
      return (
        <div className="group">
          <Markdown>{item.text}</Markdown>
          {/* Only a Turn's final message (it carries the duration); the streaming one keeps the space. */}
          {(item.durationMs !== undefined || streaming) && <MessageFooter text={item.text} ts={item.ts} durationMs={item.durationMs} hidden={streaming} />}
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

const slotKey = (x: Slot) => JSON.stringify(x.root);

/** render_ui items placed top or bottom: live, in the chat's column. Each can be hidden until it changes. */
function Slots({ slots, env, className }: { slots: Slot[]; env: UiEnv; className?: string }) {
  const [hidden, setHidden] = useState<Record<string, string>>({});
  const shown = slots.filter((x) => hidden[x.id] !== slotKey(x));
  if (shown.length === 0) return null;
  return (
    <div className={cn("shrink-0", className)}>
      <div className="mx-auto grid max-w-3xl gap-2 px-10 pb-3">
        {shown.map((x) => (
          <div key={x.id} className="group/slot relative rounded-lg border bg-card p-3">
            <button
              aria-label={`Hide ${x.title ?? x.id}`}
              onClick={() => setHidden({ ...hidden, [x.id]: slotKey(x) })}
              className="absolute right-1.5 top-1.5 grid size-6 place-items-center rounded text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground focus:opacity-100 group-hover/slot:opacity-100"
            >
              <X className="size-3.5" />
            </button>
            <RenderUi root={x.root} env={{ ...env, files: x.files }} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Toolbar button of a right-placed slot; a dot marks changes made while it was closed. */
function SlotTab({ slot, open, onClick }: { slot: Slot; open: boolean; onClick: () => void }) {
  const key = slotKey(slot);
  const [seen, setSeen] = useState(key);
  useEffect(() => { if (open) setSeen(key); }, [open, key]);
  const label = slot.title ?? slot.id;
  return (
    <Tooltip content={label} side="bottom">
      <Button
        size="icon"
        variant="ghost"
        className={cn("relative size-7 text-muted-foreground hover:text-foreground", open && "bg-accent text-foreground")}
        aria-label={label}
        aria-pressed={open}
        onClick={onClick}
      >
        <PanelRight />
        {!open && seen !== key && <span className="absolute right-1 top-1 size-1.5 rounded-full bg-primary" />}
      </Button>
    </Tooltip>
  );
}

function SlotPanel({ slot, env, onClose }: { slot: Slot; env: UiEnv; onClose: () => void }) {
  return (
    <aside className="flex h-full w-full flex-col border-l bg-background" aria-label={slot.title ?? slot.id}>
      <div className="flex items-center gap-1.5 border-b py-2 pr-2 pl-3">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{slot.title ?? slot.id}</span>
        <Button size="icon" variant="ghost" className="size-7" aria-label="Close panel" onClick={onClose}>
          <X />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <RenderUi root={slot.root} env={{ ...env, files: slot.files }} />
      </div>
    </aside>
  );
}

// A pop-out diff window boots like a solo View window, with `pane=diff` in its URL.
const diffScope = typeof window === "undefined" ? null : diffWindowScope(window.location.search);

/** Claude Code desktop-like chat. Pure fold of the Session Log (see reducer.ts). */
export function View({ api, toolbar, status }: { api: SessionApi; toolbar?: HTMLElement | null; status?: HTMLElement | null }) {
  return diffScope ? <DiffWindow api={api} scope={diffScope} /> : <ChatView api={api} toolbar={toolbar} status={status} />;
}

function ChatView({ api, toolbar, status }: { api: SessionApi; toolbar?: HTMLElement | null; status?: HTMLElement | null }) {
  const state = useSessionEvents(api, reduce, initialState, reduceBatch);
  /** The right panel: "changes" (the diff) or the id of a right-placed render_ui slot. */
  const [panel, setPanelId] = useState<string | null>(null);
  const [scope, setScope] = useState<DiffScope>(ALL_CHANGES);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  /** Right panel (diff or a render_ui slot), dragged from its left edge. */
  const right = useResizableWidth({ storageKey: "harness.chat.rightPanelWidth", initial: 420, min: 320, max: 1000, edge: "left" });
  // Changes need git; hidden until the Workspace is known to be a repository.
  const [git, setGit] = useState(false);
  useEffect(() => {
    let off = false;
    api.workspace().then((w) => !off && setGit(!!w?.repo_root), () => {});
    return () => { off = true; };
  }, [api]);

  const openDiff = useCallback((s: DiffScope) => { setScope(s); setPanelId("changes"); }, []);
  const ui = useMemo(() => splitRenderUi(state.items), [state.items]);
  const env = useMemo<UiEnv>(
    () => ({
      state: state.uiState,
      patch: (ops) => api.patchState(ops),
      send: (text) => api.prompt(text),
      files: {},
      readImage: (p) => api.frontendReadImage(p),
      open: (p, line) => api.openInEditor(p, line),
      scope: api.sessionId,
    }),
    [api, state.uiState],
  );
  // Resolved permission cards render nothing; keep them out of the virtual list. So do render_ui
  // calls that moved to a slot or were replaced by a later call with their id.
  // Subagent tool calls go inside their Task call's card.
  const { rows, subagents } = useMemo(() => {
    const g = groupSubagents(
      state.items.filter((i) => !(i.type === "permission" && !i.auto && i.resolved) && ui.inline.get(i.id) !== null),
      (i) => (i.type === "tool" ? i : null),
    );
    return { rows: groupTools(g.rows), subagents: g.subagents };
  }, [state.items, ui]);
  const rightSlot = ui.slots.right.find((x) => x.id === panel) ?? null;
  // A right item the Agent adds or changes while the Session is open shows at once (not replayed ones).
  const [openedAt] = useState(() => Date.now());
  const lastRight = useMemo(() => ui.slots.right.reduce<Slot | null>((a, x) => (!a || x.ts > a.ts ? x : a), null), [ui.slots.right]);
  useEffect(() => {
    if (lastRight && lastRight.ts >= openedAt) setPanelId(lastRight.id);
  }, [lastRight?.id, lastRight?.ts, openedAt]);
  const changeCount = useMemo(() => state.items.reduce((n, i) => n + (i.type === "changes" ? 1 : 0), 0), [state.items]);

  const running = state.turnId !== null;
  const proc = state.process;
  const refreshKey = `${changeCount}:${running}`;
  // In the host's Session header when it gives a slot, else in a header of our own.
  // After the Session title (host's status slot, else in our own header).
  const badge = proc && proc.state !== "ready" && (
    <Tooltip content={proc.message} side="bottom">
      <Badge variant={proc.state === "failed" ? "destructive" : "secondary"}>
        Agent {proc.state}
      </Badge>
    </Tooltip>
  );
  const actions = (
    <>
      {!status && toolbar && badge}
      {ui.slots.right.map((x) => (
        <SlotTab key={x.id} slot={x} open={panel === x.id} onClick={() => setPanelId(panel === x.id ? null : x.id)} />
      ))}
      {git && (
        <Tooltip content="Changes" side="bottom">
          <Button
            size="icon"
            variant="ghost"
            className={cn("size-7 text-muted-foreground hover:text-foreground", panel === "changes" && "bg-accent text-foreground")}
            aria-label="Changes"
            aria-pressed={panel === "changes"}
            onClick={() => setPanelId(panel === "changes" ? null : "changes")}
          >
            <GitCompare />
          </Button>
        </Tooltip>
      )}
    </>
  );
  return (
    <div className="flex h-full">
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <Portal
        container={toolbar}
        fallback={
          <div className="flex h-13 shrink-0 items-center gap-2 border-b px-5">
            <span className="truncate text-sm font-semibold">{state.title ?? "New Session"}</span>
            {badge}
            <div className="flex-1" />
            {actions}
          </div>
        }
      >
        {actions}
      </Portal>
      {toolbar && <Portal container={status}>{badge}</Portal>}
      <TaskListPanel entries={state.taskList} />
      <Slots slots={ui.slots.top} env={env} className="border-b pt-3" />
      <VirtualList
        count={rows.length}
        getKey={(i) => rows[i]!.id}
        estimateSize={72}
        gap={24}
        innerClassName="mx-auto max-w-3xl px-10 pb-3 pt-4"
        empty={<p className="py-16 text-center text-sm text-muted-foreground">Send a message to start.</p>}
        renderRow={(i) => <Row item={rows[i]!} api={api} env={env} view={ui.inline.get(rows[i]!.id)} onOpenDiff={openDiff} subagents={subagents} active={running} streaming={running && i === rows.length - 1} />}
        footer={<Working since={state.turnStartedAt} />}
      />
      <Slots slots={ui.slots.bottom} env={env} className="pt-1" />
      {state.archived ? (
        <div role="alert" className="border-t p-3">
          <div className="flex items-center gap-3 rounded-lg border bg-muted/50 px-3 py-2 text-sm">
            <Archive className="size-4 text-muted-foreground" />
            <span className="flex-1">Archived. Unarchive to continue</span>
            <Button
              size="sm"
              onClick={() => { setArchiveError(null); api.unarchive().catch((e) => setArchiveError(e instanceof Error ? e.message : String(e))); }}
            >
              Unarchive
            </Button>
          </div>
          {archiveError && <p className="mt-2 text-xs text-destructive">{archiveError}</p>}
        </div>
      ) : (
        <PromptBox api={api} state={state} />
      )}
    </div>
    {(panel === "changes" || rightSlot) && (
      <div className="relative h-full shrink-0" style={{ width: right.width }}>
        <ResizeHandle label="Resize panel" {...right.handle} />
        {panel === "changes" && <DiffPanel api={api} scope={scope} onScope={setScope} onClose={() => setPanelId(null)} refreshKey={refreshKey} />}
        {rightSlot && <SlotPanel slot={rightSlot} env={env} onClose={() => setPanelId(null)} />}
      </div>
    )}
    </div>
  );
}
