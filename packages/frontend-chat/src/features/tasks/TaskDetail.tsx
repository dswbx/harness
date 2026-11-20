import {
   type AttachmentInput,
   blockedBy,
   blocks,
   childrenOf,
   errText,
   followedBy,
   followsOf,
   formatAgeAgo,
   formatDateTime,
   isCommandError,
   isOpen,
   localDay,
   openBlockers,
   type Task,
   type TaskActivity,
   type TaskDep,
   type TaskPatch,
   type TaskSummary,
   topicProgress,
} from "@harness/api";
import {
   Button,
   cn,
   Dialog,
   DialogContent,
   DialogDescription,
   DialogFooter,
   DialogHeader,
   DialogTitle,
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuTrigger,
   ScrollArea,
   Tooltip,
} from "@harness/ui";
import {
   ChevronRight,
   MoreHorizontal,
   MoveUpRight,
   Play,
   Plus,
   Trash2,
   Upload,
   X,
} from "lucide-react";
import {
   type ReactNode,
   useCallback,
   useContext,
   useEffect,
   useMemo,
   useRef,
   useState,
} from "react";
import { OpenSession } from "../../lib/OpenSession";
import { useNow } from "../../lib/time";
import type { PanelCtx } from "../../panels/contract";
import { InlineMarkdown } from "../markdown/InlineMarkdown";
import { PromptEditor, type PromptEditorHandle } from "../prompt/PromptEditor";
import { AddFilesButton, AssetStrip, type StripAsset } from "./AssetStrip";
import { DepPicker } from "./DepPicker";
import { DuePicker } from "./DuePicker";
import { ParentPicker } from "./ParentPicker";
import { PriorityMenu } from "./PriorityMenu";
import { PropsField } from "./PropsField";
import { QuickAdd } from "./QuickAdd";
import { STATUS_LABEL, StatusIcon, StatusMenu } from "./StatusMenu";
import { type Sessions, sessionTitle } from "./sessionTitle";
import { TaskRow, WaitsOnChip } from "./TaskRow";
import type { TaskApi } from "./taskApi";
import { UpstreamField } from "./UpstreamField";
import { useAutosavedMarkdown } from "./useAutosavedMarkdown";
import { useFileDrop } from "./useFileDrop";

const noop = () => {};

const SECTION =
   "flex items-center gap-1.5 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground";

/** The task, read in full, and read again whenever it changes (any window). `missing`: it was deleted. */
function useTask(api: TaskApi, id: string) {
   const [task, setTask] = useState<Task | null>(null);
   const [missing, setMissing] = useState(false);
   const [error, setError] = useState<string | null>(null);
   const seq = useRef(0);
   const put = useCallback((t: Task) => {
      seq.current++;
      setTask(t);
   }, []);
   useEffect(() => {
      let live = true;
      const load = () => {
         const mine = ++seq.current;
         api.readTask(id).then(
            (t) => live && mine === seq.current && setTask(t),
            (e) => {
               if (!live) return;
               if (isCommandError(e, "not_found")) setMissing(true);
               else setError(errText(e));
            },
         );
      };
      load();
      const off = api.tasksChanged((ids) => ids.includes(id) && load());
      return () => {
         live = false;
         void off.then((f) => f());
      };
   }, [api, id]);
   return { task, put, missing, error, setError };
}

/**
 * One task in full (board "TaskDetail"): title (with the parent under it), fields, description (autosaved), assets,
 * subtasks, Sessions and activity. Every change saves at once; the description saves like the note.
 */
export function TaskDetail({
   api,
   id,
   tasks,
   host,
   sessions,
   onOpen,
   onClose,
}: {
   api: TaskApi;
   id: string;
   /** All tasks (null while loading): parent and subtasks. */
   tasks: readonly TaskSummary[] | null;
   host: PanelCtx["host"];
   /** Live Session titles (the host's Session list). Absent: the titles cached on the task. */
   sessions?: Sessions;
   onOpen: (id: string) => void;
   /** The close button on the title row; also called once the task is deleted. */
   onClose: () => void;
}) {
   const { task, put, missing, error, setError } = useTask(api, id);
   const [confirmDelete, setConfirmDelete] = useState(false);
   const now = useNow();
   const today = localDay(new Date(now));
   const byId = useMemo(() => new Map((tasks ?? []).map((t) => [t.id, t])), [tasks]);
   const parentId = task?.parent_id ?? byId.get(id)?.parent_id ?? null;
   const parent = parentId ? (byId.get(parentId) ?? null) : null;
   // All tasks, with this one's deps as last read or saved (the list catches up a moment later).
   const deps = task?.deps;
   const linked = useMemo(
      () => (deps ? (tasks ?? []).map((t) => (t.id === id ? { ...t, deps } : t)) : (tasks ?? [])),
      [tasks, id, deps],
   );
   const waitsOn = openBlockers(linked, id);

   const fail = (e: unknown) => setError(errText(e));
   const patch = (p: TaskPatch) => {
      setError(null);
      api.updateTask(id, p).then(put, fail);
   };

   const addFiles = (files: AttachmentInput[]) => {
      if (!task) return;
      setError(null);
      api.addTaskAssets(id, files).then(put, fail);
   };
   // Files dropped anywhere on the task go to its assets (not to a prompt box).
   const root = useRef<HTMLDivElement>(null);
   const drop = useFileDrop(root, addFiles, setError);

   const remove = () => {
      setConfirmDelete(false);
      api.deleteTask(id).then(onClose, fail);
   };

   const deleteItem = (
      <DropdownMenuItem
         className="text-destructive focus:text-destructive"
         onSelect={() => setConfirmDelete(true)}
      >
         <Trash2 /> Delete task
      </DropdownMenuItem>
   );
   const openInAll = host.openTasks && (
      <Tooltip content="Open in All tasks" side="bottom">
         <Button
            size="icon"
            variant="ghost"
            className="size-7 shrink-0"
            aria-label="Open in All tasks"
            onClick={() => host.openTasks?.(id)}
         >
            <MoveUpRight />
         </Button>
      </Tooltip>
   );
   const controls = (
      <div className="-mr-1.5 flex shrink-0 items-center gap-0.5">
         {openInAll}
         <DropdownMenu>
            <DropdownMenuTrigger asChild>
               <Button
                  size="icon"
                  variant="ghost"
                  className="size-7 shrink-0 data-[state=open]:bg-accent"
                  aria-label="Task options"
               >
                  <MoreHorizontal />
               </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
               {deleteItem}
            </DropdownMenuContent>
         </DropdownMenu>
         <Tooltip content="Close preview" side="bottom">
            <Button
               size="icon"
               variant="ghost"
               className="size-7 shrink-0"
               aria-label="Close preview"
               onClick={onClose}
            >
               <X />
            </Button>
         </Tooltip>
      </div>
   );

   return (
      <div ref={root} className="flex h-full min-h-0 flex-col" {...drop.handlers}>
         {missing ? (
            <div className="flex items-start gap-2 p-4">
               <div className="flex flex-1 flex-col items-start gap-2 text-sm text-muted-foreground">
                  This task was deleted.
                  <Button size="sm" variant="outline" onClick={onClose}>
                     Close
                  </Button>
               </div>
               {controls}
            </div>
         ) : (
            <>
               <div className="flex shrink-0 flex-col gap-1 px-4 pb-2 pt-2.5">
                  <div className="flex items-start gap-2">
                     <div className="min-w-0 flex-1 pt-0.5">
                        {task ? (
                           <TitleEditor
                              task={task}
                              onSave={(title) => {
                                 setError(null);
                                 return api.updateTask(id, { title }).then(put, (e) => {
                                    fail(e);
                                    throw e;
                                 });
                              }}
                           />
                        ) : (
                           <div className="h-6 text-sm text-muted-foreground/60">Loading…</div>
                        )}
                     </div>
                     {controls}
                  </div>
                  {parent && (
                     <ParentLine
                        parent={parent}
                        progress={topicProgress(tasks ?? [], parent.id)}
                        onOpen={() => onOpen(parent.id)}
                     />
                  )}
               </div>
               <ScrollArea className="min-h-0 flex-1">
                  {error && (
                     <div role="alert" className="px-4 pb-2 text-xs text-destructive">
                        {error}
                     </div>
                  )}
                  {task && (
                     <div className="flex flex-col gap-5 px-4 pb-6 pt-1">
                        <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-x-2 gap-y-2 text-xs">
                           <Label>Status</Label>
                           <div className="flex min-w-0 items-center gap-2">
                              <StatusMenu
                                 status={task.status}
                                 onChange={(status) => patch({ status })}
                              />
                              {waitsOn > 0 && <WaitsOnChip count={waitsOn} />}
                           </div>
                           <Label>Priority</Label>
                           <div>
                              <PriorityMenu
                                 priority={task.priority}
                                 onChange={(priority) => patch({ priority })}
                              />
                           </div>
                           <Label>Due</Label>
                           <div>
                              <DuePicker
                                 due={task.due}
                                 open={isOpen(task.status)}
                                 onChange={(due) => patch(due ? { due } : { clear: ["due"] })}
                              />
                           </div>
                           <Label>Parent</Label>
                           <div className="min-w-0">
                              <ParentPicker
                                 taskId={id}
                                 parentId={task.parent_id}
                                 tasks={tasks ?? []}
                                 onChange={(parent) => {
                                    setError(null);
                                    api.moveTask(id, parent).then(put, fail);
                                 }}
                              />
                           </div>
                           <Label>Upstream</Label>
                           <UpstreamField
                              upstream={task.upstream}
                              onChange={(upstream) =>
                                 patch(upstream ? { upstream } : { clear: ["upstream"] })
                              }
                           />
                           <Label>Created in</Label>
                           <div className="min-w-0">
                              <SessionChip
                                 sessionId={task.origin_session_id}
                                 title={task.origin_title}
                                 current={api.sessionId}
                                 sessions={sessions}
                              />
                           </div>
                        </div>
                        <section aria-label="Properties">
                           <div className={SECTION}>Properties</div>
                           <PropsField
                              props={task.props ?? {}}
                              onChange={(props) => patch({ props })}
                           />
                        </section>
                        <Dependencies
                           id={id}
                           deps={task.deps ?? []}
                           tasks={linked}
                           onOpen={onOpen}
                           onChange={(deps) => patch({ deps })}
                        />
                        <BodyEditor
                           api={api}
                           task={task}
                           put={put}
                           onError={setError}
                           onAddFiles={addFiles}
                        />
                        <Assets
                           api={api}
                           task={task}
                           dragOver={drop.over}
                           onAdd={addFiles}
                           onRemove={(name) => {
                              setError(null);
                              api.removeTaskAsset(id, name).then(put, fail);
                           }}
                           onError={setError}
                        />
                        <Subtasks
                           api={api}
                           id={id}
                           tasks={tasks ?? []}
                           today={today}
                           sessions={sessions}
                           onOpen={onOpen}
                           onError={setError}
                        />
                        <SessionList
                           task={task}
                           current={api.sessionId}
                           sessions={sessions}
                           now={now}
                           host={host}
                        />
                        <Activity
                           activity={task.activity}
                           byId={byId}
                           task={task}
                           sessions={sessions}
                           now={now}
                        />
                     </div>
                  )}
               </ScrollArea>
            </>
         )}
         <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
            <DialogContent>
               <DialogHeader>
                  <DialogTitle>Delete task?</DialogTitle>
                  <DialogDescription>
                     "{task?.title ?? id}", its description and its files will be deleted. Its
                     subtasks move to its parent. This cannot be undone.
                  </DialogDescription>
               </DialogHeader>
               <DialogFooter>
                  <Button variant="outline" onClick={() => setConfirmDelete(false)}>
                     Cancel
                  </Button>
                  <Button variant="destructive" onClick={remove}>
                     Delete
                  </Button>
               </DialogFooter>
            </DialogContent>
         </Dialog>
      </div>
   );
}

const Label = ({ children }: { children: ReactNode }) => (
   <span className="flex h-6 items-center text-muted-foreground">{children}</span>
);

/** Linear's "Sub-task of" line under the title: the direct parent with its status and progress; a click opens it. */
function ParentLine({
   parent,
   progress,
   onOpen,
}: {
   parent: TaskSummary;
   progress: { done: number; total: number };
   onOpen: () => void;
}) {
   return (
      <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
         <span className="shrink-0">Sub-task of</span>
         <button
            type="button"
            className="-mx-1 flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-foreground/80 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onOpen}
         >
            <StatusIcon status={parent.status} />
            <span className="min-w-0 truncate">
               <InlineMarkdown variant="quiet">{parent.title}</InlineMarkdown>
            </span>
            {progress.total > 0 && (
               <span className="shrink-0 tabular-nums text-muted-foreground">
                  {progress.done}/{progress.total}
               </span>
            )}
         </button>
      </div>
   );
}

/**
 * The title, one line of Markdown: saved on Enter and on blur. A title changed elsewhere loads in unless typing or
 * not saved yet (a failed save stays, and the next blur tries again); one that came while typing loads on blur.
 */
function TitleEditor({ task, onSave }: { task: Task; onSave: (title: string) => Promise<void> }) {
   const editor = useRef<PromptEditorHandle>(null);
   /** The title the editor was loaded with or last saved. */
   const shown = useRef<string | null>(null);
   /** A title typed but not saved yet (saving or failed); null: none. */
   const unsaved = useRef<string | null>(null);
   const focused = useRef(false);
   const load = (title: string) => {
      shown.current = title;
      unsaved.current = null;
      editor.current?.loadMarkdown(title);
   };
   useEffect(() => {
      if (focused.current || unsaved.current !== null || task.title === shown.current) return;
      shown.current = task.title;
      editor.current?.loadMarkdown(task.title);
   }, [task.title]);
   const save = () => {
      const md = editor.current?.getMarkdown().trim() ?? "";
      if (!md) return load(task.title);
      if (md === shown.current) {
         unsaved.current = null;
         return;
      }
      unsaved.current = md;
      onSave(md).then(
         () => {
            shown.current = md;
            if (unsaved.current === md) unsaved.current = null;
         },
         // The error shows above; the text stays unsaved for the next blur.
         noop,
      );
   };
   return (
      <div
         className="-mx-1 text-base font-semibold [&_[contenteditable]]:text-base"
         onFocus={() => {
            focused.current = true;
         }}
         onBlur={() => {
            focused.current = false;
            save();
            if (unsaved.current === null && task.title !== shown.current) load(task.title);
         }}
      >
         <PromptEditor
            ref={editor}
            label="Task title"
            placeholder="Title"
            singleLine
            menuOpen={false}
            onMenuKey={noop}
            onChange={noop}
            // Enter leaves the title; the blur saves it.
            onSubmit={() => (document.activeElement as HTMLElement | null)?.blur()}
            minHeightClassName="min-h-6"
         />
      </div>
   );
}

/**
 * The description, typed in place and autosaved (600 ms, blur, unmount). The save sends the `body_updated_ms` it
 * loaded; a body changed elsewhere since is refused, and the user reloads. Pasted or dropped files become assets.
 */
function BodyEditor({
   api,
   task,
   put,
   onError,
   onAddFiles,
}: {
   api: TaskApi;
   task: Task;
   put: (t: Task) => void;
   onError: (message: string | null) => void;
   onAddFiles: (files: AttachmentInput[]) => void;
}) {
   const id = task.id;
   const body = useAutosavedMarkdown({
      value: task,
      baseOf: (t) => t.body_updated_ms,
      textOf: (t) => t.body,
      write: (md, base) => api.updateTask(id, { body: md }, base),
      read: () => api.readTask(id),
      onStored: put,
      onFiles: onAddFiles,
      onError,
   });

   return (
      <section aria-label="Description">
         <div className={SECTION}>
            <span className="flex-1">Description</span>
            {body.status === "conflict" ? (
               <span className="flex items-center gap-1.5 normal-case tracking-normal text-amber-500">
                  Changed elsewhere
                  <Button
                     size="sm"
                     variant="outline"
                     className="h-6 px-2 text-xs"
                     onClick={body.reload}
                  >
                     Reload
                  </Button>
               </span>
            ) : body.status === "pending" || body.status === "saving" ? (
               <span className="font-normal normal-case tracking-normal">Saving…</span>
            ) : null}
         </div>
         {body.status === "error" && (
            <div role="alert" className="pb-1.5 text-xs text-destructive">
               {body.error}
            </div>
         )}
         <div
            className={cn(
               "rounded-xl border border-transparent px-2 py-1.5 transition-colors hover:border-border",
               "focus-within:border-ring/50 dark:focus-within:border-border",
            )}
            {...body.box}
         >
            <PromptEditor
               ref={body.editor}
               label="Task description"
               placeholder="Add a description… Markdown ok"
               newlineOnEnter
               menuOpen={false}
               onMenuKey={noop}
               onSubmit={body.onSubmit}
               onChange={body.onChange}
               maxHeightClassName="max-h-none"
               minHeightClassName="min-h-16"
            />
         </div>
      </section>
   );
}

function Assets({
   api,
   task,
   dragOver,
   onAdd,
   onRemove,
   onError,
}: {
   api: TaskApi;
   task: Task;
   /** Files are dragged over the task: they would land here. */
   dragOver: boolean;
   onAdd: (files: AttachmentInput[]) => void;
   onRemove: (name: string) => void;
   onError: (message: string) => void;
}) {
   const id = task.id;
   const assets: StripAsset[] = task.assets.map((a) => ({
      key: `task:${id}/${a.name}/${a.size}`,
      name: a.name,
      image: a.mime.startsWith("image/"),
      read: () => api.readTaskAsset(id, a.name),
      remove: () => onRemove(a.name),
   }));
   return (
      <section aria-label="Assets">
         <div className={SECTION}>
            <span className="flex-1">
               Assets{task.assets.length > 0 && ` · ${task.assets.length}`}
            </span>
         </div>
         <AssetStrip assets={assets} className="pb-2 pt-0" />
         <DropZone
            compact={task.assets.length > 0}
            over={dragOver}
            onAdd={onAdd}
            onError={onError}
         />
      </section>
   );
}

/**
 * Where files go: a dashed area that opens the picker on click (the native one in the app). Drops are taken by the
 * whole task (`useFileDrop`); `over` lights it up while files are dragged over the task.
 * `compact`: one short line, when the task already has files.
 */
function DropZone({
   compact,
   over,
   onAdd,
   onError,
}: {
   compact: boolean;
   over: boolean;
   onAdd: (files: AttachmentInput[]) => void;
   onError: (message: string) => void;
}) {
   return (
      <AddFilesButton label="Add files" onAdd={onAdd} onError={onError}>
         {(pick) => (
            <button
               type="button"
               aria-label="Add files"
               data-over={over || undefined}
               onClick={pick}
               className={cn(
                  "flex w-full items-center justify-center gap-2 rounded-lg border border-dashed text-xs text-muted-foreground outline-none transition-colors hover:border-foreground/30 hover:bg-accent/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                  compact ? "h-8" : "h-16 flex-col gap-1",
                  over && "border-ring bg-accent/60 text-foreground",
               )}
            >
               <Upload className={compact ? "size-3.5" : "size-4"} />
               Drop files here or click to add
            </button>
         )}
      </AddFilesButton>
   );
}

function Subtasks({
   api,
   id,
   tasks,
   today,
   sessions,
   onOpen,
   onError,
}: {
   api: TaskApi;
   id: string;
   tasks: readonly TaskSummary[];
   today: string;
   sessions: Sessions | undefined;
   onOpen: (id: string) => void;
   onError: (message: string) => void;
}) {
   const [adding, setAdding] = useState(false);
   const kids = childrenOf(tasks, id);
   const { done, total } = topicProgress(tasks, id);
   return (
      <section aria-label="Subtasks">
         <div className={SECTION}>
            <span className="flex-1">Subtasks{total > 0 && ` · ${done}/${total}`}</span>
            <Tooltip content="Add subtask">
               <button
                  type="button"
                  aria-label="Add subtask"
                  className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  onClick={() => setAdding(true)}
               >
                  <Plus className="size-3.5" />
               </button>
            </Tooltip>
         </div>
         <div className="-mx-2 flex flex-col">
            {kids.map((t) => (
               <TaskRow
                  key={t.id}
                  task={t}
                  parent={null}
                  progress={
                     tasks.some((x) => x.parent_id === t.id) ? topicProgress(tasks, t.id) : null
                  }
                  waitsOn={t.deps.length > 0 ? openBlockers(tasks, t.id) : 0}
                  today={today}
                  sessionId={api.sessionId}
                  sessions={sessions}
                  onOpen={() => onOpen(t.id)}
                  onStatus={(status) =>
                     api.updateTask(t.id, { status }).catch((e) => onError(errText(e)))
                  }
               />
            ))}
         </div>
         {adding ? (
            <QuickAdd
               className="pt-1"
               label="New subtask"
               placeholder="Subtask title… Enter adds, Esc closes"
               autoFocus
               onAdd={(title) => api.createTask({ title, parentId: id })}
               onCancel={() => setAdding(false)}
            />
         ) : (
            kids.length === 0 && <p className="text-xs text-muted-foreground/70">No subtasks.</p>
         )}
      </section>
   );
}

/**
 * Blocked by (what this task waits on, with the + picker) and Blocks (what waits on it), each with its follow-ups
 * in a short list under it (ADR 0029). A click opens the linked task; × on this task's own deps removes one. Every
 * change sends the whole new deps list of this task, the one that waits.
 */
function Dependencies({
   id,
   deps,
   tasks,
   onOpen,
   onChange,
}: {
   id: string;
   deps: readonly TaskDep[];
   /** All tasks, with this one's current deps. */
   tasks: readonly TaskSummary[];
   onOpen: (id: string) => void;
   onChange: (deps: TaskDep[]) => void;
}) {
   const waitsOn = blockedBy(tasks, id);
   const follows = followsOf(tasks, id);
   const waiting = blocks(tasks, id);
   const followers = followedBy(tasks, id);
   const remove = (other: string) => onChange(deps.filter((d) => d.id !== other));
   return (
      <>
         <section aria-label="Blocked by">
            <div className={SECTION}>
               <span className="flex-1">
                  Blocked by{waitsOn.length > 0 && ` · ${waitsOn.length}`}
               </span>
               <DepPicker
                  taskId={id}
                  tasks={tasks}
                  onAdd={(other, kind) => onChange([...deps, { id: other, kind }])}
               />
            </div>
            <div className="flex flex-col gap-1">
               {waitsOn.map((t) => (
                  <DepLine
                     key={t.id}
                     task={t}
                     onOpen={() => onOpen(t.id)}
                     onRemove={() => remove(t.id)}
                  />
               ))}
               {waitsOn.length === 0 && follows.length === 0 && (
                  <p className="text-xs text-muted-foreground/70">Waits on no task.</p>
               )}
            </div>
            <FollowList
               label="Follows"
               tasks={follows}
               onOpen={onOpen}
               onRemove={(t) => remove(t.id)}
            />
         </section>
         {(waiting.length > 0 || followers.length > 0) && (
            <section aria-label="Blocks">
               <div className={SECTION}>Blocks{waiting.length > 0 && ` · ${waiting.length}`}</div>
               <div className="flex flex-col gap-1">
                  {waiting.map((t) => (
                     <DepLine key={t.id} task={t} onOpen={() => onOpen(t.id)} />
                  ))}
               </div>
               <FollowList label="Followed by" tasks={followers} onOpen={onOpen} />
            </section>
         )}
      </>
   );
}

/** A linked task: status, title and id; a click opens it. `onRemove`: an × to drop the link. */
function DepLine({
   task,
   compact,
   onOpen,
   onRemove,
}: {
   task: TaskSummary;
   compact?: boolean;
   onOpen: () => void;
   onRemove?: () => void;
}) {
   const open = isOpen(task.status);
   return (
      <div
         className={cn(
            "group/dep flex min-w-0 items-center gap-1 rounded-md pr-1",
            compact ? "h-7" : "h-8 bg-muted/40",
            "hover:bg-accent/60",
         )}
      >
         <button
            type="button"
            className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onOpen}
         >
            <StatusIcon status={task.status} />
            <span
               className={cn(
                  "min-w-0 flex-1 truncate",
                  !open && "text-muted-foreground line-through",
               )}
            >
               <InlineMarkdown variant="quiet">{task.title}</InlineMarkdown>
            </span>
            <span className="shrink-0 text-[11px] text-muted-foreground">{task.id}</span>
         </button>
         {onRemove && (
            <Tooltip content="Remove link">
               <button
                  type="button"
                  aria-label={`Remove link to ${task.title}`}
                  className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/dep:opacity-100"
                  onClick={onRemove}
               >
                  <X className="size-3" />
               </button>
            </Tooltip>
         )}
      </div>
   );
}

/** Follow-ups, short: a small label, then compact lines. Nothing when there are none. */
function FollowList({
   label,
   tasks,
   onOpen,
   onRemove,
}: {
   label: string;
   tasks: readonly TaskSummary[];
   onOpen: (id: string) => void;
   onRemove?: (task: TaskSummary) => void;
}) {
   if (tasks.length === 0) return null;
   return (
      <div className="flex flex-col pt-1.5" role="group" aria-label={label}>
         <span className="pb-0.5 text-[11px] text-muted-foreground">{label}</span>
         {tasks.map((t) => (
            <DepLine
               key={t.id}
               task={t}
               compact
               onOpen={() => onOpen(t.id)}
               onRemove={onRemove && (() => onRemove(t))}
            />
         ))}
      </div>
   );
}

/** A Session as a chip with its dot; it opens the Session (when the host can) unless it is this one or deleted. */
function SessionChip({
   sessionId,
   title,
   current,
   sessions,
}: {
   sessionId: string | null;
   title: string | null;
   current: string | null;
   sessions: Sessions | undefined;
}) {
   const openSession = useContext(OpenSession);
   if (!sessionId) return <span className="text-muted-foreground">Outside a Session</span>;
   const here = sessionId === current;
   const shown = sessionTitle(sessionId, title, sessions);
   const body = (
      <>
         <span className="size-1.5 shrink-0 rounded-full bg-sky-500" />
         <span className="truncate">{here ? "This session" : shown.title}</span>
      </>
   );
   if (here || shown.gone || !openSession)
      return (
         <span className="inline-flex h-6 max-w-full items-center gap-1.5 rounded-md bg-muted px-2">
            {body}
         </span>
      );
   return (
      <button
         type="button"
         className="inline-flex h-6 max-w-full items-center gap-1.5 rounded-md bg-muted px-2 hover:bg-accent"
         onClick={() => openSession(sessionId)}
      >
         {body}
         <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
      </button>
   );
}

function SessionList({
   task,
   current,
   sessions,
   now,
   host,
}: {
   task: Task;
   current: string | null;
   sessions: Sessions | undefined;
   now: number;
   host: PanelCtx["host"];
}) {
   const openSession = useContext(OpenSession);
   const rows: { id: string; title: string; gone: boolean; note: string; tag: string | null }[] =
      [];
   if (task.origin_session_id)
      rows.push({
         id: task.origin_session_id,
         ...sessionTitle(task.origin_session_id, task.origin_title, sessions),
         note: "Created this task",
         tag: "origin",
      });
   for (const l of task.sessions)
      rows.push({
         id: l.session_id,
         ...sessionTitle(l.session_id, l.title, sessions),
         note: `Started from this task · ${formatAgeAgo(l.started_ms, now)}`,
         tag: null,
      });
   return (
      <section aria-label="Sessions">
         <div className={SECTION}>
            <span className="flex-1">Sessions</span>
            {host.startFromTask && (
               <Button
                  size="sm"
                  variant="ghost"
                  className="-my-1 h-6 gap-1 px-1.5 text-xs font-normal normal-case tracking-normal text-muted-foreground hover:text-foreground [&_svg]:size-3"
                  onClick={() => host.startFromTask?.(task.id)}
               >
                  <Play className="fill-current" /> Start session
               </Button>
            )}
         </div>
         <div className="flex flex-col gap-1.5">
            {rows.length === 0 && (
               <p className="text-xs text-muted-foreground/70">No Session started from it yet.</p>
            )}
            {rows.map((r) => {
               const here = r.id === current;
               const can = !here && !r.gone && !!openSession;
               return (
                  <button
                     key={`${r.id}-${r.note}`}
                     type="button"
                     disabled={!can}
                     onClick={() => can && openSession(r.id)}
                     className={cn(
                        "flex items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left disabled:cursor-default",
                        can && "hover:bg-accent/60",
                     )}
                  >
                     <span
                        className={cn(
                           "size-1.5 shrink-0 rounded-full",
                           here ? "bg-sky-500" : "bg-muted-foreground/50",
                        )}
                     />
                     <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px]">
                           {r.title}
                           {here && <span className="text-muted-foreground"> · this session</span>}
                        </span>
                        <span className="block truncate text-[11px] text-muted-foreground">
                           {r.note}
                        </span>
                     </span>
                     {r.tag && <span className="text-[11px] text-muted-foreground">{r.tag}</span>}
                  </button>
               );
            })}
         </div>
      </section>
   );
}

const MAX_ACTIVITY = 20;

function activityText(
   a: TaskActivity,
   byId: ReadonlyMap<string, TaskSummary>,
   task: Task,
   sessions: Sessions | undefined,
): ReactNode {
   const who = a.by === "agent" ? "The Agent" : "You";
   const k = a.kind;
   switch (k.type) {
      case "created":
         return `${who} created this task`;
      case "moved": {
         if (!k.to) return `${who} moved it to the top level`;
         const to = byId.get(k.to);
         return (
            <>
               {who} moved it under{" "}
               <span className="text-foreground/80">
                  {to ? <InlineMarkdown variant="quiet">{to.title}</InlineMarkdown> : k.to}
               </span>
            </>
         );
      }
      case "status_changed":
         return `${who} changed the status: ${STATUS_LABEL[k.from]} → ${STATUS_LABEL[k.to]}`;
      case "session_started": {
         const link = task.sessions.find((l) => l.session_id === k.session_id);
         const title = link && sessionTitle(link.session_id, link.title, sessions).title;
         return `${who} started a Session from it${title ? `: ${title}` : ""}`;
      }
      case "dep_added":
      case "dep_removed": {
         const other = byId.get(k.id);
         const verb =
            k.type === "dep_removed"
               ? "removed the link to"
               : k.kind === "follow_up"
                 ? "made it follow"
                 : "made it wait on";
         return (
            <>
               {who} {verb}{" "}
               <span className="text-foreground/80">
                  {other ? <InlineMarkdown variant="quiet">{other.title}</InlineMarkdown> : k.id}
               </span>
            </>
         );
      }
      case "props_changed":
         return `${who} changed the properties`;
   }
}

function Activity({
   activity,
   byId,
   task,
   sessions,
   now,
}: {
   activity: TaskActivity[];
   byId: ReadonlyMap<string, TaskSummary>;
   task: Task;
   sessions: Sessions | undefined;
   now: number;
}) {
   if (activity.length === 0) return null;
   const shown = activity.slice(-MAX_ACTIVITY);
   return (
      <section
         aria-label="Activity"
         className="flex flex-col gap-1.5 border-t pt-3 text-xs text-muted-foreground"
      >
         {shown.map((a) => (
            <div key={`${a.at_ms}:${JSON.stringify(a.kind)}`}>
               {activityText(a, byId, task, sessions)} ·{" "}
               <Tooltip content={formatDateTime(a.at_ms)}>
                  <span>{formatAgeAgo(a.at_ms, now)}</span>
               </Tooltip>
            </div>
         ))}
      </section>
   );
}
