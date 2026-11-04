import { createSessionApi, type Transport } from "@harness/api";
import { useMemo } from "react";
import { registry } from "./registry";

/** Mounts the Frontend's View for a Session, keyed by session id so state never leaks between Sessions. */
export function ViewHost({
   transport,
   sessionId,
   frontendId,
   toolbar,
   status,
   indicator,
   menu,
   onGitRefresh,
}: {
   transport: Transport;
   sessionId: string;
   frontendId: string;
   toolbar?: HTMLElement | null;
   status?: HTMLElement | null;
   indicator?: HTMLElement | null;
   menu?: HTMLElement | null;
   onGitRefresh?: () => void;
}) {
   const api = useMemo(() => createSessionApi(transport, sessionId), [transport, sessionId]);
   const fe = registry[frontendId];
   if (!fe)
      return <div className="p-6 text-sm text-destructive">Unknown Frontend: {frontendId}</div>;
   return (
      <fe.View
         key={sessionId}
         api={api}
         toolbar={toolbar}
         status={status}
         indicator={indicator}
         menu={menu}
         onGitRefresh={onGitRefresh}
      />
   );
}
