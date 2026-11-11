import {
   type AgentSwitch,
   createSessionApi,
   type OverlayFrame,
   type PanelWidth,
   type Transport,
   type ViewVariant,
} from "@harness/api";
import { type ReactNode, useMemo } from "react";
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
   variant,
   agentSwitch,
   chatFrame,
   onPanelWidth,
   overlayFrame,
}: {
   transport: Transport;
   sessionId: string;
   frontendId: string;
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
         variant={variant}
         agentSwitch={agentSwitch}
         chatFrame={chatFrame}
         onPanelWidth={onPanelWidth}
         overlayFrame={overlayFrame}
      />
   );
}
