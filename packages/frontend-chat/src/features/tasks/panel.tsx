import { ScrollArea } from "@harness/ui";
import { ListTodo } from "lucide-react";
import { definePanel, type PanelBodyProps } from "../../panels/contract";
import { PanelHeader } from "../../panels/PanelHeader";
import { NoteEditor } from "./NoteEditor";

/**
 * Tasks & Notes (ADR 0028): the Session's own Session Note (tasks come later). Once opened it stays mounted, so an
 * unsaved note is never lost to hiding or moving the panel.
 */
export const tasksPanel = definePanel<null>({
   id: "tasks",
   label: "Tasks & Notes",
   icon: ListTodo,
   placement: { edge: "right" },
   mount: "afterFirstOpen",
   overlay: false,
   useModel: () => null,
   status: () => ({ presence: "ready" }),
   Body: ({ ctx }: PanelBodyProps<null>) => (
      <div className="flex h-full min-h-0 flex-col">
         <PanelHeader title="Tasks & Notes" />
         <ScrollArea className="min-h-0 flex-1">
            <NoteEditor key={ctx.api.sessionId} api={ctx.api} />
         </ScrollArea>
      </div>
   ),
});
