import { storedNumber, type TaskSummary } from "@harness/api";
import { ResizeHandle, useResizableWidth } from "@harness/ui";
import type { PanelCtx } from "../../panels/contract";
import type { SessionInfo } from "./ListView";
import { TaskDetail } from "./TaskDetail";
import type { TaskApi } from "./taskApi";

const widthStore = storedNumber("harness:tasks-preview-width");

/**
 * The All tasks view's docked preview (board "AllTasks"): the task in full beside the list, which gets
 * narrower. Resized from its left edge (double-click resets), closed with its X.
 */
export function PreviewColumn({
   api,
   id,
   tasks,
   host,
   sessions,
   onClose,
   onOpen,
}: {
   api: TaskApi;
   id: string;
   tasks: readonly TaskSummary[] | null;
   host: PanelCtx["host"];
   sessions: ReadonlyMap<string, SessionInfo>;
   onClose: () => void;
   onOpen: (id: string) => void;
}) {
   const side = useResizableWidth({
      store: widthStore,
      initial: 400,
      min: 300,
      max: 720,
      edge: "left",
   });
   return (
      <aside
         aria-label="Task preview"
         className="relative flex min-h-0 max-w-[60%] shrink-0 flex-col border-l bg-card"
         style={{ width: side.width }}
      >
         <ResizeHandle label="Resize task preview" {...side.handle} />
         <TaskDetail
            key={id}
            api={api}
            id={id}
            tasks={tasks}
            host={host}
            sessions={sessions}
            onBack={onClose}
            onClose={onClose}
            onOpen={onOpen}
         />
      </aside>
   );
}
