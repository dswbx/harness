import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive, CheckCircle2, CircleDashed, GitCompare, Layers, Loader2, MessagesSquare, PanelRight, Plus, ScrollText, SquareTerminal, X } from "lucide-react";
import type { AttachmentInput, SessionApi } from "@harness/api";
import { useSessionEvents } from "@harness/api";
import {
  Badge, Button, Portal, ResizeHandle, Tooltip, cn, useResizableWidth, type VirtualListHandle,
} from "@harness/ui";
import { ALL_CHANGES, DiffPanel, type DiffScope } from "./DiffPanel";
import { PromptBox } from "./PromptBox";
// xterm.js stays out of the main chunk until the Terminal is first opened.
const TerminalPanel = lazy(() => import("./TerminalPanel"));
import { DiffWindow, diffWindowScope } from "./DiffWindow";
import { MessageList, useRows } from "./Messages";
import { ThreadView } from "./ThreadView";
import { EventsPanel } from "./EventsPanel";
import { collectArtifacts, type Artifact } from "./artifacts";
import { ArtifactsPanel } from "./ArtifactsPanel";
import { SelectionComment } from "./SelectionComment";
import { RenderUi, type UiEnv } from "./RenderUi";
import type { Slot } from "./slots";
import { errorMessage } from "./errors";
import { addReviewComment, composerKey } from "./reviewComments";
import { closeThread, loadPanel, openThread, savePanel, selectThread, showView, toggleView, type PanelState, type PanelView } from "./panelTabs";
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

const CHANGES: PanelView = { kind: "changes" };
const TERMINAL: PanelView = { kind: "terminal" };
const SIDE: PanelView = { kind: "side" };
const EVENTS: PanelView = { kind: "events" };
const ARTIFACTS: PanelView = { kind: "artifacts" };

/** Briefly rings an element the user jumped to. */
function flash(el: Element) {
  el.animate(
    [{ outline: "2px solid var(--ring)", outlineOffset: "4px", borderRadius: "8px" }, { outline: "2px solid transparent", outlineOffset: "4px", borderRadius: "8px" }],
    { duration: 1600, easing: "ease-in" },
  );
}

function ChatView({ api, toolbar, status }: { api: SessionApi; toolbar?: HTMLElement | null; status?: HTMLElement | null }) {
  const state = useSessionEvents(api, reduce, initialState, reduceBatch);
  /** The right panel: the view shown (side chats, Changes, Terminal, Events (the raw Session Log), Artifacts or a right render_ui item) and the open side chats. Kept per Session. */
  const [panel, setPanel] = useState<PanelState>(() => loadPanel(api.sessionId));
  useEffect(() => savePanel(api.sessionId, panel), [api.sessionId, panel]);
  const active = panel.view;
  const show = useCallback((v: PanelView) => setPanel((p) => showView(p, v)), []);
  const toggle = useCallback((v: PanelView) => setPanel((p) => toggleView(p, v)), []);
  const closePanel = useCallback(() => setPanel((p) => ({ ...p, view: null })), []);
  /** The Terminal stays mounted (hidden) once opened, so its screen survives switching panels. */
  const [terminalOpened, setTerminalOpened] = useState(false);
  const toggleTerminal = useCallback(() => {
    setTerminalOpened(true);
    toggle(TERMINAL);
  }, [toggle]);

  // Side chats: a prompt box takes focus in the chat that was just created.
  const [focus, setFocus] = useState<{ id: string; n: number }>({ id: "", n: 0 });
  const [sideError, setSideError] = useState<string | null>(null);
  /** Opens a Side Thread (forked from Main when the Agent can), shows it, and returns its id. */
  const newSideThread = useCallback(
    async () => {
      setSideError(null);
      try {
        const { thread_id } = await api.startSideThread();
        setPanel((p) => openThread(p, thread_id));
        setFocus((f) => ({ id: thread_id, n: f.n + 1 }));
        return thread_id;
      } catch (e) {
        setSideError(errorMessage(e));
        return null;
      }
    },
    [api],
  );
  /** "Ask in side thread": a new Side Thread with the selected text as a quote chip in its prompt box. */
  const askSideThread = useCallback(
    async (quote: string) => {
      const id = await newSideThread();
      if (id) addReviewComment(composerKey(api.sessionId, id), { kind: "quote", quote, text: "" });
    },
    [api, newSideThread],
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
  const artifacts = useMemo(() => collectArtifacts(state.items), [state.items]);
  const list = useRef<VirtualListHandle>(null);
  const jump = useCallback((a: Artifact) => {
    if (a.placement === "right") {
      if (a.slotId) show({ kind: "slot", id: a.slotId });
      return;
    }
    if (!a.rowId) {
      const el = document.querySelector(`[data-slot="${CSS.escape(a.slotId ?? "")}"]`);
      if (el) flash(el);
      return;
    }
    if (!list.current?.scrollToKey(a.rowId)) return;
    // The row renders once the virtual list scrolls there; then the diagram or table inside it.
    let tries = 0;
    const find = () => {
      const row = document.querySelector(`[data-key="${CSS.escape(a.rowId!)}"]`);
      const el = row && (a.index !== null ? row.querySelectorAll(`[data-artifact="${a.kind}"]`)[a.index] : row.firstElementChild);
      if (el) {
        el.scrollIntoView({ block: "center" });
        flash(el);
      } else if (tries++ < 30) requestAnimationFrame(find);
    };
    requestAnimationFrame(find);
  }, [show]);
  const changeCount = useMemo(() => state.items.reduce((n, i) => n + (i.type === "changes" ? 1 : 0), 0), [state.items]);

  const sideThreads = useMemo(() => state.threadList.filter((t) => !t.main), [state.threadList]);
  // Open side chats that have something to show (they arrive with the replay).
  const openThreads = panel.threads.filter((id) => !!state.threads[id]);
  const activeThread = panel.thread && openThreads.includes(panel.thread) ? panel.thread : (openThreads.at(-1) ?? null);
  const sideShown = active?.kind === "side" && activeThread !== null;
  const activeShown = sideShown || (!!active && active.kind !== "side" && (active.kind !== "slot" || !!rightSlot));
  const threadTitle = (id: string) => sideThreads.find((x) => x.id === id)?.title ?? "Side chat";
  /** The toolbar button: hides the side chats, else shows the last active one, else starts a new one. */
  const toggleSide = () => {
    if (active?.kind === "side") closePanel();
    else if (activeThread) setPanel((p) => ({ ...selectThread(p, activeThread), view: SIDE }));
    else void newSideThread();
  };
  const closeSide = (id: string) => setPanel((p) => closeThread(p, id));

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
      {(artifacts.length > 0 || active?.kind === "artifacts") && (
        <Tooltip content={`Artifacts (${artifacts.length})`} side="bottom">
          <Button
            size="icon"
            variant="ghost"
            className={cn(toolbarButton, active?.kind === "artifacts" && "bg-accent text-accent-foreground")}
            aria-label="Artifacts"
            aria-pressed={active?.kind === "artifacts"}
            onClick={() => toggle(ARTIFACTS)}
          >
            <Layers />
          </Button>
        </Tooltip>
      )}
      <Tooltip content="Events" side="bottom">
        <Button
          size="icon"
          variant="ghost"
          className={cn(toolbarButton, active?.kind === "events" && "bg-accent text-accent-foreground")}
          aria-label="Events"
          aria-pressed={active?.kind === "events"}
          onClick={() => toggle(EVENTS)}
        >
          <ScrollText />
        </Button>
      </Tooltip>
      <Tooltip content="Side chats (Cmd/Ctrl+Shift+B for a new one)" side="bottom">
        <Button
          size="icon"
          variant="ghost"
          className={cn(toolbarButton, active?.kind === "side" && "bg-accent text-accent-foreground")}
          aria-label="Side chats"
          aria-pressed={active?.kind === "side"}
          onClick={toggleSide}
        >
          <MessagesSquare />
        </Button>
      </Tooltip>
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
      <SelectionComment sessionId={api.sessionId} onAskSideThread={(quote) => void askSideThread(quote)} />
      <TaskListPanel entries={state.taskList} />
      <Slots slots={ui.slots.top} env={env} className="border-b pt-3" />
      <MessageList
        handle={list}
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
        {sideShown && (
          <div role="tablist" aria-label="Side chats" className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-l bg-background px-2.5 py-2">
            {openThreads.map((id) => {
              const on = id === activeThread;
              const title = threadTitle(id);
              return (
                <div key={id} className={cn("flex h-[26px] max-w-[170px] shrink-0 items-center gap-1 rounded-md pl-2.5 pr-[3px] text-xs", on ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/50")}>
                  <button role="tab" aria-selected={on} className="min-w-0 truncate" onClick={() => setPanel((p) => selectThread(p, id))}>{title}</button>
                  <button className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-background/60 hover:text-accent-foreground" aria-label={`Close ${title}`} onClick={() => closeSide(id)}>
                    <X className="size-3" />
                  </button>
                </div>
              );
            })}
            <Tooltip content="New side chat" side="bottom">
              <Button size="icon" variant="ghost" className="size-[26px] shrink-0 text-muted-foreground hover:text-accent-foreground" aria-label="New side chat" onClick={() => void newSideThread()}>
                <Plus />
              </Button>
            </Tooltip>
          </div>
        )}
        <div className="relative min-h-0 flex-1">
          {active?.kind === "changes" && <DiffPanel api={api} scope={scope} onScope={setScope} onClose={closePanel} refreshKey={refreshKey} />}
          {active?.kind === "events" && <EventsPanel api={api} onClose={closePanel} />}
          {active?.kind === "artifacts" && <ArtifactsPanel artifacts={artifacts} env={env} onJump={jump} onClose={closePanel} />}
          {rightSlot && <SlotPanel slot={rightSlot} env={env} onClose={closePanel} />}
          {terminalOpened && (
            <div className={cn("h-full", active?.kind !== "terminal" && "hidden")}>
              <Suspense fallback={null}>
                <TerminalPanel api={api} active={active?.kind === "terminal"} onClose={closePanel} />
              </Suspense>
            </div>
          )}
          {/* Open side chats stay mounted (hidden) so a half-typed prompt survives switching chats and views. */}
          {openThreads.map((id) => (
            <div key={id} className={cn("h-full", !(sideShown && id === activeThread) && "hidden")}>
              <ThreadView api={api} thread={state.threads[id]!} threadId={id} env={env} onOpenDiff={openDiff} focusKey={focus.id === id ? focus.n : 0} />
            </div>
          ))}
        </div>
      </div>
    )}
    </div>
  );
}
