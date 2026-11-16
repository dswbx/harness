import type { Transport } from "@harness/api";
import { HarnessClient as Client } from "@harness/api";
import { useEffect, useMemo, useState } from "react";
import { ViewHost } from "../platform/ViewHost";
import { SessionHeader, trafficLights } from "../session-header/SessionHeader";
import { useMarkSeen } from "../sessions/useMarkSeen";
import { useSessions } from "../sessions/useSessions";
import { useTurnNotices } from "../sessions/useTurnNotices";

const params = new URLSearchParams(window.location.search);

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
   const client = useMemo(() => new Client(transport), [transport]);
   const { sessions, settled } = useSessions(client);
   const session = settled ? (sessions.find((x) => x.id === sessionId) ?? null) : undefined;
   const parent = sessions.find((x) => x.id === session?.parent?.session_id);
   // A Frontend's own window (a pop-out diff) is not where the Session is read.
   useMarkSeen(client, params.get("pane") ? null : session);
   useTurnNotices(client, sessions, sessionId, setSessionId, !params.get("pane"));
   useEffect(() => {
      if (session) document.title = session.title;
   }, [session]);
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
            />
         </div>
      </div>
   );
}
