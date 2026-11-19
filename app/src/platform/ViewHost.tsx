import {
   type AgentSwitch,
   createSessionApi,
   HarnessClient,
   type OverlayFrame,
   type PanelWidth,
   type PromptContext,
   type SessionSummary,
   type Transport,
   type ViewVariant,
} from "@harness/api";
import { type ReactNode, useMemo } from "react";
import { useStartFromTask } from "../composer/useStartFromTask";
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
   context,
   onOpenShared,
   onOpenSession,
   onOpenTasks,
   onStartFromTask,
   sessions,
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
   context?: PromptContext;
   onOpenShared?: (id: string) => void;
   onOpenSession?: (sessionId: string) => void;
   /** Opens the All tasks view, at a task when given (ADR 0028). */
   onOpenTasks?: (taskId?: string) => void;
   /** "Start session with this task"; without it, and with `onOpenSession`, ViewHost opens the dialog itself. */
   onStartFromTask?: (taskId: string) => void;
   /** The Sessions the window lists, for live Session titles in the View. */
   sessions?: readonly SessionSummary[];
}) {
   const api = useMemo(() => createSessionApi(transport, sessionId), [transport, sessionId]);
   const client = useMemo(() => new HarnessClient(transport), [transport]);
   const fromTask = useStartFromTask({ client, onCreated: (id) => onOpenSession?.(id) });
   const startFromTask = onStartFromTask ?? (onOpenSession ? fromTask.start : undefined);
   const fe = registry[frontendId];
   if (!fe)
      return <div className="p-6 text-sm text-destructive">Unknown Frontend: {frontendId}</div>;
   return (
      <>
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
            context={context}
            onOpenShared={onOpenShared}
            onOpenSession={onOpenSession}
            onOpenTasks={onOpenTasks}
            onStartFromTask={startFromTask}
            sessions={sessions}
         />
         {fromTask.dialog}
      </>
   );
}
