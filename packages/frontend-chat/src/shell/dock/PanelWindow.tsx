import {
   closeCurrentWindow,
   dockPanel,
   onWindowClose,
   panelWindowFrame,
   rememberWindowFrame,
   showSession,
   usePanelWindows,
} from "@harness/api";
import { Button } from "@harness/ui";
import { PanelRight } from "lucide-react";
import { Suspense, useCallback, useEffect, useMemo, useRef } from "react";
import { type PanelChrome, PanelContext, PanelHeader } from "../../panels/PanelHeader";
import type { HostedPanel } from "../usePanelHost";
import type { PanelHint } from "./panelRecord";

const noop = () => {};

/** The project name the session chip shows: "Quick" for a Quick Session, else its folder's name. */
export function projectOf(s: { folder?: string; quick?: boolean } | undefined): string | undefined {
   if (!s) return undefined;
   if (s.quick) return "Quick";
   return s.folder?.split(/[\\/]/).filter(Boolean).pop();
}

/**
 * A panel window (`pane=panel`): one panel of the Session, full window, with the window header (see
 * `PanelHeader`). It docks the panel back when the user closes the window, and closes itself when the
 * panel is docked from elsewhere (its key is gone), when the panel does not exist once the log is here,
 * or on Dock back. An archived Session shows a notice under the header.
 */
export function PanelWindow({
   sessionId,
   panelId,
   entry,
   hint,
   loaded,
   archived,
   sessionTitle,
   project,
}: {
   sessionId: string;
   panelId: string;
   /** The hosted panel; none until the log is here (a render_ui panel), or when it does not exist. */
   entry: HostedPanel | undefined;
   /** The recorded label and icon, before the log is here. */
   hint?: PanelHint;
   /** The log is here (and whole): a missing `entry` means the panel does not exist. */
   loaded: boolean;
   archived: boolean;
   sessionTitle: string;
   project?: string;
}) {
   const label = entry?.label ?? hint?.label ?? panelId;
   const closed = useRef(false);
   const close = useCallback(() => {
      if (closed.current) return;
      closed.current = true;
      closeCurrentWindow().catch((e) => console.error("close window failed", e));
   }, []);
   const dockBack = useCallback(() => {
      dockPanel(sessionId, panelId);
      close();
   }, [sessionId, panelId, close]);

   useEffect(() => {
      document.title = `${label} · ${sessionTitle}`;
   }, [label, sessionTitle]);
   useEffect(() => rememberWindowFrame(panelWindowFrame(sessionId, panelId)), [sessionId, panelId]);
   // The user closed the window (red X, Cmd+W; in a browser: the tab): the panel docks back.
   useEffect(() => onWindowClose(() => dockPanel(sessionId, panelId)), [sessionId, panelId]);
   // Docked from elsewhere (the main window, the Session deleted, restore turned off): close.
   const popped = usePanelWindows(sessionId).some((w) => w.panel === panelId);
   useEffect(() => {
      if (!popped) close();
   }, [popped, close]);
   const unknown = loaded && !entry;
   useEffect(() => {
      if (unknown) dockBack();
   }, [unknown, dockBack]);

   const Own = entry?.icon ?? hint?.icon;
   const chrome = useMemo<PanelChrome>(
      () => ({
         id: panelId,
         label,
         moves: [],
         expandable: false,
         expanded: false,
         onExpand: noop,
         onMove: noop,
         onHide: noop,
         onDragStart: noop,
         window: {
            icon: Own ? <Own /> : <PanelRight />,
            sessionTitle,
            project,
            onShowSession: () => void showSession(sessionId),
            onDockBack: dockBack,
            notice: archived && (
               <div
                  role="status"
                  className="flex shrink-0 items-center gap-2 border-b bg-muted px-3 py-2 text-xs"
               >
                  <span className="min-w-0 flex-1">Session archived. This panel is read-only.</span>
                  <Button size="sm" onClick={dockBack}>
                     Dock back
                  </Button>
               </div>
            ),
         },
      }),
      [panelId, label, Own, sessionTitle, project, sessionId, dockBack, archived],
   );

   return (
      <PanelContext.Provider value={chrome}>
         <section
            aria-label={label}
            className="flex h-full flex-col overflow-hidden bg-background [--chat-font-size:var(--app-font-size)]"
         >
            {entry ? (
               <Suspense fallback={null}>
                  <entry.Body {...entry.props} />
               </Suspense>
            ) : (
               <>
                  <PanelHeader title={label} />
                  <div aria-busy className="min-h-0 flex-1" />
               </>
            )}
         </section>
      </PanelContext.Provider>
   );
}
