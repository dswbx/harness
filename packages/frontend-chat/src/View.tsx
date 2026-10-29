import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Archive, Brain, Info, CheckCircle2, ChevronRight, CircleDashed, GitCompare, Loader2, ShieldCheck, ShieldX } from "lucide-react";
import type { SessionApi } from "@harness/api";
import { useSessionEvents } from "@harness/api";
import { Badge, Button, Portal, VirtualList, cn } from "@harness/ui";
import { ALL_CHANGES, DiffPanel, FileStat, type DiffScope } from "./DiffPanel";
import { PromptBox } from "./PromptBox";
import { DiffWindow, diffWindowScope } from "./DiffWindow";
import { Markdown } from "./Markdown";
import { MessageFooter } from "./MessageFooter";
import { AuthCard } from "./Auth";
import { PermissionCard } from "./Permission";
import { FrontendToolRow } from "./FrontendToolCard";
import { ToolCard } from "./ToolCard";
import { splitDetails } from "./errors";
import { initialState, reduce, reduceBatch, type Item, type ChatState } from "./reducer";

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
        <button className="flex-1 py-2 pr-3 text-left hover:underline" title="Open diff for this turn" onClick={onOpen}>
          Changed {n} {n === 1 ? "file" : "files"}
        </button>
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

const Row = memo(function Row({ item, api, onOpenDiff }: { item: Item; api: SessionApi; onOpenDiff: (s: DiffScope) => void }) {
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
          <Markdown breaks className="max-w-[80%] rounded-2xl bg-secondary px-3.5 py-2 text-sm">{item.text}</Markdown>
          <MessageFooter text={item.text} ts={item.ts} align="end" />
        </div>
      );
    case "agent":
      return (
        <div className="group">
          <Markdown>{item.text}</Markdown>
          <MessageFooter text={item.text} ts={item.ts} />
        </div>
      );
    case "thought":
      return (
        <details className="text-sm text-muted-foreground">
          <summary className="flex cursor-pointer items-center gap-1.5 text-xs">
            <Brain className="size-3.5" /> Thinking
          </summary>
          <Markdown className="mt-1 border-l-2 pl-3 italic">{item.text}</Markdown>
        </details>
      );
    case "frontend_tool":
      return <FrontendToolRow item={item} />;
    case "tool":
      return <ToolCard tool={item} />;
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

// A pop-out diff window boots like a solo View window, with `pane=diff` in its URL.
const diffScope = typeof window === "undefined" ? null : diffWindowScope(window.location.search);

/** Claude Code desktop-like chat. Pure fold of the Session Log (see reducer.ts). */
export function View({ api, toolbar }: { api: SessionApi; toolbar?: HTMLElement | null }) {
  return diffScope ? <DiffWindow api={api} scope={diffScope} /> : <ChatView api={api} toolbar={toolbar} />;
}

function ChatView({ api, toolbar }: { api: SessionApi; toolbar?: HTMLElement | null }) {
  const state = useSessionEvents(api, reduce, initialState, reduceBatch);
  const [panel, setPanel] = useState(false);
  const [scope, setScope] = useState<DiffScope>(ALL_CHANGES);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  // Changes need git; hidden until the Workspace is known to be a repository.
  const [git, setGit] = useState(false);
  useEffect(() => {
    let off = false;
    api.workspace().then((w) => !off && setGit(!!w?.repo_root), () => {});
    return () => { off = true; };
  }, [api]);

  const openDiff = useCallback((s: DiffScope) => { setScope(s); setPanel(true); }, []);
  // Resolved permission cards render nothing; keep them out of the virtual list.
  const rows = useMemo(() => state.items.filter((i) => !(i.type === "permission" && !i.auto && i.resolved)), [state.items]);
  const changeCount = useMemo(() => state.items.reduce((n, i) => n + (i.type === "changes" ? 1 : 0), 0), [state.items]);

  const running = state.turnId !== null;
  const proc = state.process;
  const refreshKey = `${changeCount}:${running}`;
  // In the host's Session header when it gives a slot, else in a header of our own.
  const actions = (
    <>
      {proc && proc.state !== "ready" && (
        <Badge variant={proc.state === "failed" ? "destructive" : "secondary"} title={proc.message ?? undefined}>
          Agent {proc.state}
        </Badge>
      )}
      {git && (
        <Button
          size="icon"
          variant="ghost"
          className={cn("size-7 text-muted-foreground hover:text-foreground", panel && "bg-accent text-foreground")}
          aria-label="Changes"
          title="Changes"
          aria-pressed={panel}
          onClick={() => setPanel(!panel)}
        >
          <GitCompare />
        </Button>
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
            <div className="flex-1" />
            {actions}
          </div>
        }
      >
        {actions}
      </Portal>
      <TaskListPanel entries={state.taskList} />
      <VirtualList
        count={rows.length}
        getKey={(i) => rows[i]!.id}
        estimateSize={72}
        gap={24}
        innerClassName="mx-auto max-w-3xl px-8 pb-8 pt-4"
        empty={<p className="py-16 text-center text-sm text-muted-foreground">Send a message to start.</p>}
        renderRow={(i) => <Row item={rows[i]!} api={api} onOpenDiff={openDiff} />}
        footer={
          running ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <Loader2 className="size-4 animate-spin" /> Working...
            </div>
          ) : null
        }
      />
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
    {panel && <DiffPanel api={api} scope={scope} onScope={setScope} onClose={() => setPanel(false)} refreshKey={refreshKey} />}
    </div>
  );
}
