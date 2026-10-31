import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Archive, CheckCircle2, CircleDashed, GitCompare, GitFork, Loader2, MessagesSquare, PanelRight, SquareTerminal, X } from "lucide-react";
import type { AttachmentInput, Excerpt, SessionApi } from "@harness/api";
import { useSessionEvents } from "@harness/api";
import {
  Badge, Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger,
  Portal, ResizeHandle, Tooltip, cn, useResizableWidth,
} from "@harness/ui";
import { ALL_CHANGES, DiffPanel, type DiffScope } from "./DiffPanel";
import { PromptBox } from "./PromptBox";
// xterm.js stays out of the main chunk until the Terminal is first opened.
const TerminalPanel = lazy(() => import("./TerminalPanel"));
import { DiffWindow, diffWindowScope } from "./DiffWindow";
import { MessageList, useRows } from "./Messages";
import { ThreadView, startText } from "./ThreadView";
import { SelectionComment } from "./SelectionComment";
import { RenderUi, type UiEnv } from "./RenderUi";
import type { Slot } from "./slots";
import { errorMessage } from "./errors";
import { closeTab, loadPanel, openTab, sameTab, savePanel, tabKey, toggleTab, type PanelState, type PanelTab } from "./panelTabs";
import { initialState, reduce, reduceBatch, type ChatState } from "./reducer";


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
              className="absolute right-1.5 top-1.5 grid size-6 place-items-center rounded text-muted-foreground opacity-0 hover:bg-accent hover:text-accent-foreground focus:opacity-100 group-hover/slot:opacity-100"
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
        className={cn("relative size-7 text-muted-foreground hover:text-accent-foreground", open && "bg-accent text-accent-foreground")}
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

const CHANGES: PanelTab = { kind: "changes" };
const TERMINAL: PanelTab = { kind: "terminal" };

function ChatView({ api, toolbar, status }: { api: SessionApi; toolbar?: HTMLElement | null; status?: HTMLElement | null }) {
  const state = useSessionEvents(api, reduce, initialState, reduceBatch);
  /** The right panel: open tabs (Changes, Terminal, right render_ui items, Side Threads) and the shown one. Kept per Session. */
  const [panel, setPanel] = useState<PanelState>(() => loadPanel(api.sessionId));
  useEffect(() => savePanel(api.sessionId, panel), [api.sessionId, panel]);
  const active = panel.active;
  const show = useCallback((t: PanelTab) => setPanel((p) => openTab(p, t)), []);
  const toggle = useCallback((t: PanelTab) => setPanel((p) => toggleTab(p, t)), []);
  const close = useCallback((t: PanelTab) => setPanel((p) => closeTab(p, t)), []);
  /** The Terminal stays mounted (hidden) once opened, so its screen survives switching panels. */
  const [terminalOpened, setTerminalOpened] = useState(false);
  const toggleTerminal = useCallback(() => {
    setTerminalOpened(true);
    toggle(TERMINAL);
  }, [toggle]);

  // Side Threads: a prompt box takes focus in the tab that was just created.
  const [focus, setFocus] = useState<{ id: string; n: number }>({ id: "", n: 0 });
  const [sideError, setSideError] = useState<string | null>(null);
  /** Opens a Side Thread (forked from Main when the Agent can), shows its tab, and returns its id. */
  const newSideThread = useCallback(
    async (excerpt: Excerpt | null = null) => {
      setSideError(null);
      try {
        const { thread_id } = await api.startSideThread({ excerpt });
        show({ kind: "thread", id: thread_id });
        setFocus((f) => ({ id: thread_id, n: f.n + 1 }));
        return thread_id;
      } catch (e) {
        setSideError(errorMessage(e));
        return null;
      }
    },
    [api, show],
  );
  /** `/btw <text>` in the Main prompt box: a Side Thread whose first prompt is `text`. */
  const btw = useCallback(
    async (text: string, attachments: AttachmentInput[]) => {
      const id = await newSideThread();
      if (!id) throw new Error("Could not start a side thread");
      await api.prompt(text, attachments, id);
    },
    [api, newSideThread],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ctrl+` toggles the Terminal, as in VS Code. Capture phase, so xterm never sees it.
      if (e.ctrlKey && !e.metaKey && !e.altKey && (e.code === "Backquote" || e.key === "`")) {
        e.preventDefault();
        e.stopPropagation();
        toggleTerminal();
      }
      // Cmd/Ctrl+Shift+B: a new Side Thread ("by the way").
      else if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.code === "KeyB") {
        e.preventDefault();
        e.stopPropagation();
        void newSideThread();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [toggleTerminal, newSideThread]);
  const [scope, setScope] = useState<DiffScope>(ALL_CHANGES);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  /** Right panel, dragged from its left edge. */
  const right = useResizableWidth({ storageKey: "harness.chat.rightPanelWidth", initial: 420, min: 320, max: 1000, edge: "left" });
  // Changes need git; hidden until the Workspace is known to be a repository.
  const [git, setGit] = useState(false);
  useEffect(() => {
    let off = false;
    api.workspace().then((w) => !off && setGit(!!w?.repo_root), () => {});
    return () => { off = true; };
  }, [api]);

  const openDiff = useCallback((s: DiffScope) => { setScope(s); show(CHANGES); }, [show]);
  const { ui, rows, subagents } = useRows(state.items);
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
  const rightSlot = active?.kind === "slot" ? (ui.slots.right.find((x) => x.id === active.id) ?? null) : null;
  // A right item the Agent adds or changes while the Session is open shows at once (not replayed ones).
  const [openedAt] = useState(() => Date.now());
  const lastRight = useMemo(() => ui.slots.right.reduce<Slot | null>((a, x) => (!a || x.ts > a.ts ? x : a), null), [ui.slots.right]);
  useEffect(() => {
    if (lastRight && lastRight.ts >= openedAt) show({ kind: "slot", id: lastRight.id });
  }, [lastRight?.id, lastRight?.ts, openedAt, show]);
  const changeCount = useMemo(() => state.items.reduce((n, i) => n + (i.type === "changes" ? 1 : 0), 0), [state.items]);

  const sideThreads = useMemo(() => state.threadList.filter((t) => !t.main), [state.threadList]);
  // Tabs that have something to show (slots and Side Threads arrive with the replay).
  const tabs = panel.tabs.filter((t) => t.kind === "slot" ? ui.slots.right.some((x) => x.id === t.id) : t.kind === "thread" ? !!state.threads[t.id] : true);
  const tabLabel = (t: PanelTab) => {
    switch (t.kind) {
      case "changes": return "Changes";
      case "terminal": return "Terminal";
      case "slot": { const x = ui.slots.right.find((s) => s.id === t.id); return x?.title ?? x?.id ?? t.id; }
      case "thread": return sideThreads.find((x) => x.id === t.id)?.title ?? "Side thread";
    }
  };
  const activeShown = !!active && tabs.some((t) => sameTab(t, active));
  const showStrip = activeShown && (tabs.length > 1 || active?.kind === "thread");

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
  const toolbarButton = "size-7 text-muted-foreground hover:text-accent-foreground";
  const actions = (
    <>
      {!status && toolbar && badge}
      {ui.slots.right.map((x) => (
        <SlotTab key={x.id} slot={x} open={active?.kind === "slot" && active.id === x.id} onClick={() => toggle({ kind: "slot", id: x.id })} />
      ))}
      <Tooltip content="New side thread (Cmd/Ctrl+Shift+B)" side="bottom">
        <Button size="icon" variant="ghost" className={toolbarButton} aria-label="New side thread" onClick={() => void newSideThread()}>
          <GitFork />
        </Button>
      </Tooltip>
      {sideThreads.length > 0 && (
        <DropdownMenu>
          <Tooltip content="Side threads" side="bottom">
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost" className={cn(toolbarButton, active?.kind === "thread" && "bg-accent text-accent-foreground")} aria-label="Side threads">
                <MessagesSquare />
              </Button>
            </DropdownMenuTrigger>
          </Tooltip>
          <DropdownMenuContent align="end" className="w-72">
            <DropdownMenuLabel>Side threads</DropdownMenuLabel>
            {sideThreads.map((t) => {
              const tab: PanelTab = { kind: "thread", id: t.id };
              const st = state.threads[t.id];
              return (
                <DropdownMenuItem key={t.id} className="flex-col items-start gap-0" onSelect={() => show(tab)}>
                  <span className={cn("w-full truncate", panel.tabs.some((x) => sameTab(x, tab)) && "font-medium")}>{t.title ?? "Empty side thread"}</span>
                  <span className="text-xs text-muted-foreground">{st ? startText(st) : "Side thread"} · {t.turns} {t.turns === 1 ? "turn" : "turns"}</span>
                </DropdownMenuItem>
              );
            })}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void newSideThread()}>
              New side thread <DropdownMenuShortcut>⇧⌘B</DropdownMenuShortcut>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <Tooltip content="Terminal (Ctrl+`)" side="bottom">
        <Button
          size="icon"
          variant="ghost"
          className={cn(toolbarButton, active?.kind === "terminal" && "bg-accent text-accent-foreground")}
          aria-label="Terminal"
          aria-pressed={active?.kind === "terminal"}
          onClick={toggleTerminal}
        >
          <SquareTerminal />
        </Button>
      </Tooltip>
      {git && (
        <Tooltip content="Changes" side="bottom">
          <Button
            size="icon"
            variant="ghost"
            className={cn(toolbarButton, active?.kind === "changes" && "bg-accent text-accent-foreground")}
            aria-label="Changes"
            aria-pressed={active?.kind === "changes"}
            onClick={() => toggle(CHANGES)}
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
      <SelectionComment sessionId={api.sessionId} onAskSideThread={(excerpt) => void newSideThread(excerpt)} />
      <TaskListPanel entries={state.taskList} />
      <Slots slots={ui.slots.top} env={env} className="border-b pt-3" />
      <MessageList
        api={api}
        state={state}
        threadId={state.mainThreadId ?? ""}
        side={false}
        env={env}
        ui={ui}
        rows={rows}
        subagents={subagents}
        onOpenDiff={openDiff}
        empty="Send a message to start."
      />
      <Slots slots={ui.slots.bottom} env={env} className="pt-1" />
      {sideError && <p role="alert" className="px-6 pb-2 text-xs text-destructive">{sideError}</p>}
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
        <PromptBox api={api} state={state} onSideThread={btw} />
      )}
    </div>
    {(activeShown || terminalOpened) && (
      <div className={cn("relative flex h-full shrink-0 flex-col", !activeShown && "hidden")} style={{ width: right.width }}>
        <ResizeHandle label="Resize panel" {...right.handle} />
        {showStrip && (
          <div role="tablist" aria-label="Panel" className="flex shrink-0 gap-0.5 overflow-x-auto border-b border-l bg-background px-1.5 pt-1.5">
            {tabs.map((t) => {
              const on = sameTab(t, active);
              return (
                <div key={tabKey(t)} className={cn("flex min-w-0 max-w-48 items-center rounded-t-md border border-b-0 text-xs", on ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/50")}>
                  <button role="tab" aria-selected={on} className="min-w-0 truncate py-1.5 pl-2.5 pr-2" onClick={() => show(t)}>
                    {t.kind === "thread" && <GitFork className="mr-1 inline size-3 align-[-1px]" />}
                    {tabLabel(t)}
                  </button>
                  {t.kind === "thread" && (
                    <button className="mr-1 rounded p-0.5 hover:bg-background/60" aria-label={`Close ${tabLabel(t)}`} onClick={() => close(t)}>
                      <X className="size-3" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <div className="relative min-h-0 flex-1">
          {active?.kind === "changes" && <DiffPanel api={api} scope={scope} onScope={setScope} onClose={() => close(CHANGES)} refreshKey={refreshKey} />}
          {rightSlot && <SlotPanel slot={rightSlot} env={env} onClose={() => close({ kind: "slot", id: rightSlot.id })} />}
          {terminalOpened && (
            <div className={cn("h-full", active?.kind !== "terminal" && "hidden")}>
              <Suspense fallback={null}>
                <TerminalPanel api={api} active={active?.kind === "terminal"} onClose={() => close(TERMINAL)} />
              </Suspense>
            </div>
          )}
          {/* Open Side Threads stay mounted (hidden) so a half-typed prompt survives switching tabs. */}
          {tabs.map((t) => {
            const st = t.kind === "thread" ? state.threads[t.id] : null;
            if (t.kind !== "thread" || !st) return null;
            return (
              <div key={t.id} className={cn("h-full", !sameTab(t, active) && "hidden")}>
                <ThreadView api={api} thread={st} threadId={t.id} env={env} onOpenDiff={openDiff} focusKey={focus.id === t.id ? focus.n : 0} />
              </div>
            );
          })}
        </div>
      </div>
    )}
    </div>
  );
}
