import type {
   AgentSwitch,
   AttachmentInput,
   OverlayFrame,
   PanelWidth,
   PromptContext,
   SessionApi,
   SharedArtifactMeta,
   ViewVariant,
} from "@harness/api";
import { openWindow, useSessionEvents, useSharedArtifacts } from "@harness/api";
import {
   Badge,
   Button,
   cn,
   DropdownMenuItem,
   MenuButton,
   Portal,
   ScrollArea,
   Tooltip,
   type VirtualListHandle,
} from "@harness/ui";
import {
   Archive,
   CheckCircle2,
   CircleDashed,
   ClipboardList,
   ExternalLink,
   Folder,
   GitCompare,
   Layers,
   Link2,
   Loader2,
   MessagesSquare,
   PanelLeft,
   PanelRight,
   RotateCcw,
   ScrollText,
   Share2,
   SquareTerminal,
   Unlink,
   X,
} from "lucide-react";
import {
   lazy,
   type ReactNode,
   Suspense,
   useCallback,
   useEffect,
   useMemo,
   useRef,
   useState,
} from "react";
import { ALL_CHANGES, DiffPanel, type DiffScope } from "./DiffPanel";
import { PromptBox, type PromptBoxHandle } from "./PromptBox";
import { ScrollUnder } from "./ScrollUnder";

// xterm.js stays out of the main chunk until the Terminal is first opened.
const TerminalPanel = lazy(() => import("./TerminalPanel"));

import { ArtifactsPanel, type SharedActions, sessionCount } from "./ArtifactsPanel";
import { type Artifact, blockMarkdown, collectArtifacts } from "./artifacts";
import { DiffWindow, diffWindowScope } from "./DiffWindow";
import { DockLayout, type DockPanel } from "./DockLayout";
import { clearDraft } from "./drafts";
import { EventsPanel } from "./EventsPanel";
import { ShareBlock } from "./Expandable";
import { errorMessage } from "./errors";
import { FileRefProvider } from "./FileRef";
import { FilesPanel, type FileTarget, filesWindowTarget, filesWindowUrl } from "./FilesPanel";
import { MessageList, useRows } from "./Messages";
import { PanelHeader } from "./PanelHeader";
import { PlanPanel } from "./PlanPanel";
import { usePanelDrag } from "./panelDrag";
import {
   closeThread,
   defaultLayout,
   expand,
   hide,
   isDraftThread,
   isOpen,
   isSlotPanel,
   type Layout,
   loadLayout,
   move,
   OVERLAY_ZONES,
   openThread,
   overlayGeometry,
   overlayProfile,
   type PanelId,
   reconcile,
   replaceThread,
   resetLayout,
   resize,
   STRIPE_W,
   saveLayout,
   selectThread,
   show,
   shownOpen,
   sideWidths,
   slotIdOf,
   slotPanel,
   toggle,
   type Zone,
} from "./panelLayout";
import { usePendingMessages, useSlow } from "./pendingMessages";
import { PrRefProvider } from "./prRefs";
import {
   NO_REFERENCES,
   ReferencesPanel,
   ReferencesProbe,
   type ResolvedReferences,
} from "./ReferencesPanel";
import { RenderUi, type UiEnv } from "./RenderUi";
import { type ChatState, initialState, reduce, reduceBatch } from "./reducer";
import { useSourceStamps } from "./renderUi/source";
import { addReviewComment, composerKey, setReviewComments } from "./reviewComments";
import { SelectionComment } from "./SelectionComment";
import { SidePanel } from "./SidePanel";
import { Stripe, type StripeGroup, type StripeItem } from "./Stripe";
import { type Slot, slotChangeKey } from "./slots";
import type { SideStart } from "./ThreadView";
import { formatAge, formatRelativeTime, useNow } from "./time";
import { RENDER_UI, sharedRef } from "./tools";
import { uiIcons } from "./uiIcons";

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
                  <RenderUi root={x.root} env={{ ...env, files: x.files, item: x.id }} />
               </div>
            ))}
         </div>
      </div>
   );
}

/**
 * "5m ago" at the right of a panel header. It takes only the room the title leaves and hides when
 * that room is too small, so the title always wins.
 */
function UpdatedAgo({ ts }: { ts: number }) {
   const now = useNow();
   const age = formatAge(ts, now);
   return (
      <div className="@container min-w-0 flex-1 basis-0">
         <time
            dateTime={new Date(ts).toISOString()}
            className="hidden text-right text-[11px] whitespace-nowrap text-muted-foreground @min-[3.5rem]:block"
         >
            {age === "now" ? "now" : `${age} ago`}
         </time>
      </div>
   );
}

/** Share icon in a shared Panel's header; hover shows that it is shared, its Session count and last update. */
function SharedBadge({ meta }: { meta: SharedArtifactMeta | undefined }) {
   const now = useNow();
   return (
      <Tooltip
         content={
            <div className="flex flex-col gap-0.5">
               <span className="font-medium">Shared artifact</span>
               {meta && (
                  <>
                     <span>Attached in {sessionCount(meta)}</span>
                     <span>Updated {formatRelativeTime(meta.updated_ms, now)}</span>
                  </>
               )}
            </div>
         }
      >
         <span
            role="img"
            aria-label="Shared artifact"
            tabIndex={0}
            className="flex shrink-0 items-center text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
         >
            <Share2 className="size-3.5" />
         </span>
      </Tooltip>
   );
}

/**
 * `updated`: when it last changed (its latest call, or a later write of its source file). `shared`:
 * the Shared Artifact it shows (ADR 0024): a share icon with its details on hover, and its menu.
 */
function SlotPanel({
   slot,
   env,
   updated,
   shared,
}: {
   slot: Slot;
   env: UiEnv;
   updated: number;
   shared?: {
      meta: SharedArtifactMeta | undefined;
      onDetach: () => void;
      onOpenOutside?: () => void;
   };
}) {
   return (
      <>
         <PanelHeader
            title={slot.title ?? slot.id}
            menu={
               shared && (
                  <>
                     {shared.onOpenOutside && (
                        <DropdownMenuItem onSelect={shared.onOpenOutside}>
                           <ExternalLink /> Open outside Session
                        </DropdownMenuItem>
                     )}
                     <DropdownMenuItem onSelect={shared.onDetach}>
                        <Unlink /> Detach
                     </DropdownMenuItem>
                  </>
               )
            }
         >
            {shared && <SharedBadge meta={shared.meta} />}
            {updated > 0 && <UpdatedAgo ts={updated} />}
         </PanelHeader>
         <ScrollArea className="min-h-0 flex-1">
            <div className="p-4">
               <RenderUi root={slot.root} env={{ ...env, files: slot.files, item: slot.id }} />
            </div>
         </ScrollArea>
      </>
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
}) {
   return diffScope ? (
      <DiffWindow api={api} scope={diffScope} />
   ) : filesWindow ? (
      <FileRefProvider api={api}>
         <FilesPanel api={api} target={filesWindowFirst} popout />
      </FileRefProvider>
   ) : (
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

/** Briefly rings an element the user jumped to. */
function flash(el: Element) {
   el.animate(
      [
         { outline: "2px solid var(--ring)", outlineOffset: "4px", borderRadius: "8px" },
         { outline: "2px solid transparent", outlineOffset: "4px", borderRadius: "8px" },
      ],
      { duration: 1600, easing: "ease-in" },
   );
}

const BASE_LABEL: Record<string, string> = {
   side: "Side chats",
   changes: "Changes",
   files: "Files",
   terminal: "Terminal",
   events: "Events",
   artifacts: "Artifacts",
   references: "References",
   plan: "Plan",
};
const BASE_ICON: Record<string, React.ReactNode> = {
   side: <MessagesSquare />,
   changes: <GitCompare />,
   files: <Folder />,
   terminal: <SquareTerminal />,
   events: <ScrollText />,
   artifacts: <Layers />,
   references: <Link2 />,
   plan: <ClipboardList />,
};

function ChatView({
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

   // render_ui items placed left or right are panels. Their default zone follows the placement.
   // A panel showing a Shared Artifact takes the artifact's title (it can be renamed).
   const slots = useMemo(() => {
      const titled = (slot: Slot) => {
         const id = sharedRef(slot.source);
         const title = id ? sharedMetas.get(id)?.title : undefined;
         return title && title !== slot.title ? { ...slot, title } : slot;
      };
      return [
         ...ui.slots.left.map((slot) => ({ slot: titled(slot), zone: "leftTop" as Zone })),
         ...ui.slots.right.map((slot) => ({ slot: titled(slot), zone: "rightTop" as Zone })),
      ];
   }, [ui.slots.left, ui.slots.right, sharedMetas]);
   const slotPanels = useMemo(
      () => slots.map((s) => ({ id: slotPanel(s.slot.id), zone: s.zone })),
      [slots],
   );
   const slotPanelsRef = useRef(slotPanels);
   slotPanelsRef.current = slotPanels;

   /**
    * Where the panels sit, their sizes and the open side chats. Kept per Session. The Quick overlay
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
   const update = useCallback(
      (f: (l: Layout) => Layout) =>
         setLayout((l) => fit(f(fit(reconcile(l, slotPanelsRef.current))))),
      [fit],
   );
   const lay = useMemo(() => fit(reconcile(layout, slotPanels)), [fit, layout, slotPanels]);
   useEffect(() => {
      if (lay !== layout) setLayout(lay);
   }, [lay, layout]);

   // Side chats: a prompt box takes focus in the chat that was just created.
   const [focus, setFocus] = useState<{ id: string; n: number }>({ id: "", n: 0 });
   const [sideError, setSideError] = useState<string | null>(null);
   const layRef = useRef(lay);
   layRef.current = lay;
   /**
    * Starts a Side Thread now (forked from Main when the Agent can; `start` from a draft tab can pick fresh and a mode),
    * in place of tab `draft` or as a new tab, and sends it `text`.
    */
   const startSideThread = useCallback(
      async (text: string, attachments: AttachmentInput[], draft?: string, start?: SideStart) => {
         setSideError(null);
         let thread_id: string;
         try {
            ({ thread_id } = await api.startSideThread(start));
         } catch (e) {
            setSideError(errorMessage(e));
            throw e;
         }
         update((l) =>
            draft && l.threads.includes(draft)
               ? replaceThread(l, draft, thread_id)
               : openThread(l, thread_id),
         );
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
      (quote: string) =>
         addReviewComment(composerKey(api.sessionId, newSideThread()), {
            kind: "quote",
            quote,
            text: "",
         }),
      [api, newSideThread],
   );
   /** `/btw <text>` in the Main prompt box: a Side Thread whose first prompt is `text`. */
   const btw = useCallback(
      (text: string, attachments: AttachmentInput[]) => startSideThread(text, attachments),
      [startSideThread],
   );

   useEffect(() => {
      // The Quick overlay has no Terminal or side chats panel.
      if (overlay) return;
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
   }, [overlay, update, newSideThread]);
   const [scope, setScope] = useState<DiffScope>(ALL_CHANGES);
   const [archiveError, setArchiveError] = useState<string | null>(null);
   // Changes need git; hidden until the Workspace is known to be a repository.
   const [git, setGit] = useState(false);
   const turnRunning = state.turnId !== null;
   // The folder can become a repository later (`git init`): look again after each Turn, and for a
   // terminal command every 20s and on focus, until it is one.
   // biome-ignore lint/correctness/useExhaustiveDependencies: turnRunning triggers the check.
   useEffect(() => {
      let off = false;
      const check = () => {
         if (document.hidden) return;
         api.workspace().then(
            (w) => !off && setGit(!!w?.repo_root),
            () => {},
         );
      };
      check();
      if (git) {
         return () => {
            off = true;
         };
      }
      const timer = setInterval(check, 20_000);
      window.addEventListener("focus", check);
      return () => {
         off = true;
         clearInterval(timer);
         window.removeEventListener("focus", check);
      };
   }, [api, turnRunning, git]);

   const openDiff = useCallback(
      (s: DiffScope) => {
         setScope(s);
         update((l) => show(l, "changes"));
      },
      [update],
   );
   /** The file the Files panel shows next (a new object each time, so the same file scrolls again). */
   const [fileTarget, setFileTarget] = useState<FileTarget | null>(null);
   /** Shows a file (a code lens, a comment chip) in the Files panel; the Quick overlay has none, so a window. */
   const openFile = useCallback(
      (ref: FileTarget) => {
         if (overlay) {
            void openWindow(
               `files-${api.sessionId}`,
               filesWindowUrl(api.sessionId, ref.path, ref.start),
               { title: `Files: ${ref.path}` },
            );
            return;
         }
         setFileTarget({ ...ref });
         update((l) => show(l, "files"));
      },
      [overlay, api.sessionId, update],
   );
   const clearFileTarget = useCallback(() => setFileTarget(null), []);
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
   // A left or right item the Agent adds or changes while the Session is open shows at once (not replayed ones).
   const [openedAt] = useState(() => Date.now());
   const lastSlot = useMemo(
      () => slots.reduce<Slot | null>((a, x) => (!a || x.slot.ts > a.ts ? x.slot : a), null),
      [slots],
   );
   useEffect(() => {
      if (lastSlot && lastSlot.ts >= openedAt) update((l) => show(l, slotPanel(lastSlot.id)));
   }, [lastSlot?.id, lastSlot?.ts, openedAt, update]);
   // The Plan panel shows this version (null: the latest). A new pending plan opens the panel, once.
   const [planShown, setPlanShown] = useState<string | null>(null);
   const openPlan = useCallback(
      (requestId: string) => {
         setPlanShown(requestId);
         update((l) => show(l, "plan"));
      },
      [update],
   );
   const lastPlan = state.plans.at(-1);
   const pendingPlan = lastPlan?.status === "pending" ? lastPlan.requestId : null;
   const planOpened = useRef(new Set<string>());
   useEffect(() => {
      if (overlay || !pendingPlan || planOpened.current.has(pendingPlan)) return;
      planOpened.current.add(pendingPlan);
      openPlan(pendingPlan);
   }, [overlay, pendingPlan, openPlan]);
   const artifacts = useMemo(() => collectArtifacts(state.items), [state.items]);
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
   const jump = useCallback(
      (a: Artifact) => {
         if (a.placement === "right" || a.placement === "left") {
            if (a.slotId) update((l) => show(l, slotPanel(a.slotId!)));
            return;
         }
         if (!a.rowId) {
            const el = document.querySelector(`[data-slot="${CSS.escape(a.slotId ?? "")}"]`);
            if (el) flash(el);
            return;
         }
         // The diagram or table inside the row.
         jumpToRow(a.rowId, (row) =>
            a.index !== null
               ? row.querySelectorAll(`[data-artifact="${a.kind}"]`)[a.index]
               : row.firstElementChild,
         );
      },
      [update, jumpToRow],
   );
   // Shared Artifacts (ADR 0024): the Artifacts panel's group and actions, and "Make shared" on blocks.
   const showShared = useCallback(
      (id: string) => {
         const slot = slots.find((s) => sharedRef(s.slot.source) === id)?.slot;
         if (slot) update((l) => show(l, slotPanel(slot.id)));
      },
      [slots, update],
   );
   // Message blocks this Session shared, by their artifact key: the copy stands in for them.
   const sharedCopies = useMemo(() => {
      const m = new Map<string, string>();
      for (const { id } of state.sharedAttached) {
         const by = sharedMetas.get(id)?.created_by;
         if (by?.origin && by.session_id === api.sessionId) m.set(by.origin, id);
      }
      return m;
   }, [state.sharedAttached, sharedMetas, api.sessionId]);
   const sharedActions = useMemo<SharedActions>(
      () => ({
         attached: state.sharedAttached,
         metas: sharedMetas,
         copies: sharedCopies,
         search: (q) => api.listShared(q),
         share: (a) =>
            a.kind === "ui"
               ? api.shareArtifact(a.slotId!)
               : api.shareMarkdown(blockMarkdown(a), a.title, a.key),
         attach: (id) => api.attachShared(id),
         detach: (id) => api.detachShared(id),
         open: showShared,
         openOutside: onOpenShared,
      }),
      [api, state.sharedAttached, sharedMetas, sharedCopies, showShared, onOpenShared],
   );
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
   const jumpToMention = useCallback(
      (rowId: string) => jumpToRow(rowId, (row) => row.firstElementChild),
      [jumpToRow],
   );
   const [resolved, setResolved] = useState<ResolvedReferences>(NO_REFERENCES);
   // References are looked up from the first time their panel opens.
   const [referencesOpened, setReferencesOpened] = useState(false);
   const referencesOpen = isOpen(lay, "references");
   useEffect(() => {
      if (referencesOpen) setReferencesOpened(true);
   }, [referencesOpen]);
   const changeCount = useMemo(
      () => state.items.reduce((n, i) => n + (i.type === "changes" ? 1 : 0), 0),
      [state.items],
   );

   const sideThreads = useMemo(() => state.threadList.filter((t) => !t.main), [state.threadList]);
   // Open side chats that have something to show (they arrive with the replay).
   const openThreads = lay.threads.filter((id) => isDraftThread(id) || !!state.threads[id]);
   const activeThread =
      lay.thread && openThreads.includes(lay.thread) ? lay.thread : (openThreads.at(-1) ?? null);
   const threadTitle = (id: string) =>
      isDraftThread(id) ? "New chat" : (sideThreads.find((x) => x.id === id)?.title ?? "Side chat");

   // Panels with an icon, and those that can show now. The layout keeps the rest where they are.
   const slotById = useMemo(
      () => new Map(slots.map((s) => [slotPanel(s.slot.id), s.slot])),
      [slots],
   );
   const hasPlans = state.plans.length > 0;
   // The Quick overlay shows only render_ui panels (ADR 0022 Phase 2).
   const available = useMemo(() => {
      if (overlay) return new Set<PanelId>(slotById.keys());
      const a = new Set<PanelId>([
         "side",
         "files",
         "terminal",
         "events",
         "artifacts",
         "references",
         ...slotById.keys(),
      ]);
      if (git) a.add("changes");
      if (hasPlans) a.add("plan");
      return a;
   }, [overlay, slotById, git, hasPlans]);
   const shown = useMemo(() => {
      const renderable = new Set(available);
      if (openThreads.length === 0) renderable.delete("side");
      return shownOpen(lay, renderable);
      // eslint-disable-next-line react-hooks/exhaustive-deps
   }, [available, lay, openThreads.length]);
   const open = (id: PanelId) => isOpen(shown, id);

   /** The Terminal stays mounted (hidden) once opened, so its screen survives hiding and moving. */
   const [terminalOpened, setTerminalOpened] = useState(false);
   useEffect(() => {
      if (open("terminal")) setTerminalOpened(true);
   });

   // File-backed panels (ADR 0023): their files' hashes and write times.
   const sourceNames = useMemo(
      () =>
         [
            ...new Set(
               slots.flatMap(({ slot }) =>
                  slot.source && !sharedRef(slot.source) ? [slot.source] : [],
               ),
            ),
         ].sort(),
      [slots],
   );
   const stamps = useSourceStamps(api.panelSourceRead, api.panelSourceChanged, sourceNames);
   const updatedAt = (x: Slot) => {
      const id = sharedRef(x.source);
      if (id) return sharedMetas.get(id)?.updated_ms ?? 0;
      return Math.max(x.ts, x.source ? (stamps[x.source]?.mtime ?? 0) : 0);
   };

   // A dot on a slot's icon marks changes made while it was closed (its first sight counts as seen),
   // including writes of a source file.
   const slotKey = (x: Slot) => slotChangeKey(x, stamps);
   const [seen, setSeen] = useState<Record<string, string>>({});
   useEffect(() => {
      setSeen((prev) => {
         let next = prev;
         for (const { slot } of slots) {
            // A source not read yet is not seen yet.
            if (
               slot.source &&
               !sharedRef(slot.source) &&
               !(slot.source in stamps) &&
               !(slot.id in prev)
            )
               continue;
            const k = slotKey(slot);
            if ((open(slotPanel(slot.id)) || !(slot.id in prev)) && prev[slot.id] !== k)
               next = { ...next, [slot.id]: k };
         }
         return next;
      });
   });

   const { drag, start: startDrag } = usePanelDrag((id, t) =>
      update((l) => move(l, id, t.zone, t.index ?? undefined)),
   );

   const label = (id: PanelId) =>
      isSlotPanel(id) ? (slotById.get(id)?.title ?? slotIdOf(id)!) : BASE_LABEL[id]!;
   const icon = (id: PanelId) => {
      if (!isSlotPanel(id)) return BASE_ICON[id];
      const Custom = uiIcons[slotById.get(id)?.icon as keyof typeof uiIcons];
      if (Custom) return <Custom />;
      return lay.zones.leftTop.includes(id) || lay.zones.leftBottom.includes(id) ? (
         <PanelLeft />
      ) : (
         <PanelRight />
      );
   };
   const tip = (id: PanelId) => (id === "side" ? "Side chats (⇧⌘B new)" : label(id));
   const count = (id: PanelId) =>
      id === "side"
         ? sideThreads.length
         : id === "artifacts"
           ? artifacts.length
           : id === "references"
             ? resolved.count
             : undefined;
   const shortcut = (id: PanelId) => (id === "terminal" ? ["⌃", "`"] : undefined);
   const group = (zone: Zone): StripeGroup => ({
      zone,
      items: lay.zones[zone].flatMap((id, index): StripeItem[] => {
         if (!available.has(id)) return [];
         const slot = slotById.get(id);
         const on = shown.open[zone] === id;
         return [
            {
               id,
               index,
               label: label(id),
               tip: tip(id),
               count: count(id),
               shortcut: shortcut(id),
               icon: icon(id),
               on,
               dot: !!slot && !on && slot.id in seen && seen[slot.id] !== slotKey(slot),
            },
         ];
      }),
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
   if (openThreads.length > 0) {
      panels.push({
         id: "side",
         label: "Side chats",
         children: (
            <SidePanel
               api={api}
               state={state}
               threads={openThreads}
               active={activeThread}
               titleOf={threadTitle}
               env={env}
               focus={focus}
               onSelect={(id) => update((l) => selectThread(l, id))}
               onClose={(id) => {
                  if (isDraftThread(id)) {
                     setReviewComments(composerKey(api.sessionId, id), []);
                     clearDraft(composerKey(api.sessionId, id));
                  }
                  update((l) => closeThread(l, id));
               }}
               onNew={newSideThread}
               onSendDraft={(id, text, files, start) => startSideThread(text, files, id, start)}
               onOpenDiff={openDiff}
            />
         ),
      });
   }
   if (open("changes"))
      panels.push({
         id: "changes",
         label: "Changes",
         children: (
            <DiffPanel
               api={api}
               scope={scope}
               onScope={setScope}
               refreshKey={refreshKey}
               onRefresh={onGitRefresh}
            />
         ),
      });
   if (open("files"))
      panels.push({
         id: "files",
         label: "Files",
         children: <FilesPanel api={api} target={fileTarget} onTargetShown={clearFileTarget} />,
      });
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
   if (open("events"))
      panels.push({
         id: "events",
         label: "Events",
         expandable: true,
         children: <EventsPanel api={api} />,
      });
   if (open("artifacts"))
      panels.push({
         id: "artifacts",
         label: "Artifacts",
         children: (
            <ArtifactsPanel artifacts={artifacts} env={env} onJump={jump} shared={sharedActions} />
         ),
      });
   if (open("plan"))
      panels.push({
         id: "plan",
         label: "Plan",
         children: (
            <PlanPanel api={api} state={state} selected={planShown} onSelect={setPlanShown} />
         ),
      });
   if (open("references"))
      panels.push({
         id: "references",
         label: "References",
         children: <ReferencesPanel resolved={resolved} onJump={jumpToMention} />,
      });
   for (const [id, slot] of slotById) {
      const sharedId = sharedRef(slot.source);
      if (open(id))
         panels.push({
            id,
            label: slot.title ?? slot.id,
            children: (
               <SlotPanel
                  slot={slot}
                  env={env}
                  updated={updatedAt(slot)}
                  shared={
                     sharedId
                        ? {
                             meta: sharedMetas.get(sharedId),
                             onDetach: () =>
                                void api
                                   .detachShared(sharedId)
                                   .catch((e) => console.error("detach failed", e)),
                             onOpenOutside: onOpenShared && (() => onOpenShared(sharedId)),
                          }
                        : undefined
                  }
               />
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
                  {sideError && (
                     <p role="alert" className="px-6 pb-2 text-xs text-destructive">
                        {sideError}
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
         <PrRefProvider api={api}>
            <FileRefProvider api={api} onView={openFile}>
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
            </FileRefProvider>
         </PrRefProvider>
      );
   }

   return (
      <PrRefProvider api={api}>
         <FileRefProvider api={api} onView={openFile}>
            <ReferencesProbe
               items={state.items}
               active={referencesOpened}
               onResolved={setResolved}
            />
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
         </FileRefProvider>
      </PrRefProvider>
   );
}
