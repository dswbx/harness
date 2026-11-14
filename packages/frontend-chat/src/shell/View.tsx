import type {
   AgentSwitch,
   AttachmentInput,
   OverlayFrame,
   PanelWidth,
   PromptContext,
   SessionApi,
   ViewVariant,
} from "@harness/api";
import { useSessionEvents, useSharedArtifacts } from "@harness/api";
import {
   Badge,
   Button,
   cn,
   MenuButton,
   Portal,
   Tooltip,
   type VirtualListHandle,
} from "@harness/ui";
import {
   Archive,
   CheckCircle2,
   CircleDashed,
   Loader2,
   PanelLeft,
   PanelRight,
   RotateCcw,
   X,
} from "lucide-react";
import {
   type ComponentProps,
   type ReactNode,
   Suspense,
   useCallback,
   useEffect,
   useMemo,
   useRef,
   useState,
} from "react";
import { blockMarkdown } from "../features/artifacts/artifacts";
import type { ArtifactsModel } from "../features/artifacts/panel";
import type { DiffScope } from "../features/changes/DiffPanel";
import { DiffWindow, diffWindowScope } from "../features/changes/DiffWindow";
import { changesPanel } from "../features/changes/panel";
import { MessageList, useRows } from "../features/conversation/Messages";
import { ScrollUnder } from "../features/conversation/ScrollUnder";
import { FileRefProvider, FileViewProvider } from "../features/files/FileRef";
import { FilesPanel, type FileTarget, filesWindowTarget } from "../features/files/FilesPanel";
import { filesPanel } from "../features/files/panel";
import { ShareBlock } from "../features/markdown/Expandable";
import { planPanel } from "../features/plan/panel";
import { PromptBox, type PromptBoxHandle } from "../features/prompt/PromptBox";
import { usePendingMessages, useSlow } from "../features/prompt/pendingMessages";
import { PrRefProvider } from "../features/prRefs/prRefs";
import { RenderUi, type UiEnv } from "../features/renderUi/RenderUi";
import { Env } from "../features/renderUi/runtime";
import { slotPanels } from "../features/renderUi/slotPanels";
import type { Slot } from "../features/renderUi/slots";
import { RENDER_UI, sharedRef } from "../features/renderUi/tools";
import { quotableAttrs, SelectionComment } from "../features/review/SelectionComment";
import type { SideChatsModel } from "../features/sideChats/panel";
import { placeSteps } from "../features/toolDisplay/group";
import { OpenStep, type OpenStepRequest } from "../features/toolDisplay/openStep";
import { flash } from "../lib/flash";
import { OpenSession } from "../lib/OpenSession";
import { type ChatState, initialState, reduce, reduceBatch } from "../state/reducer";
import { DockLayout, type DockPanel } from "./dock/DockLayout";
import { shownOpen, sideWidths } from "./dock/geometry";
import {
   defaultLayout,
   expand,
   hide,
   isOpen,
   type Layout,
   move,
   reconcile,
   resetLayout,
   resize,
   show,
   toggle,
   type Zone,
} from "./dock/model";
import { OVERLAY_ZONES, overlayGeometry, overlayProfile, STRIPE_W } from "./dock/overlay";
import { usePanelDrag } from "./dock/panelDrag";
import { loadLayout, saveLayout } from "./dock/persist";
import { Stripe, type StripeGroup } from "./dock/Stripe";
import { PANELS } from "./panels";
import { type PanelPlace, usePanelHost } from "./usePanelHost";
import { availablePanels, renderablePanels, stripeGroup } from "./viewState";

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
               <li
                  key={i}
                  className={cn(
                     "flex items-center gap-2",
                     t.status === "completed" && "text-muted-foreground line-through",
                  )}
               >
                  {t.status === "completed" ? (
                     <CheckCircle2 className="size-3.5 text-emerald-500" />
                  ) : t.status === "in_progress" ? (
                     <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                     <CircleDashed className="size-3.5 text-muted-foreground" />
                  )}
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
                  <div
                     {...quotableAttrs(null, false, { source: "artifact", label: x.title ?? x.id })}
                  >
                     <RenderUi root={x.root} env={{ ...env, files: x.files, item: x.id }} />
                  </div>
               </div>
            ))}
         </div>
      </div>
   );
}

// A pop-out diff window boots like a solo View window, with `pane=diff` in its URL.
const diffScope = typeof window === "undefined" ? null : diffWindowScope(window.location.search);
// The pop-out Files window likewise, with `pane=files`.
const filesWindow =
   typeof window === "undefined" ? null : filesWindowTarget(window.location.search);
const filesWindowFirst: FileTarget | null = filesWindow?.path
   ? { path: filesWindow.path, start: filesWindow.line, end: filesWindow.line }
   : null;

/** Claude Code desktop-like chat. Pure fold of the Session Log (see reducer.ts). */
export function View({
   api,
   toolbar,
   status,
   indicator,
   menu,
   onGitRefresh,
   variant = "full",
   agentSwitch,
   chatFrame,
   onPanelWidth,
   overlayFrame,
   context,
   onOpenShared,
   onOpenSession,
}: {
   api: SessionApi;
   toolbar?: HTMLElement | null;
   status?: HTMLElement | null;
   indicator?: HTMLElement | null;
   menu?: HTMLElement | null;
   onGitRefresh?: () => void;
   variant?: ViewVariant;
   agentSwitch?: AgentSwitch;
   chatFrame?: (chat: ReactNode) => ReactNode;
   onPanelWidth?: (width: PanelWidth) => void;
   overlayFrame?: OverlayFrame;
   context?: PromptContext;
   onOpenShared?: (id: string) => void;
   onOpenSession?: (sessionId: string) => void;
}) {
   return diffScope ? (
      <DiffWindow api={api} scope={diffScope} />
   ) : filesWindow ? (
      <FileRefProvider api={api}>
         <FilesPanel api={api} target={filesWindowFirst} popout />
      </FileRefProvider>
   ) : (
      <OpenSession.Provider value={onOpenSession ?? null}>
         <ChatView
            api={api}
            toolbar={toolbar}
            status={status}
            indicator={indicator}
            menu={menu}
            onGitRefresh={onGitRefresh}
            variant={variant}
            agentSwitch={agentSwitch}
            chatFrame={chatFrame}
            onPanelWidth={onPanelWidth}
            overlayFrame={overlayFrame}
            context={context}
            onOpenShared={onOpenShared}
         />
      </OpenSession.Provider>
   );
}

/** What an Agent process state means, for the header's status dot. Ready shows nothing. */
const PROCESS_INFO: Record<string, { title: string; text: string; dot: string }> = {
   starting: {
      title: "Agent starting",
      text: "Connecting to the agent. Your message goes out when it is ready.",
      dot: "animate-pulse bg-sky-500",
   },
   stopped: {
      title: "Agent stopped",
      text: "Stopped while idle. It restarts on your next message.",
      dot: "bg-muted-foreground",
   },
   exited: {
      title: "Agent exited",
      text: "The agent process ended. It restarts on your next message.",
      dot: "bg-amber-500",
   },
   failed: {
      title: "Agent failed",
      text: "The agent process could not start.",
      dot: "bg-destructive",
   },
};

/**
 * The PR and file ref lookups sit above the chat, so the panels' models (which run in `ChatBody`) can use them.
 * `ChatBody` adds the viewer that shows a file in the Files panel.
 */
function ChatView(props: ComponentProps<typeof ChatBody>) {
   return (
      <PrRefProvider api={props.api}>
         <FileRefProvider api={props.api}>
            <ChatBody {...props} />
         </FileRefProvider>
      </PrRefProvider>
   );
}

function ChatBody({
   api,
   toolbar,
   status,
   indicator,
   menu,
   onGitRefresh,
   variant,
   agentSwitch,
   chatFrame,
   onPanelWidth,
   overlayFrame,
   context,
   onOpenShared,
}: {
   api: SessionApi;
   toolbar?: HTMLElement | null;
   status?: HTMLElement | null;
   indicator?: HTMLElement | null;
   menu?: HTMLElement | null;
   onGitRefresh?: () => void;
   variant: ViewVariant;
   agentSwitch?: AgentSwitch;
   chatFrame?: (chat: ReactNode) => ReactNode;
   onPanelWidth?: (width: PanelWidth) => void;
   overlayFrame?: OverlayFrame;
   context?: PromptContext;
   onOpenShared?: (id: string) => void;
}) {
   const overlay = variant === "overlay";
   const state = useSessionEvents(api, reduce, initialState, reduceBatch);
   // A Session with nothing in it yet is waiting for a message. The short wait lets the replay arrive.
   const prompt = useRef<PromptBoxHandle>(null);
   const hasItems = useRef(false);
   hasItems.current = state.items.length > 0;
   useEffect(() => {
      const t = setTimeout(() => {
         if (!hasItems.current) prompt.current?.focus();
      }, 150);
      return () => clearTimeout(t);
   }, []);
   const { ui, rows, subagents } = useRows(state.items, state.sharedAttached);

   // Shared Artifacts (ADR 0024): all of them, for titles and Session counts.
   const sharedSource = useMemo(
      () => ({
         list: () => api.listShared(),
         onListChanged: (f: () => void) => api.sharedListChanged(f),
      }),
      [api],
   );
   const sharedList = useSharedArtifacts(sharedSource);
   const sharedMetas = useMemo(
      () => new Map((sharedList ?? []).map((e) => [e.meta.id, e.meta])),
      [sharedList],
   );

   /**
    * Where the panels sit and their sizes. Kept per Session. The Quick overlay
    * has only the side zones (`overlayProfile`) and keeps its layout in memory: the main window's
    * stored layout of the Session stays as it is.
    */
   const fit = useCallback((l: Layout) => (overlay ? overlayProfile(l) : l), [overlay]);
   const [layout, setLayout] = useState<Layout>(() =>
      overlay ? overlayProfile(defaultLayout()) : loadLayout(api.sessionId),
   );
   useEffect(() => {
      if (!overlay) saveLayout(api.sessionId, layout);
   }, [overlay, api.sessionId, layout]);
   /** Every change goes through reconcile first, so a panel that just appeared (a slot) has its place. */
   const placesRef = useRef<PanelPlace[]>([]);
   const update = useCallback(
      (f: (l: Layout) => Layout) => setLayout((l) => fit(f(fit(reconcile(l, placesRef.current))))),
      [fit],
   );
   // The render_ui panels that exist (the panel host lists them, after the layout): each gets a place once.
   const [places, setPlaces] = useState<PanelPlace[]>([]);
   const lay = useMemo(() => fit(reconcile(layout, places)), [fit, layout, places]);
   useEffect(() => {
      if (lay !== layout) setLayout(lay);
   }, [lay, layout]);

   useEffect(() => {
      // The Quick overlay has no Terminal.
      if (overlay) return;
      const onKey = (e: KeyboardEvent) => {
         // A registered panel's shortcut (Cmd+J: the Terminal). Capture phase, so xterm never sees it.
         const def = PANELS.find((p) => p.shortcut?.match(e));
         if (def) {
            e.preventDefault();
            e.stopPropagation();
            update((l) => toggle(l, def.id as string));
         }
      };
      window.addEventListener("keydown", onKey, true);
      return () => window.removeEventListener("keydown", onKey, true);
   }, [overlay, update]);
   const [archiveError, setArchiveError] = useState<string | null>(null);
   const env = useMemo<UiEnv>(
      () => ({
         state: state.uiState,
         patch: (ops) => api.patchState(ops),
         report: (item, message) => {
            api.reportFrontendError(RENDER_UI, item, message).catch(() => {});
         },
         send: (text) => api.prompt(text),
         files: {},
         readImage: (p) => api.frontendReadImage(p),
         open: (p, line) => api.openInEditor(p, line),
         readSource: (name) => api.panelSourceRead(name),
         watchSources: (onChange) => api.panelSourceChanged(onChange),
         readShared: (id) => api.readShared(id),
         watchShared: (onChange) => api.sharedChanged(onChange),
         patchShared: (id, ops) => api.patchArtifactState(id, ops),
         scope: api.sessionId,
      }),
      [api, state.uiState],
   );
   const list = useRef<VirtualListHandle>(null);
   /** Scrolls the chat to a row; once the virtual list renders it, flashes what `pick` finds in it. */
   const jumpToRow = useCallback(
      (rowId: string, pick: (row: Element) => Element | null | undefined) => {
         if (!list.current?.scrollToKey(rowId)) return;
         let tries = 0;
         const find = () => {
            const row = document.querySelector(`[data-key="${CSS.escape(rowId)}"]`);
            const el = row && pick(row);
            if (el) {
               el.scrollIntoView({ block: "center" });
               flash(el);
            } else if (tries++ < 30) requestAnimationFrame(find);
         };
         requestAnimationFrame(find);
      },
      [],
   );
   // Shared Artifacts (ADR 0024): the Artifacts panel shows the panel of a shared artifact.
   const showShared = useCallback(
      (id: string) => {
         const slot = [...ui.slots.left, ...ui.slots.right].find((s) => sharedRef(s.source) === id);
         if (slot) update((l) => show(l, `${slotPanels.prefix}:${slot.id}`));
      },
      [ui.slots.left, ui.slots.right, update],
   );
   // A click in the Subagents panel opens the subagent's step in the chat (nested ones through their parents).
   const stepPlaces = useMemo(() => placeSteps(rows, subagents), [rows, subagents]);
   const [openStep, setOpenStep] = useState<OpenStepRequest | null>(null);
   const jumpToStep = useCallback(
      (id: string) => {
         const place = stepPlaces.get(id);
         if (!place) return;
         setOpenStep((o) => ({ path: place.path, nonce: (o?.nonce ?? 0) + 1 }));
         const { path } = place;
         const at = (row: Element, id: string) =>
            row.querySelector(`[data-step="${CSS.escape(id)}"]`);
         let tries = 0;
         // The step itself once its parents opened; Cards show only the outer subagent, so after a
         // while the deepest step shown. Its first child is the line (Trace) or header (Cards).
         jumpToRow(place.row, (row) => {
            let el = at(row, path.at(-1)!);
            if (!el && tries++ > 10)
               for (let i = path.length - 2; i >= 0 && !el; i--) el = at(row, path[i]!);
            return el && (el.firstElementChild ?? el);
         });
      },
      [stepPlaces, jumpToRow],
   );
   // The panels defined through the panel contract (shell/panels.ts): their context, selves, models and statuses.
   const panelChat = useMemo(
      () => ({ toRow: jumpToRow, toStep: jumpToStep }),
      [jumpToRow, jumpToStep],
   );
   const panelHostApi = useMemo(
      () => ({ openShared: onOpenShared, gitRefresh: onGitRefresh, sharedMetas, showShared }),
      [onOpenShared, onGitRefresh, sharedMetas, showShared],
   );
   const panelHost = usePanelHost({
      api,
      state,
      variant,
      lay,
      update,
      chat: panelChat,
      host: panelHostApi,
   });
   // Opening a panel at a target goes through the context (stable, so the chat's callbacks keep their identity).
   const openPanel = panelHost.ctx.open;
   /** Shows a file (a code lens, a comment chip) in the Files panel (the Quick overlay: the Files window). */
   const openFile = useCallback((ref: FileTarget) => openPanel(filesPanel, ref), [openPanel]);
   const openDiff = useCallback((scope: DiffScope) => openPanel(changesPanel, scope), [openPanel]);
   const openPlan = useCallback(
      (requestId: string) => openPanel(planPanel, requestId),
      [openPanel],
   );
   const { artifacts } = panelHost.models.artifacts as ArtifactsModel;
   const shareBlock = useCallback(
      (markdown: string, title?: string) => {
         const origin = artifacts.find(
            (a) => a.kind !== "ui" && blockMarkdown(a) === markdown,
         )?.key;
         void api
            .shareMarkdown(markdown, title, origin)
            .catch((e) => console.error("share failed", e));
      },
      [api, artifacts],
   );

   // The side chats' own actions: `/btw` in the Main prompt box, and "Ask in side thread" on a selection.
   const side = panelHost.models.side as SideChatsModel;
   const { start: startSideThread, ask: askSideThread } = side;
   const btw = useCallback(
      (text: string, attachments: AttachmentInput[]) => startSideThread(text, attachments),
      [startSideThread],
   );

   // Panels with an icon, and those that can show now. The layout keeps the rest where they are.
   // The Quick overlay shows only the panels marked `overlay` (ADR 0022 Phase 2).
   const available = useMemo(
      () =>
         availablePanels({
            overlay,
            statuses: panelHost.statuses,
            overlayPanels: panelHost.overlayIds,
         }),
      [overlay, panelHost.statuses, panelHost.overlayIds],
   );
   const renderable = useMemo(
      () => renderablePanels(available, panelHost.statuses),
      [available, panelHost.statuses],
   );
   const shown = useMemo(() => shownOpen(lay, renderable), [lay, renderable]);
   const open = (id: string) => isOpen(shown, id);

   // The render_ui panels the host lists get a place in the layout (a frame later, through `places`).
   placesRef.current = panelHost.places;
   useEffect(() => setPlaces(panelHost.places), [panelHost.places]);

   const { drag, start: startDrag } = usePanelDrag((id, t) =>
      update((l) => move(l, id, t.zone, t.index ?? undefined)),
   );

   const entryOf = useMemo(
      () => new Map(panelHost.entries.map((e) => [e.id as string, e])),
      [panelHost.entries],
   );
   const label = (id: string) => entryOf.get(id)?.label ?? id;
   // A panel without an icon of its own (a render_ui one without `icon`) gets the one of the side it is on.
   const icon = (id: string) => {
      const Own = entryOf.get(id)?.icon;
      if (Own) return <Own />;
      return lay.zones.leftTop.includes(id) || lay.zones.leftBottom.includes(id) ? (
         <PanelLeft />
      ) : (
         <PanelRight />
      );
   };
   const tip = (id: string) => panelHost.statuses.get(id)?.tip ?? label(id);
   const count = (id: string) => panelHost.statuses.get(id)?.badge;
   const shortcut = (id: string) => entryOf.get(id)?.shortcut;
   const dotOf = (id: string) => panelHost.statuses.get(id)?.dot;
   const group = (zone: Zone): StripeGroup =>
      stripeGroup(zone, {
         zones: lay.zones,
         openIn: shown.open[zone],
         available,
         dot: dotOf,
         label,
         tip,
         count,
         shortcut,
         icon,
      });
   const left: [StripeGroup, StripeGroup, StripeGroup] = [
      group("leftTop"),
      group("leftBottom"),
      group("bottomLeft"),
   ];
   const right: [StripeGroup, StripeGroup, StripeGroup] = [
      group("rightTop"),
      group("rightBottom"),
      group("bottomRight"),
   ];
   const leftEmpty = left.every((g) => g.items.length === 0);

   /** A stripe icon: hides the panel when it is shown, else the panel's own way to show (Side chats: its last chat), else shows it. */
   const onToggle = (id: string) => {
      const entry = entryOf.get(id);
      if (!open(id) && entry?.activate) entry.activate();
      else update((l) => toggle(l, id));
   };

   const proc = state.process;
   // The host's header shows it as a dot on its info icon, explained in that icon's menu; a header
   // of our own (no host header) shows a badge. Archived and deleted Sessions say so elsewhere.
   // Restoring the Agent Session takes longer than starting its process, and the process is
   // "ready" by then: a message on its way is what says the Agent is not ready yet.
   const pending = usePendingMessages(api.sessionId);
   const connecting = useSlow(pending.some((p) => p.status === "sending"));
   const procInfo = connecting
      ? PROCESS_INFO.starting
      : proc && proc.message !== "archived" && proc.message !== "deleted"
        ? PROCESS_INFO[proc.state]
        : undefined;
   const dot = procInfo && (
      <span
         role="status"
         aria-label={procInfo.title}
         className={cn("size-2 rounded-full ring-1 ring-background", procInfo.dot)}
      />
   );
   const detail = procInfo && (
      <div className="flex flex-col gap-1">
         <div className="flex items-center gap-2 font-medium">
            <span className={cn("size-2 shrink-0 rounded-full", procInfo.dot)} />
            {procInfo.title}
         </div>
         <p className="text-muted-foreground">
            {!connecting && proc?.message === "app_restart"
               ? "The app restarted, so the agent is not running. It starts on your next message."
               : procInfo.text}
         </p>
         {proc?.state === "failed" && proc.message && (
            <pre className="whitespace-pre-wrap break-words font-mono text-xs">{proc.message}</pre>
         )}
      </div>
   );
   const badge = proc && proc.state !== "ready" && (
      <Tooltip content={proc.message} side="bottom">
         <Badge variant={proc.state === "failed" ? "destructive" : "secondary"}>
            Agent {proc.state}
         </Badge>
      </Tooltip>
   );

   const panels: DockPanel[] = [];
   // Each hosted panel when it is mounted: open, or (by its definition) once opened or while it can show.
   for (const e of panelHost.entries) {
      const mounted =
         e.mount === "afterFirstOpen"
            ? e.self.opened
            : e.mount === "whileReady"
              ? renderable.has(e.id)
              : open(e.id);
      if (!mounted) continue;
      const Body = e.Body;
      panels.push({
         id: e.id,
         label: e.label,
         expandable: e.expandable,
         children: (
            <Suspense fallback={null}>
               <Body {...e.props} />
            </Suspense>
         ),
      });
   }

   // The Quick overlay's draft: before the first message the window has room only below the box
   // (it grows right and down for menus, ADR 0022).
   const overlayDraft = overlay && state.items.length === 0 && pending.length === 0;
   const promptBox = (
      <PromptBox
         ref={prompt}
         api={api}
         state={state}
         onSideThread={btw}
         agentSwitch={agentSwitch}
         elevated={overlay}
         menuSide={overlayDraft ? "bottom" : "top"}
         context={overlay ? context : undefined}
      />
   );
   const chat = (
      <>
         {!toolbar && !overlay && (
            <div className="flex h-13 shrink-0 items-center gap-2 border-b px-5">
               <span className="truncate text-sm font-semibold">
                  {state.title ?? "New Session"}
               </span>
               {badge}
            </div>
         )}
         <Portal container={indicator}>{dot}</Portal>
         <Portal container={status}>{detail}</Portal>
         <Portal container={menu}>
            <MenuButton onClick={() => update(resetLayout)}>
               <RotateCcw /> Reset layout
            </MenuButton>
         </Portal>
         <SelectionComment
            sessionId={api.sessionId}
            onAskSideThread={(quote) => void askSideThread(quote)}
         />
         <TaskListPanel entries={state.taskList} />
         <Slots slots={ui.slots.top} env={env} className="border-b pt-3" />
         <ScrollUnder
            bottom={
               <>
                  <Slots slots={ui.slots.bottom} env={env} className="pt-1" />
                  {side.error && (
                     <p role="alert" className="px-6 pb-2 text-xs text-destructive">
                        {side.error}
                     </p>
                  )}
                  {state.archived ? (
                     <div role="alert" className="p-3">
                        <div className="flex items-center gap-3 rounded-lg border bg-muted/50 px-3 py-2 text-sm">
                           <Archive className="size-4 text-muted-foreground" />
                           <span className="flex-1">Archived. Unarchive to continue</span>
                           <Button
                              size="sm"
                              onClick={() => {
                                 setArchiveError(null);
                                 api.unarchive().catch((e) =>
                                    setArchiveError(e instanceof Error ? e.message : String(e)),
                                 );
                              }}
                           >
                              Unarchive
                           </Button>
                        </div>
                        {archiveError && (
                           <p className="mt-2 text-xs text-destructive">{archiveError}</p>
                        )}
                     </div>
                  ) : (
                     promptBox
                  )}
               </>
            }
         >
            {(inset) => (
               <ShareBlock.Provider value={overlay ? null : shareBlock}>
                  <OpenStep value={openStep}>
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
                        onOpenPlan={overlay ? undefined : openPlan}
                        empty="Send a message to start."
                        inset={inset}
                     />
                  </OpenStep>
               </ShareBlock.Provider>
            )}
         </ScrollUnder>
      </>
   );

   const ghost = drag && (
      <div
         aria-hidden
         className="pointer-events-none fixed z-[60] flex items-center gap-2 rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-lg [&_svg]:size-4"
         style={{ left: drag.x + 12, top: drag.y + 12 }}
      >
         {icon(drag.id)} {drag.label}
      </div>
   );

   // The Quick overlay's stripes: side zones only, attached to the chat card's edges. Its window
   // grows by the open panels and the stripes (`onPanelWidth`); none before the first message.
   const sideL: [StripeGroup, StripeGroup] = [left[0], left[1]];
   const sideR: [StripeGroup, StripeGroup] = [right[0], right[1]];
   const stripeL = overlay && !overlayDraft && sideL.some((g) => g.items.length > 0);
   const stripeR = overlay && !overlayDraft && sideR.some((g) => g.items.length > 0);
   const sides = sideWidths(shown);
   const wantL = overlayDraft ? 0 : sides.left + (stripeL ? STRIPE_W : 0);
   const wantR = overlayDraft ? 0 : sides.right + (stripeR ? STRIPE_W : 0);
   useEffect(() => {
      if (overlay) onPanelWidth?.({ left: wantL, right: wantR });
   }, [overlay, wantL, wantR, onPanelWidth]);
   // The card has a fixed width; a side's panels and stripe show once the host window has room for them
   // (and stop before it shrinks), so opening or closing a panel never moves or reflows the chat.
   const geo = overlayFrame
      ? overlayGeometry(
           shown,
           overlayFrame.room,
           { left: stripeL, right: stripeR },
           overlayFrame.card,
        )
      : null;
   const drawnL = geo ? geo.stripes.left : stripeL;
   const drawnR = geo ? geo.stripes.right : stripeR;

   // The Quick overlay: before the first message only the prompt box, at the bottom of the
   // transparent window. Then the chat in the host's card, with side panels beside it (ADR 0022).
   if (overlay) {
      const column = <div className="relative flex min-h-0 flex-1 flex-col">{chat}</div>;
      const tab = (side: "left" | "right", groups: [StripeGroup, StripeGroup]) => (
         <div
            className={cn(
               "mt-3 shrink-0 self-start overflow-hidden border bg-background",
               side === "left"
                  ? "-mr-px rounded-l-lg border-r-0"
                  : "-ml-px rounded-r-lg border-l-0",
            )}
         >
            <Stripe
               side={side}
               groups={groups}
               drag={drag}
               onToggle={onToggle}
               onPress={(it, e) => startDrag(it.id, it.label, e)}
            />
         </div>
      );
      return (
         <Env.Provider value={env}>
            <FileViewProvider onView={openFile}>
               {overlayDraft ? (
                  <div className="relative flex h-full flex-col justify-end">{promptBox}</div>
               ) : (
                  <div
                     className="relative flex h-full"
                     style={geo ? { paddingLeft: geo.offset } : undefined}
                  >
                     <DockLayout
                        layout={geo?.layout ?? shown}
                        width={geo?.width}
                        chat={
                           <div className="flex min-h-0 flex-1">
                              {drawnL && tab("left", sideL)}
                              {chatFrame ? (
                                 chatFrame(column)
                              ) : (
                                 <div className="flex min-w-0 flex-1 flex-col">{column}</div>
                              )}
                              {drawnR && tab("right", sideR)}
                           </div>
                        }
                        panels={panels}
                        drag={drag}
                        leftStripeOverlay={false}
                        zones={OVERLAY_ZONES}
                        floating
                        onResize={(patch) => update((l) => resize(l, patch))}
                        onMove={(id, zone) => update((l) => move(l, id, zone))}
                        onHide={(id) => update((l) => hide(l, id))}
                        onExpand={(id) => update((l) => expand(l, id))}
                        onDragStart={startDrag}
                     />
                     {ghost}
                  </div>
               )}
            </FileViewProvider>
         </Env.Provider>
      );
   }

   return (
      <Env.Provider value={env}>
         <FileViewProvider onView={openFile}>
            <div className="relative flex h-full">
               {(!leftEmpty || drag) && (
                  <Stripe
                     side="left"
                     groups={left}
                     drag={drag}
                     overlay={leftEmpty}
                     onToggle={onToggle}
                     onPress={(it, e) => startDrag(it.id, it.label, e)}
                  />
               )}
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
               <Stripe
                  side="right"
                  groups={right}
                  drag={drag}
                  onToggle={onToggle}
                  onPress={(it, e) => startDrag(it.id, it.label, e)}
               />
               {ghost}
            </div>
         </FileViewProvider>
      </Env.Provider>
   );
}
