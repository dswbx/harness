import { Badge, cn, Tooltip } from "@harness/ui";
import { type usePendingMessages, useSlow } from "../features/prompt/pendingMessages";
import type { ChatState } from "../state/reducer";

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

/**
 * The Agent process state as three pieces: a dot, its explanation and a badge. The host's header shows it
 * as a dot on its info icon, explained in that icon's menu; a header of our own (no host header) shows the
 * badge. Archived and deleted Sessions say so elsewhere.
 */
export function useProcessStatus(
   proc: ChatState["process"],
   pending: ReturnType<typeof usePendingMessages>,
) {
   // Restoring the Agent Session takes longer than starting its process, and the process is
   // "ready" by then: a message on its way is what says the Agent is not ready yet.
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
   return { dot, detail, badge };
}
