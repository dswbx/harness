import type { HarnessClient, SessionApi } from "@harness/api";

type Methods =
   | "listTasks"
   | "readTask"
   | "createTask"
   | "updateTask"
   | "moveTask"
   | "deleteTask"
   | "addTaskAssets"
   | "removeTaskAsset"
   | "readTaskAsset"
   | "tasksChanged";

/**
 * What the task views need: a Session's task methods (new tasks get it as their origin), or the app's for the
 * All tasks view (`sessionId` null: no Session, new tasks have no origin).
 */
export type TaskApi = Pick<SessionApi, Methods> & { sessionId: string | null };

/** The task methods of the whole app, for a view without a Session. */
export const appTaskApi = (client: HarnessClient): TaskApi => ({
   sessionId: null,
   listTasks: () => client.listTasks(),
   readTask: (id) => client.readTask(id),
   createTask: (t) => client.createTask(t),
   updateTask: (id, patch, base) => client.updateTask(id, patch, base),
   moveTask: (id, parent, before) => client.moveTask(id, parent, before),
   deleteTask: (id) => client.deleteTask(id),
   addTaskAssets: (id, files) => client.addTaskAssets(id, files),
   removeTaskAsset: (id, name) => client.removeTaskAsset(id, name),
   readTaskAsset: (id, name) => client.readTaskAsset(id, name),
   tasksChanged: (f) => client.tasksChanged(f),
});
