import {
   type AgentSwitch,
   type AttachmentInput,
   dockPanel,
   type OverlayFrame,
   type PanelWidth,
   type PromptContext,
   popPanel,
   type SessionApi,
   type SessionStatus,
   showPanelWindow,
   usePanelWindows,
   type ViewVariant,
} from "@harness/api";
import { MenuButton, Portal, type VirtualListHandle } from "@harness/ui";
import { RotateCcw } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef } from "react";
import { blockMarkdown } from "../features/artifacts/artifacts";
import type { ArtifactsModel } from "../features/artifacts/panel";
import { useSharedMetas } from "../features/artifacts/useSharedMetas";
import type { DiffScope } from "../features/changes/DiffPanel";
import { changesPanel } from "../features/changes/panel";
import { ArchivedNotice } from "../features/conversation/ArchivedNotice";
import { MessageList, useRows } from "../features/conversation/MessageList";
import { ScrollUnder } from "../features/conversation/ScrollUnder";
import { FileRefProvider, FileViewProvider } from "../features/files/FileRef";
import type { FileTarget } from "../features/files/FilesPanel";
import { filesPanel } from "../features/files/panel";
import { ShareBlock } from "../features/markdown/Expandable";
import { planPanel } from "../features/plan/panel";
import { PromptBox, type PromptBoxHandle } from "../features/prompt/PromptBox";
import { type PendingMessage, usePendingMessages } from "../features/prompt/pendingMessages";
import { PrRefProvider } from "../features/prRefs/prRefs";
import { Env } from "../features/renderUi/runtime";
import { SlotStrip } from "../features/renderUi/SlotStrip";
import { slotPanels } from "../features/renderUi/slotPanels";
import { sharedRef } from "../features/renderUi/tools";
import { useUiEnv } from "../features/renderUi/useUiEnv";
import { SelectionComment } from "../features/review/SelectionComment";
import type { SideChatsModel } from "../features/sideChats/panel";
import { OpenTask } from "../features/tasks/openTask";
import { tasksPanel } from "../features/tasks/panel";
import { OpenTerminal } from "../features/terminal/openTerminal";
import { terminalPanel } from "../features/terminal/panel";
import { OpenStep } from "../features/toolDisplay/openStep";
import {
   createPanelMenus,
   PanelMenusContext,
   RegisteredPanelMenuItems,
} from "../panels/PanelHeader";
import { DockLayout } from "./dock/DockLayout";
import { shownOpen } from "./dock/geometry";
import {
   expand,
   hide,
   isOpen,
   move,
   movePopped,
   resetLayout,
   resize,
   show,
   ZONES,
   type Zone,
} from "./dock/model";
import { mountedPanels } from "./dock/mountedPanels";
import { OVERLAY_ZONES } from "./dock/overlay";
import { PanelWindow, projectOf } from "./dock/PanelWindow";
import { usePanelDrag } from "./dock/panelDrag";
import { usePanelRecord } from "./dock/panelRecord";
import { Stripe } from "./dock/Stripe";
import { useDockLayout, useHostPlaces } from "./dock/useDockLayout";
import { useEndedWindows } from "./dock/useEndedWindows";
import { useStripes } from "./dock/useStripes";
import { OverlayDock } from "./overlay/OverlayDock";
import { useProcessStatus } from "./ProcessStatus";
import { useChatLog } from "./useChatLog";
import { useJump } from "./useJump";
import { usePanelHost } from "./usePanelHost";
import { useShortcuts } from "./useShortcuts";
import { availablePanels, renderablePanels } from "./viewState";

export type ChatProps = {
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
   onOpenTasks?: (taskId?: string) => void;
   onStartFromTask?: (taskId: string) => void;
   sessions?: readonly {
      id: string;
      title: string;
      status?: SessionStatus;
      folder?: string;
      quick?: boolean;
   }[];
   /** A panel window (`pane=panel`): the View shows only this panel, full window (`PanelWindow`). */
   popout?: string;
};

/**
 * The PR and file ref lookups sit above the chat, so the panels' models (which run in `ChatBody`) can use them.
 * `ChatBody` adds the viewer that shows a file in the Files panel.
 */
export function ChatView(props: ChatProps) {
   return (
      <PrRefProvider api={props.api}>
         <FileRefProvider api={props.api}>
            <ChatBody {...props} />
         </FileRefProvider>
      </PrRefProvider>
   );
}

/** Claude Code desktop-like chat. Pure fold of the Session Log (see reducer.ts). */
function ChatBody({
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
   onOpenTasks,
   onStartFromTask,
   sessions,
   popout,
}: ChatProps) {
   const overlay = variant === "overlay";
   const mode = overlay ? "overlay" : popout ? "window" : "main";
   // `inert`: a cached fold not confirmed whole yet can be behind the log (useChatLog).
   const { state, inert } = useChatLog(api);
   // A Session with nothing in it yet is waiting for a message. Known once its log is here.
   const prompt = useRef<PromptBoxHandle>(null);
   const hasItems = useRef(false);
   hasItems.current = state.items.length > 0;
   useEffect(() => {
      if (state.loaded && !hasItems.current) prompt.current?.focus();
   }, [state.loaded]);
   const { ui, rows, subagents } = useRows(state.items, state.sharedAttached, state.panelEdits);

   const sharedMetas = useSharedMetas(api);
   const sessionMap = useMemo(
      () => sessions && new Map(sessions.map((s) => [s.id, s])),
      [sessions],
   );
   const { lay, update, placesRef, setPlaces } = useDockLayout(api.sessionId, mode, popout);
   // A panel window that ended (closed: hidden here; docked back: shown in its zone), then its key goes.
   useEndedWindows(api.sessionId, mode === "main", lay, update);
   // The Session's panels open in windows of their own (a panel window leaves out its own panel).
   const poppedKey = usePanelWindows(api.sessionId)
      .map((w) => w.panel)
      .filter((id) => id !== popout)
      .join("\n");
   const popped = useMemo<ReadonlySet<string>>(
      () => new Set(poppedKey ? poppedKey.split("\n") : []),
      [poppedKey],
   );
   // Focuses its window, or opens it again when it is gone.
   const focusWindow = useCallback(
      (id: string) =>
         void showPanelWindow(api.sessionId, id).catch((e) =>
            console.error("show window failed", e),
         ),
      [api.sessionId],
   );
   const onDockBack = useCallback((id: string) => dockPanel(api.sessionId, id), [api.sessionId]);
   // A panel window has no other panels to toggle.
   useShortcuts(mode !== "main", update, popped, focusWindow);
   // The panels' own menu entries, for the stripe icons' context menus.
   const panelMenus = useMemo(createPanelMenus, []);
   const env = useUiEnv(api, state.uiState);
   const list = useRef<VirtualListHandle>(null);
   const { jumpToRow, jumpToStep, openStep } = useJump(list, rows, subagents);
   // Shared Artifacts (ADR 0024): the Artifacts panel shows the panel of a shared artifact.
   const showShared = useCallback(
      (id: string) => {
         const slot = [...ui.slots.left, ...ui.slots.right].find((s) => sharedRef(s.source) === id);
         if (slot) update((l) => show(l, `${slotPanels.prefix}:${slot.id}`));
      },
      [ui.slots.left, ui.slots.right, update],
   );
   // The panels defined through the panel contract (shell/panels.ts): their context, selves, models and statuses.
   const panelChat = useMemo(
      () => ({ toRow: jumpToRow, toStep: jumpToStep }),
      [jumpToRow, jumpToStep],
   );
   const panelHostApi = useMemo(
      () => ({
         openShared: onOpenShared,
         gitRefresh: onGitRefresh,
         sharedMetas,
         showShared,
         openTasks: onOpenTasks,
         startFromTask: onStartFromTask,
         sessions: sessionMap,
      }),
      [
         onOpenShared,
         onGitRefresh,
         sharedMetas,
         showShared,
         onOpenTasks,
         onStartFromTask,
         sessionMap,
      ],
   );
   const panelHost = usePanelHost({
      api,
      state,
      variant,
      lay,
      update,
      chat: panelChat,
      host: panelHostApi,
      popped,
      popout,
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
   // A task row in the chat (task_add, task_update) opens the Tasks panel at it; the Quick overlay has no
   // Tasks panel, so there it opens the host's All tasks view, when the host has one.
   const openTask = useCallback(
      (id: string) => (overlay ? onOpenTasks?.(id) : openPanel(tasksPanel, id)),
      [overlay, onOpenTasks, openPanel],
   );
   // The Quick overlay has no Terminal panel.
   const openTerminal = useCallback((id: number) => openPanel(terminalPanel, id), [openPanel]);
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
      (text: string, attachments: AttachmentInput[], item: PendingMessage) =>
         startSideThread(text, attachments, { item }),
      [startSideThread],
   );

   // Panels with an icon, and those that can show now. The layout keeps the rest where they are.
   // The Quick overlay shows only the panels marked `overlay` (ADR 0022 Phase 2).
   const availableNow = useMemo(
      () =>
         availablePanels({
            overlay,
            statuses: panelHost.statuses,
            overlayPanels: panelHost.overlayIds,
         }),
      [overlay, panelHost.statuses, panelHost.overlayIds],
   );
   const renderableNow = useMemo(
      () => renderablePanels(availableNow, panelHost.statuses),
      [availableNow, panelHost.statuses],
   );
   // Until the log is here, the panels the Session had when last loaded keep their zones and icons.
   const { available, renderable, placeholders, hints } = usePanelRecord({
      sessionId: api.sessionId,
      overlay,
      loaded: state.loaded,
      entries: panelHost.entries,
      available: availableNow,
      renderable: renderableNow,
   });
   // A popped panel is closed here (its zone shows as if it were hidden), but stays open in the stored
   // layout: docked back, it shows in its zone again.
   const shown = useMemo(() => shownOpen(lay, renderable, popped), [lay, renderable, popped]);
   useHostPlaces({ placesRef, setPlaces }, panelHost.places);

   /** A popped panel moves in its zone list only (see `movePopped`). */
   const moveTo = (id: string, zone: Zone, index?: number) =>
      update((l) => (popped.has(id) ? movePopped : move)(l, id, zone, index));
   const { drag, start: startDrag } = usePanelDrag((id, t) =>
      moveTo(id, t.zone, t.index ?? undefined),
   );
   const sessionTitle = sessionMap?.get(api.sessionId)?.title ?? state.title ?? "New Session";
   /** Opens a panel in a window of its own (focuses it when open). The stored layout does not change: docked back, the panel opens in its zone. */
   const popOut = (id: string) => {
      const label = panelHost.entries.find((e) => e.id === id)?.label ?? hints.get(id)?.label ?? id;
      popPanel(api.sessionId, id, { title: `${label} · ${sessionTitle}` }).catch((e) =>
         console.error("open panel window failed", e),
      );
   };
   const { left, right, leftEmpty, icon, onToggle, menuOf } = useStripes({
      entries: panelHost.entries,
      statuses: panelHost.statuses,
      lay,
      shown,
      available,
      update,
      hints,
      popped,
      onFocusWindow: focusWindow,
      onDockBack,
      onPopOut: mode === "main" ? popOut : undefined,
      zones: overlay ? OVERLAY_ZONES : ZONES,
   });
   const stripeMenu = (id: string) => <RegisteredPanelMenuItems id={id} model={menuOf(id)} />;
   /** What both trees (main and Quick overlay) give the dock. */
   const dock = {
      drag,
      onResize: (patch: Parameters<typeof resize>[1]) => update((l) => resize(l, patch)),
      onMove: (id: string, zone: Zone) => moveTo(id, zone),
      onHide: (id: string) => update((l) => hide(l, id)),
      onExpand: (id: string | null) => update((l) => expand(l, id)),
      onDragStart: startDrag,
   };
   const panels = mountedPanels(
      panelHost.entries,
      (id) => isOpen(shown, id),
      renderable,
      placeholders,
      popped,
   );

   // The host's header shows the process state as a dot on its info icon; a header of our own (no host header) a badge.
   const pending = usePendingMessages(api.sessionId);
   const { dot, detail, badge } = useProcessStatus(state.process, pending);

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
         <SlotStrip slots={ui.slots.top} env={env} className="border-b pt-3" />
         <ScrollUnder
            bottom={
               <>
                  <SlotStrip slots={ui.slots.bottom} env={env} className="pt-1" />
                  {side.error && (
                     <p role="alert" className="px-6 pb-2 text-xs text-destructive">
                        {side.error}
                     </p>
                  )}
                  {state.archived ? <ArchivedNotice api={api} /> : promptBox}
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
                        // Not before the log is here: a Session with messages showed this for a moment.
                        empty={state.loaded ? "Send a message to start." : null}
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

   return (
      <PanelMenusContext.Provider value={panelMenus}>
         <Env.Provider value={env}>
            <OpenTask.Provider value={overlay && !onOpenTasks ? null : openTask}>
               <OpenTerminal.Provider value={overlay ? null : openTerminal}>
                  <FileViewProvider onView={openFile}>
                     {/* `contents`: no box of its own, the layout stays as it is. */}
                     <div className="contents" inert={inert}>
                        {popout ? (
                           <PanelWindow
                              sessionId={api.sessionId}
                              panelId={popout}
                              entry={panelHost.entries.find((e) => e.id === popout)}
                              hint={hints.get(popout)}
                              loaded={state.loaded && !inert}
                              archived={state.archived}
                              sessionTitle={sessionTitle}
                              project={projectOf(sessionMap?.get(api.sessionId))}
                           />
                        ) : overlay ? (
                           <OverlayDock
                              draft={overlayDraft}
                              promptBox={promptBox}
                              chat={chat}
                              chatFrame={chatFrame}
                              onPanelWidth={onPanelWidth}
                              overlayFrame={overlayFrame}
                              shown={shown}
                              left={left}
                              right={right}
                              panels={panels}
                              dock={dock}
                              onToggle={onToggle}
                              menu={stripeMenu}
                              ghost={ghost}
                           />
                        ) : (
                           <div className="relative flex h-full">
                              {(!leftEmpty || drag) && (
                                 <Stripe
                                    side="left"
                                    groups={left}
                                    drag={drag}
                                    overlay={leftEmpty}
                                    onToggle={onToggle}
                                    onPress={(it, e) => startDrag(it.id, it.label, e)}
                                    menu={stripeMenu}
                                 />
                              )}
                              <DockLayout
                                 {...dock}
                                 layout={shown}
                                 chat={chat}
                                 panels={panels}
                                 leftStripeOverlay={leftEmpty}
                                 onPopOut={popOut}
                              />
                              <Stripe
                                 side="right"
                                 groups={right}
                                 drag={drag}
                                 onToggle={onToggle}
                                 onPress={(it, e) => startDrag(it.id, it.label, e)}
                                 menu={stripeMenu}
                              />
                              {ghost}
                           </div>
                        )}
                     </div>
                  </FileViewProvider>
               </OpenTerminal.Provider>
            </OpenTask.Provider>
         </Env.Provider>
      </PanelMenusContext.Provider>
   );
}
