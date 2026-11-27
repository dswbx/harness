import type { Transport } from "@harness/api";
import { HarnessClient as Client, closeCurrentWindow, forgetPanelWindow } from "@harness/api";
import { useEffect, useMemo, useState } from "react";
import { ViewHost } from "../platform/ViewHost";
import { SessionHeader, trafficLights } from "../session-header/SessionHeader";
import { SessionRenameDialog } from "../sessions/SessionRenameDialog";
import { useMarkSeen } from "../sessions/useMarkSeen";
import { useSessions } from "../sessions/useSessions";
import { useTurnNotices } from "../sessions/useTurnNotices";

const params = new URLSearchParams(window.location.search);
const isPanel = params.get("pane") === "panel";

/** A window showing only one Session's View; a Sub Session's parent (or a child) opens in it too. */
export function Solo({
   transport,
   sessionId: initialId,
}: {
   transport: Transport;
   sessionId: string;
}) {
   const [sessionId, setSessionId] = useState(initialId);
   const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null);
   const [status, setStatus] = useState<HTMLDivElement | null>(null);
   const [indicator, setIndicator] = useState<HTMLSpanElement | null>(null);
   const [menu, setMenu] = useState<HTMLDivElement | null>(null);
   const [renaming, setRenaming] = useState(false);
   const client = useMemo(() => new Client(transport), [transport]);
   const { sessions, settled, loaded } = useSessions(client);
   const found = sessions.find((x) => x.id === sessionId);
   // Not found after a failed first load is not known yet: a panel window waits for the next poll.
   const session = found ?? (loaded || (settled && !isPanel) ? null : undefined);
   const parent = sessions.find((x) => x.id === session?.parent?.session_id);
   // A Frontend's own window (a pop-out diff) is not where the Session is read.
   useMarkSeen(client, params.get("pane") ? null : session);
   useTurnNotices(client, sessions, sessionId, setSessionId, !params.get("pane"));
   useEffect(() => {
      // A panel window sets its own title ("<Panel> · <Session>").
      if (session && params.get("pane") !== "panel") document.title = session.title;
   }, [session]);
   // A panel window of a deleted Session (a list loaded without it) has nothing left to show: its key goes.
   const gone = loaded && !found && isPanel;
   useEffect(() => {
      if (!gone) return;
      const panel = params.get("panel");
      if (panel) forgetPanelWindow(sessionId, panel);
      closeCurrentWindow().catch((e) => console.error("close window failed", e));
   }, [gone, sessionId]);
   if (session === undefined) return null;
   if (session === null)
      return <div className="p-6 text-sm text-destructive">Session not found.</div>;
   // A Frontend's own window (`pane=...`, e.g. a pop-out diff) brings its own chrome.
   if (params.get("pane")) {
      return (
         <div className="h-full">
            <ViewHost
               transport={transport}
               sessionId={session.id}
               frontendId={session.frontend_id}
               // A panel window's header shows the Session's title and folder.
               sessions={params.get("pane") === "panel" ? sessions : undefined}
            />
         </div>
      );
   }
   return (
      <div className="flex h-full flex-col">
         <SessionHeader
            client={client}
            session={session}
            parent={parent}
            onOpenParent={() => parent && setSessionId(parent.id)}
            onRename={() => setRenaming(true)}
            toolbarRef={setToolbar}
            statusRef={setStatus}
            indicatorRef={setIndicator}
            menuRef={setMenu}
            leading={trafficLights && <div className="w-12 shrink-0" />}
         />
         <div className="min-h-0 flex-1">
            <ViewHost
               transport={transport}
               sessionId={session.id}
               frontendId={session.frontend_id}
               toolbar={toolbar}
               status={status}
               indicator={indicator}
               menu={menu}
               onOpenSession={setSessionId}
               sessions={sessions}
            />
         </div>
         <SessionRenameDialog
            client={client}
            session={renaming ? session : null}
            onClose={() => setRenaming(false)}
         />
      </div>
   );
}
