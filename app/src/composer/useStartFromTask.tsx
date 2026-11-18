import type { HarnessClient, SessionSummary } from "@harness/api";
import { type ReactNode, useCallback, useState } from "react";
import { useReportError } from "../platform/toast";
import { ComposerDialog } from "./ComposerDialog";
import { type StartTask, startTaskOf } from "./composer";

/**
 * "Start session from a task" (ADR 0028): `start(taskId)` loads the task and opens the Composer in
 * task mode; render `dialog`. The Session panel ("Start session with this task") and the All tasks
 * view both use it.
 */
export function useStartFromTask({
   client,
   onCreated,
   agentsVersion,
   mcpVersion,
}: {
   client: HarnessClient;
   onCreated: (sessionId: string) => void;
   agentsVersion?: number;
   mcpVersion?: number;
}): { start: (taskId: string) => void; dialog: ReactNode } {
   const report = useReportError();
   const [task, setTask] = useState<StartTask | null>(null);
   const [open, setOpen] = useState(false);
   const [sessions, setSessions] = useState<SessionSummary[]>([]);

   const start = useCallback(
      (taskId: string) => {
         Promise.all([client.readTask(taskId), client.listSessions()])
            .then(async ([t, list]) => {
               const parent = t.parent_id
                  ? await client.readTask(t.parent_id).catch(() => null)
                  : null;
               setSessions(list);
               setTask(startTaskOf(t, parent, list));
               setOpen(true);
            })
            .catch((e) => report("Could not open the task", e));
      },
      [client, report],
   );

   const dialog = task && (
      <ComposerDialog
         client={client}
         open={open}
         onOpenChange={setOpen}
         task={task}
         folder={task.origin?.folder ?? null}
         sessions={sessions}
         agentsVersion={agentsVersion}
         mcpVersion={mcpVersion}
         onCreated={onCreated}
         onPromptError={(e) => report("Could not send the prompt", e)}
      />
   );
   return { start, dialog };
}
