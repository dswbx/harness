import { type TaskSummary, useTasks } from "@harness/api";
import { ListTodo } from "lucide-react";
import { useMemo, useState } from "react";
import { definePanel, type PanelBodyProps } from "../../panels/contract";
import { usePanelTarget } from "../../panels/usePanelTarget";
import { sessionTasks } from "./listModel";
import { TasksPanel } from "./TasksPanel";

export type TasksModel = {
   /** All tasks; null while loading. */
   tasks: TaskSummary[] | null;
   /** The task this Session was started from; null: none. */
   pinned: TaskSummary | null;
   /** The tasks created in this Session (without the pinned one). */
   created: TaskSummary[];
   /** The task open in the panel's sheet; null: none. */
   detail: string | null;
   setDetail: (id: string | null) => void;
};

/**
 * Tasks & Notes (ADR 0028): the tasks of this Session and its Session Note; opened at a task id, it shows that
 * task in its sheet. Once opened it stays mounted, so an unsaved note or description is never lost to hiding or
 * moving the panel.
 */
export const tasksPanel = definePanel<TasksModel, string>({
   id: "tasks",
   label: "Tasks & Notes",
   icon: ListTodo,
   placement: { edge: "right" },
   mount: "afterFirstOpen",
   overlay: false,
   useModel: ({ api }, self) => {
      const tasks = useTasks(api);
      const [detail, setDetail] = useState<string | null>(null);
      usePanelTarget(self, setDetail);
      const sessionId = api.sessionId;
      return useMemo(() => {
         const { pinned, created } = sessionTasks(tasks ?? [], sessionId);
         return { tasks, pinned, created, detail, setDetail };
      }, [tasks, sessionId, detail]);
   },
   status: () => ({ presence: "ready" }),
   Body: ({ model, ctx }: PanelBodyProps<TasksModel, string>) => (
      <TasksPanel
         api={ctx.api}
         tasks={model.tasks}
         pinned={model.pinned}
         created={model.created}
         host={ctx.host}
         openId={model.detail}
         onOpen={model.setDetail}
      />
   ),
});
