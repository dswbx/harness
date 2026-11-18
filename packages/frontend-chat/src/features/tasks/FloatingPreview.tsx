import type { TaskSummary } from "@harness/api";
import type { PanelCtx } from "../../panels/contract";
import { TaskDetail } from "./TaskDetail";
import type { TaskApi } from "./taskApi";

/**
 * How far the preview reaches in from the right of the tree area, with a gap on its left: its width (400px) and
 * its right inset (12px), plus 12px. The tree gets this much extra room on its right while the preview is open.
 */
export const PREVIEW_SPACE = 400 + 12 + 12;

/**
 * The tree view's preview (board "AllTasksTree"): the task in full on a card that floats over the right of the
 * tree area. It is absolute inside that area, so the tree under it does not move; closed with its X.
 */
export function FloatingPreview({
   api,
   id,
   tasks,
   host,
   onClose,
   onOpen,
}: {
   api: TaskApi;
   id: string;
   tasks: readonly TaskSummary[] | null;
   host: PanelCtx["host"];
   onClose: () => void;
   onOpen: (id: string) => void;
}) {
   return (
      <aside
         aria-label="Task preview"
         data-floating-preview
         className="absolute inset-y-3 right-3 z-10 flex w-[400px] max-w-[calc(100%-1.5rem)] min-h-0 flex-col overflow-hidden rounded-xl border bg-card shadow-2xl"
      >
         <TaskDetail
            key={id}
            api={api}
            id={id}
            tasks={tasks}
            host={host}
            onBack={onClose}
            onClose={onClose}
            onOpen={onOpen}
         />
      </aside>
   );
}
