import type {
   AttachmentInput,
   Task,
   TaskPatch,
   TaskPriority,
   TaskStatus,
   TaskSummary,
   TaskUpstream,
} from "../generated";
import type { Transport } from "../transport/transport";
import { expectResult, run } from "./expect";

/** What `createTask` takes. `sessionId`: the Session the Task is created in (its origin). */
export type NewTask = {
   title: string;
   body?: string | null;
   parentId?: string | null;
   sessionId?: string | null;
   status?: TaskStatus | null;
   priority?: TaskPriority | null;
   /** `YYYY-MM-DD`. */
   due?: string | null;
   upstream?: TaskUpstream | null;
};

/** All Tasks (ADR 0028), oldest first. */
export const listTasks = async (transport: Transport): Promise<TaskSummary[]> =>
   (await expectResult(transport, { type: "ListTasks" }, "Tasks")).tasks;

export const readTask = async (transport: Transport, id: string): Promise<Task> =>
   (await expectResult(transport, { type: "ReadTask", id }, "Task")).task;

export const createTask = async (transport: Transport, t: NewTask): Promise<Task> =>
   (
      await expectResult(
         transport,
         {
            type: "CreateTask",
            title: t.title,
            body: t.body ?? null,
            parent_id: t.parentId ?? null,
            session_id: t.sessionId ?? null,
            status: t.status ?? null,
            priority: t.priority ?? null,
            due: t.due ?? null,
            upstream: t.upstream ?? null,
         },
         "Task",
      )
   ).task;

/** `baseUpdatedMs`: the `updated_ms` the editor loaded; a body edit is refused (`conflict`) when the body changed after it. */
export const updateTask = async (
   transport: Transport,
   id: string,
   patch: TaskPatch,
   baseUpdatedMs: number | null = null,
): Promise<Task> =>
   (
      await expectResult(
         transport,
         { type: "UpdateTask", id, patch, base_updated_ms: baseUpdatedMs },
         "Task",
      )
   ).task;

/** Puts the Task under `parentId` (null: top level), before its sibling `before` (null: last). */
export const moveTask = async (
   transport: Transport,
   id: string,
   parentId: string | null,
   before: string | null = null,
): Promise<Task> =>
   (await expectResult(transport, { type: "MoveTask", id, parent_id: parentId, before }, "Task"))
      .task;

/** Deletes the Task; its children move to its parent. */
export const deleteTask = (transport: Transport, id: string) =>
   run(transport, { type: "DeleteTask", id });

export const addTaskAssets = async (
   transport: Transport,
   id: string,
   files: AttachmentInput[],
): Promise<Task> =>
   (await expectResult(transport, { type: "AddTaskAssets", id, files }, "Task")).task;

export const removeTaskAsset = async (
   transport: Transport,
   id: string,
   name: string,
): Promise<Task> =>
   (await expectResult(transport, { type: "RemoveTaskAsset", id, name }, "Task")).task;

/** A Task asset as base64 `data`. */
export const readTaskAsset = async (
   transport: Transport,
   id: string,
   name: string,
): Promise<{ mime: string; data: string }> => {
   const r = await expectResult(transport, { type: "ReadTaskAsset", id, name }, "Attachment");
   return { mime: r.mime, data: r.data };
};

/** Calls back with the ids of the Tasks that changed (the list should reload too). */
export const tasksChanged = (transport: Transport, onChange: (ids: string[]) => void) =>
   transport.subscribeApp((e) => e.type === "TasksChanged" && onChange(e.ids));
