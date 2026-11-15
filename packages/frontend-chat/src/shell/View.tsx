import type {
   AgentSwitch,
   AttachmentInput,
   OverlayFrame,
   PanelWidth,
   PromptContext,
   SessionApi,
   ViewVariant,
} from "@harness/api";
import { useSessionEvents } from "@harness/api";
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
import { usePendingMessages } from "../features/prompt/pendingMessages";
import { PrRefProvider } from "../features/prRefs/prRefs";
import { reduce, reduceBatch } from "../features/renderUi/chatReducer";
import { Env } from "../features/renderUi/runtime";
import { SlotStrip } from "../features/renderUi/SlotStrip";
import { slotPanels } from "../features/renderUi/slotPanels";
import { sharedRef } from "../features/renderUi/tools";
import { useUiEnv } from "../features/renderUi/useUiEnv";
import { SelectionComment } from "../features/review/SelectionComment";
import type { SideChatsModel } from "../features/sideChats/panel";
import { OpenStep } from "../features/toolDisplay/openStep";
import { initialState } from "../state/reducer";
import { DockLayout } from "./dock/DockLayout";
import { shownOpen } from "./dock/geometry";
import { expand, hide, isOpen, move, resetLayout, resize, show } from "./dock/model";
import { mountedPanels } from "./dock/mountedPanels";
import { usePanelDrag } from "./dock/panelDrag";
import { Stripe } from "./dock/Stripe";
import { useDockLayout, useHostPlaces } from "./dock/useDockLayout";
import { useStripes } from "./dock/useStripes";
import { OverlayDock } from "./overlay/OverlayDock";
import { useProcessStatus } from "./ProcessStatus";
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
}: ChatProps) {
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

   const sharedMetas = useSharedMetas(api);
   const { lay, update, placesRef, setPlaces } = useDockLayout(api.sessionId, overlay);
   useShortcuts(overlay, update);
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
   useHostPlaces({ placesRef, setPlaces }, panelHost.places);

   const { drag, start: startDrag } = usePanelDrag((id, t) =>
      update((l) => move(l, id, t.zone, t.index ?? undefined)),
   );
   const { left, right, leftEmpty, icon, onToggle } = useStripes({
      entries: panelHost.entries,
      statuses: panelHost.statuses,
      lay,
      shown,
      available,
      update,
   });
   /** What both trees (main and Quick overlay) give the dock. */
   const dock = {
      drag,
      onResize: (patch: Parameters<typeof resize>[1]) => update((l) => resize(l, patch)),
      onMove: (id: string, zone: Parameters<typeof move>[2]) => update((l) => move(l, id, zone)),
      onHide: (id: string) => update((l) => hide(l, id)),
      onExpand: (id: string | null) => update((l) => expand(l, id)),
      onDragStart: startDrag,
   };
   const panels = mountedPanels(panelHost.entries, (id) => isOpen(shown, id), renderable);

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

   return (
      <Env.Provider value={env}>
         <FileViewProvider onView={openFile}>
            {overlay ? (
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
                     />
                  )}
                  <DockLayout
                     {...dock}
                     layout={shown}
                     chat={chat}
                     panels={panels}
                     leftStripeOverlay={leftEmpty}
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
            )}
         </FileViewProvider>
      </Env.Provider>
   );
}
