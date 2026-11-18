import type { Transport } from "../../transport/transport";
import type { SessionApi } from "../session";
import {
   addTaskAssets,
   createTask,
   deleteTask,
   listTasks,
   moveTask,
   readTask,
   readTaskAsset,
   removeTaskAsset,
   tasksChanged,
   updateTask,
} from "../tasks";

type Tasks = Pick<
   SessionApi,
   | "listTasks"
   | "readTask"
   | "createTask"
   | "updateTask"
   | "moveTask"
   | "deleteTask"
   | "addTaskAssets"
   | "removeTaskAsset"
   | "readTaskAsset"
   | "tasksChanged"
>;

/** Tasks (ADR 0028) as seen from one Session: new Tasks have it as their origin. */
export const tasksApi = (transport: Transport, sessionId: string): Tasks => ({
   listTasks: () => listTasks(transport),
   readTask: (id) => readTask(transport, id),
   createTask: (t) => createTask(transport, { ...t, sessionId }),
   updateTask: (id, patch, baseUpdatedMs) => updateTask(transport, id, patch, baseUpdatedMs),
   moveTask: (id, parentId, before) => moveTask(transport, id, parentId, before),
   deleteTask: (id) => deleteTask(transport, id),
   addTaskAssets: (id, files) => addTaskAssets(transport, id, files),
   removeTaskAsset: (id, name) => removeTaskAsset(transport, id, name),
   readTaskAsset: (id, name) => readTaskAsset(transport, id, name),
   tasksChanged: (onChange) => tasksChanged(transport, onChange),
});
