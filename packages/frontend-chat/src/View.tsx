import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive, CheckCircle2, CircleDashed, GitCompare, Layers, Loader2, MessagesSquare, PanelLeft, PanelRight, RotateCcw, ScrollText, SquareTerminal, X } from "lucide-react";
import type { AttachmentInput, SessionApi } from "@harness/api";
import { useSessionEvents } from "@harness/api";
import {
  Badge, Button, MenuButton, Portal, Tooltip, cn, type VirtualListHandle,
} from "@harness/ui";
import { ALL_CHANGES, DiffPanel, type DiffScope } from "./DiffPanel";
import { PromptBox } from "./PromptBox";
import { ScrollUnder } from "./ScrollUnder";
// xterm.js stays out of the main chunk until the Terminal is first opened.
const TerminalPanel = lazy(() => import("./TerminalPanel"));
import { DiffWindow, diffWindowScope } from "./DiffWindow";
import { MessageList, useRows } from "./Messages";
import { DockLayout, type DockPanel } from "./DockLayout";
import { EventsPanel } from "./EventsPanel";
import { collectArtifacts, type Artifact } from "./artifacts";
import { ArtifactsPanel } from "./ArtifactsPanel";
import { PanelHeader } from "./PanelHeader";
import { SidePanel } from "./SidePanel";
import { Stripe, type StripeGroup, type StripeItem } from "./Stripe";
import { SelectionComment } from "./SelectionComment";
import { RenderUi, type UiEnv } from "./RenderUi";
import type { Slot } from "./slots";
import { errorMessage } from "./errors";
import { addReviewComment, composerKey, setReviewComments } from "./reviewComments";
import { usePanelDrag } from "./panelDrag";
import { uiIcons } from "./uiIcons";
import {
  closeThread, expand, hide, isDraftThread, isOpen, isSlotPanel, loadLayout, move, openThread, replaceThread, reconcile, resetLayout, resize, saveLayout, selectThread, show,
  shownOpen, slotIdOf, slotPanel, toggle, type Layout, type PanelId, type Zone,
} from "./panelLayout";
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

function SlotPanel({ slot, env }: { slot: Slot; env: UiEnv }) {
  return (
    <>
      <PanelHeader title={slot.title ?? slot.id} />
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <RenderUi root={slot.root} env={{ ...env, files: slot.files }} />
      </div>
    </>
  );
}

// A pop-out diff window boots like a solo View window, with `pane=diff` in its URL.
const diffScope = typeof window === "undefined" ? null : diffWindowScope(window.location.search);

/** Claude Code desktop-like chat. Pure fold of the Session Log (see reducer.ts). */
export function View({ api, toolbar, status, menu }: { api: SessionApi; toolbar?: HTMLElement | null; status?: HTMLElement | null; menu?: HTMLElement | null }) {
  return diffScope ? <DiffWindow api={api} scope={diffScope} /> : <ChatView api={api} toolbar={toolbar} status={status} menu={menu} />;
}

/** Briefly rings an element the user jumped to. */
function flash(el: Element) {
  el.animate(
    [{ outline: "2px solid var(--ring)", outlineOffset: "4px", borderRadius: "8px" }, { outline: "2px solid transparent", outlineOffset: "4px", borderRadius: "8px" }],
    { duration: 1600, easing: "ease-in" },
  );
}


const BASE_LABEL: Record<string, string> = { side: "Side chats", changes: "Changes", terminal: "Terminal", events: "Events", artifacts: "Artifacts" };
const BASE_ICON: Record<string, React.ReactNode> = {
  side: <MessagesSquare />, changes: <GitCompare />, terminal: <SquareTerminal />, events: <ScrollText />, artifacts: <Layers />,
};

function ChatView({ api, toolbar, status, menu }: { api: SessionApi; toolbar?: HTMLElement | null; status?: HTMLElement | null; menu?: HTMLElement | null }) {
  const state = useSessionEvents(api, reduce, initialState, reduceBatch);
  const { ui, rows, subagents } = useRows(state.items);

  // render_ui items placed left or right are panels. Their default zone follows the placement.
  const slots = useMemo(
    () => [...ui.slots.left.map((slot) => ({ slot, zone: "leftTop" as Zone })), ...ui.slots.right.map((slot) => ({ slot, zone: "rightTop" as Zone }))],
    [ui.slots.left, ui.slots.right],
  );
  const slotPanels = useMemo(() => slots.map((s) => ({ id: slotPanel(s.slot.id), zone: s.zone })), [slots]);
  const slotPanelsRef = useRef(slotPanels);
  slotPanelsRef.current = slotPanels;

  /** Where the panels sit, their sizes and the open side chats. Kept per Session. */
  const [layout, setLayout] = useState<Layout>(() => loadLayout(api.sessionId));
  useEffect(() => saveLayout(api.sessionId, layout), [api.sessionId, layout]);
  /** Every change goes through reconcile first, so a panel that just appeared (a slot) has its place. */
  const update = useCallback((f: (l: Layout) => Layout) => setLayout((l) => f(reconcile(l, slotPanelsRef.current))), []);
  const lay = useMemo(() => reconcile(layout, slotPanels), [layout, slotPanels]);
  useEffect(() => { if (lay !== layout) setLayout(lay); }, [lay, layout]);

  // Side chats: a prompt box takes focus in the chat that was just created.
  const [focus, setFocus] = useState<{ id: string; n: number }>({ id: "", n: 0 });
  const [sideError, setSideError] = useState<string | null>(null);
  const layRef = useRef(lay);
  layRef.current = lay;
  /** Starts a Side Thread now (forked from Main when the Agent can), in place of tab `draft` or as a new tab, and sends it `text`. */
  const startSideThread = useCallback(
    async (text: string, attachments: AttachmentInput[], draft?: string) => {
      setSideError(null);
      let thread_id: string;
      try {
        ({ thread_id } = await api.startSideThread());
      } catch (e) {
        setSideError(errorMessage(e));
        throw e;
      }
      update((l) => (draft && l.threads.includes(draft) ? replaceThread(l, draft, thread_id) : openThread(l, thread_id)));
      setFocus((f) => ({ id: thread_id, n: f.n + 1 }));
      await api.prompt(text, attachments, thread_id);
    },
    [api, update],
  );
  /** A new side chat tab (an open draft is reused). Its Side Thread starts with its first message. */
  const newSideThread = useCallback(() => {
    const id = layRef.current.threads.find(isDraftThread) ?? `draft:${crypto.randomUUID()}`;
    update((l) => openThread(l, id));
    setFocus((f) => ({ id, n: f.n + 1 }));
    return id;
  }, [update]);
  /** "Ask in side thread": a new side chat with the selected text as a quote chip in its prompt box. */
  const askSideThread = useCallback(
    (quote: string) => addReviewComment(composerKey(api.sessionId, newSideThread()), { kind: "quote", quote, text: "" }),
    [api, newSideThread],
  );
  /** `/btw <text>` in the Main prompt box: a Side Thread whose first prompt is `text`. */
  const btw = useCallback((text: string, attachments: AttachmentInput[]) => startSideThread(text, attachments), [startSideThread]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ctrl+` toggles the Terminal, as in VS Code. Capture phase, so xterm never sees it.
      if (e.ctrlKey && !e.metaKey && !e.altKey && (e.code === "Backquote" || e.key === "`")) {
        e.preventDefault();
        e.stopPropagation();
        update((l) => toggle(l, "terminal"));
      }
      // Cmd/Ctrl+Shift+B: a new Side Thread ("by the way").
      else if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.code === "KeyB") {
        e.preventDefault();
        e.stopPropagation();
        newSideThread();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [update, newSideThread]);
  const [scope, setScope] = useState<DiffScope>(ALL_CHANGES);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  // Changes need git; hidden until the Workspace is known to be a repository.
  const [git, setGit] = useState(false);
  useEffect(() => {
    let off = false;
    api.workspace().then((w) => !off && setGit(!!w?.repo_root), () => {});
    return () => { off = true; };
  }, [api]);

  const openDiff = useCallback((s: DiffScope) => { setScope(s); update((l) => show(l, "changes")); }, [update]);
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
  // A left or right item the Agent adds or changes while the Session is open shows at once (not replayed ones).
  const [openedAt] = useState(() => Date.now());
  const lastSlot = useMemo(() => slots.reduce<Slot | null>((a, x) => (!a || x.slot.ts > a.ts ? x.slot : a), null), [slots]);
  useEffect(() => {
    if (lastSlot && lastSlot.ts >= openedAt) update((l) => show(l, slotPanel(lastSlot.id)));
  }, [lastSlot?.id, lastSlot?.ts, openedAt, update]);
  const artifacts = useMemo(() => collectArtifacts(state.items), [state.items]);
  const list = useRef<VirtualListHandle>(null);
  const jump = useCallback((a: Artifact) => {
    if (a.placement === "right" || a.placement === "left") {
      if (a.slotId) update((l) => show(l, slotPanel(a.slotId!)));
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
  }, [update]);
  const changeCount = useMemo(() => state.items.reduce((n, i) => n + (i.type === "changes" ? 1 : 0), 0), [state.items]);

  const sideThreads = useMemo(() => state.threadList.filter((t) => !t.main), [state.threadList]);
  // Open side chats that have something to show (they arrive with the replay).
  const openThreads = lay.threads.filter((id) => isDraftThread(id) || !!state.threads[id]);
  const activeThread = lay.thread && openThreads.includes(lay.thread) ? lay.thread : (openThreads.at(-1) ?? null);
  const threadTitle = (id: string) => (isDraftThread(id) ? "New chat" : (sideThreads.find((x) => x.id === id)?.title ?? "Side chat"));

  // Panels with an icon, and those that can show now. The layout keeps the rest where they are.
  const slotById = useMemo(() => new Map(slots.map((s) => [slotPanel(s.slot.id), s.slot])), [slots]);
  const available = useMemo(() => {
    const a = new Set<PanelId>(["side", "terminal", "events", ...slotById.keys()]);
    if (git) a.add("changes");
    if (artifacts.length > 0 || isOpen(lay, "artifacts")) a.add("artifacts");
    return a;
  }, [slotById, git, artifacts.length, lay]);
  const shown = useMemo(() => {
    const renderable = new Set(available);
    if (openThreads.length === 0) renderable.delete("side");
    return shownOpen(lay, renderable);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available, lay, openThreads.length]);
  const open = (id: PanelId) => isOpen(shown, id);

  /** The Terminal stays mounted (hidden) once opened, so its screen survives hiding and moving. */
  const [terminalOpened, setTerminalOpened] = useState(false);
  useEffect(() => { if (open("terminal")) setTerminalOpened(true); });

  // A dot on a slot's icon marks changes made while it was closed (its first sight counts as seen).
  const slotKey = (x: Slot) => JSON.stringify(x.root);
  const [seen, setSeen] = useState<Record<string, string>>({});
  useEffect(() => {
    setSeen((prev) => {
      let next = prev;
      for (const { slot } of slots) {
        const k = slotKey(slot);
        if ((open(slotPanel(slot.id)) || !(slot.id in prev)) && prev[slot.id] !== k) next = { ...next, [slot.id]: k };
      }
      return next;
    });
  });

  const { drag, start: startDrag } = usePanelDrag((id, t) => update((l) => move(l, id, t.zone, t.index ?? undefined)));

  const label = (id: PanelId) => (isSlotPanel(id) ? (slotById.get(id)?.title ?? slotIdOf(id)!) : BASE_LABEL[id]!);
  const icon = (id: PanelId) => {
    if (!isSlotPanel(id)) return BASE_ICON[id];
    const Custom = uiIcons[slotById.get(id)?.icon as keyof typeof uiIcons];
    if (Custom) return <Custom />;
    return lay.zones.leftTop.includes(id) || lay.zones.leftBottom.includes(id) ? <PanelLeft /> : <PanelRight />;
  };
  const tip = (id: PanelId) => (id === "side" ? "Side chats (⇧⌘B new)" : label(id));
  const count = (id: PanelId) => (id === "side" ? sideThreads.length : id === "artifacts" ? artifacts.length : undefined);
  const shortcut = (id: PanelId) => (id === "terminal" ? ["⌃", "`"] : undefined);
  const group = (zone: Zone): StripeGroup => ({
    zone,
    items: lay.zones[zone].flatMap((id, index): StripeItem[] => {
      if (!available.has(id)) return [];
      const slot = slotById.get(id);
      const on = shown.open[zone] === id;
      return [{ id, index, label: label(id), tip: tip(id), count: count(id), shortcut: shortcut(id), icon: icon(id), on, dot: !!slot && !on && slot.id in seen && seen[slot.id] !== slotKey(slot) }];
    }),
  });
  const left: [StripeGroup, StripeGroup, StripeGroup] = [group("leftTop"), group("leftBottom"), group("bottomLeft")];
  const right: [StripeGroup, StripeGroup, StripeGroup] = [group("rightTop"), group("rightBottom"), group("bottomRight")];
  const leftEmpty = left.every((g) => g.items.length === 0);

  /** A stripe icon or shortcut for the side chats: hides them, else shows the last active chat, else starts a new one. */
  const toggleSide = () => {
    if (open("side")) update((l) => hide(l, "side"));
    else if (activeThread) update((l) => show(selectThread(l, activeThread), "side"));
    else newSideThread();
  };
  const onToggle = (id: PanelId) => (id === "side" ? toggleSide() : update((l) => toggle(l, id)));

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

  const panels: DockPanel[] = [];
  if (openThreads.length > 0) {
    panels.push({
      id: "side",
      label: "Side chats",
      children: (
        <SidePanel
          api={api} state={state} threads={openThreads} active={activeThread} titleOf={threadTitle} env={env} focus={focus}
          onSelect={(id) => update((l) => selectThread(l, id))} onClose={(id) => { if (isDraftThread(id)) setReviewComments(composerKey(api.sessionId, id), []); update((l) => closeThread(l, id)); }}
          onNew={newSideThread} onSendDraft={(id, text, files) => startSideThread(text, files, id)} onOpenDiff={openDiff}
        />
      ),
    });
  }
  if (open("changes")) panels.push({ id: "changes", label: "Changes", children: <DiffPanel api={api} scope={scope} onScope={setScope} refreshKey={refreshKey} /> });
  if (terminalOpened) {
    panels.push({
      id: "terminal",
      label: "Terminal",
      children: (
        <Suspense fallback={null}>
          <TerminalPanel api={api} active={open("terminal")} />
        </Suspense>
      ),
    });
  }
  if (open("events")) panels.push({ id: "events", label: "Events", expandable: true, children: <EventsPanel api={api} /> });
  if (open("artifacts")) panels.push({ id: "artifacts", label: "Artifacts", children: <ArtifactsPanel artifacts={artifacts} env={env} onJump={jump} /> });
  for (const [id, slot] of slotById) {
    if (open(id)) panels.push({ id, label: slot.title ?? slot.id, children: <SlotPanel slot={slot} env={env} /> });
  }

  const chat = (
    <>
      {!toolbar && (
        <div className="flex h-13 shrink-0 items-center gap-2 border-b px-5">
          <span className="truncate text-sm font-semibold">{state.title ?? "New Session"}</span>
          {badge}
        </div>
      )}
      {toolbar && !status && <Portal container={toolbar}>{badge}</Portal>}
      {toolbar && <Portal container={status}>{badge}</Portal>}
      <Portal container={menu}>
        <MenuButton onClick={() => update(resetLayout)}><RotateCcw /> Reset layout</MenuButton>
      </Portal>
      <SelectionComment sessionId={api.sessionId} onAskSideThread={(quote) => void askSideThread(quote)} />
      <TaskListPanel entries={state.taskList} />
      <Slots slots={ui.slots.top} env={env} className="border-b pt-3" />
      <ScrollUnder
        bottom={
          <>
            <Slots slots={ui.slots.bottom} env={env} className="pt-1" />
            {sideError && <p role="alert" className="px-6 pb-2 text-xs text-destructive">{sideError}</p>}
            {state.archived ? (
              <div role="alert" className="p-3">
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
          </>
        }
      >
        {(inset) => (
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
            inset={inset}
          />
        )}
      </ScrollUnder>
    </>
  );

  return (
    <div className="relative flex h-full">
      {(!leftEmpty || drag) && <Stripe side="left" groups={left} drag={drag} overlay={leftEmpty} onToggle={onToggle} onPress={(it, e) => startDrag(it.id, it.label, e)} />}
      <DockLayout
        layout={shown}
        chat={chat}
        panels={panels}
        drag={drag}
        leftStripeOverlay={leftEmpty}
        onResize={(patch) => update((l) => resize(l, patch))}
        onMove={(id, zone) => update((l) => move(l, id, zone))}
        onHide={(id) => update((l) => hide(l, id))}
        onExpand={(id) => update((l) => expand(l, id))}
        onDragStart={startDrag}
      />
      <Stripe side="right" groups={right} drag={drag} onToggle={onToggle} onPress={(it, e) => startDrag(it.id, it.label, e)} />
      {drag && (
        <div
          aria-hidden
          className="pointer-events-none fixed z-[60] flex items-center gap-2 rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-lg [&_svg]:size-4"
          style={{ left: drag.x + 12, top: drag.y + 12 }}
        >
          {icon(drag.id)} {drag.label}
        </div>
      )}
    </div>
  );
}
