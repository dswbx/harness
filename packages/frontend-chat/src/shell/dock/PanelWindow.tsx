import {
   closeCurrentWindow,
   closePanel,
   dockPanel,
   forgetPanelWindow,
   isPanelPopped,
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

/**
 * How long a pop-out waits, once its panel is no longer popped, before it closes: a pop out again in
 * that time (Dock back, then pop out quickly) finds this window open and focuses it, so it must stay.
 */
export const CLOSE_GRACE_MS = 200;

/** The project name the session chip shows: "Quick" for a Quick Session, else its folder's name. */
export function projectOf(s: { folder?: string; quick?: boolean } | undefined): string | undefined {
   if (!s) return undefined;
   if (s.quick) return "Quick";
   return s.folder?.split(/[\\/]/).filter(Boolean).pop();
}

/**
 * A panel window (`pane=panel`): one panel of the Session, full window, with the window header (see
 * `PanelHeader`). When the user closes the window it marks the panel closed (`closePanel`: the main
 * view hides it). Dock back marks it docked (the main view shows it in its zone). It closes itself on
 * Dock back, when the panel does not exist once the log is here (its key goes), and when the panel is
 * no longer popped (docked or closed from elsewhere): then only after `CLOSE_GRACE_MS`, and only if it
 * is still not popped then (a new pop out reuses this window). An archived Session shows a notice
 * under the header.
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
   const forget = useCallback(() => {
      forgetPanelWindow(sessionId, panelId);
      close();
   }, [sessionId, panelId, close]);

   useEffect(() => {
      document.title = `${label} · ${sessionTitle}`;
   }, [label, sessionTitle]);
   useEffect(() => rememberWindowFrame(panelWindowFrame(sessionId, panelId)), [sessionId, panelId]);
   // The user closed the window (red X, Cmd+W; in a browser: the tab): not popped, hidden in its zone.
   // After Dock back the key is gone, so this does nothing.
   useEffect(() => onWindowClose(() => closePanel(sessionId, panelId)), [sessionId, panelId]);
   // Not popped any more (docked from the main window, the Session deleted, restore turned off, closed):
   // close, unless it is popped again by then (the storage read is the truth, not this render's value).
   const popped = usePanelWindows(sessionId).some((w) => w.panel === panelId);
   useEffect(() => {
      if (popped) return;
      const t = setTimeout(() => {
         if (!isPanelPopped(sessionId, panelId)) close();
      }, CLOSE_GRACE_MS);
      return () => clearTimeout(t);
   }, [popped, close, sessionId, panelId]);
   // An unknown panel (a removed render_ui item): nothing to dock back, the key goes.
   const unknown = loaded && !entry;
   useEffect(() => {
      if (unknown) forget();
   }, [unknown, forget]);

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
