import {
   errText,
   type HarnessClient,
   inTauri,
   pickFolderDialog,
   type SessionSummary,
   type TaskStatus,
} from "@harness/api";
import {
   Button,
   Dialog,
   DialogContent,
   DialogDescription,
   DialogFooter,
   DialogHeader,
   DialogTitle,
   ScrollArea,
} from "@harness/ui";
import { useEffect, useState } from "react";
import { AgentField } from "./AgentField";
import {
   defaultSetStatus,
   defaultTaskParts,
   loadWorktreePref,
   rememberFolder,
   type StartTask,
   startFromTaskArgs,
   type TaskParts,
} from "./composer";
import { FolderField } from "./FolderField";
import { FrontendField } from "./FrontendField";
import { MoreOptions } from "./MoreOptions";
import { StartFromField } from "./StartFromField";
import { createArgs, defaultTarget, startPointReady, type Target, targetInfo } from "./startPoint";
import { PromptField, SetStatusField, TaskCard, TaskContextField } from "./TaskFields";
import { useBranches } from "./useBranches";
import { useComposerCatalog } from "./useComposerCatalog";
import { usePullRequests } from "./usePullRequests";
import { useRecentFolders } from "./useRecentFolders";

/**
 * The Composer: sets up a new Session (Workspace, start point, Agent, Frontend) before work starts.
 * With `task` it starts the Session from that task (board "StartSession", ADR 0028): the task context
 * to give the Agent, a status to set once, and a first prompt sent after the Session is made.
 */
export function ComposerDialog({
   client,
   open: isOpen,
   onOpenChange,
   onCreated,
   agentsVersion = 0,
   sessions = [],
   mcpVersion = 0,
   onManageAgents,
   folder: presetFolder = null,
   task = null,
   onPromptError,
}: {
   /** Bump to reload the Agent list (after installs/removals). */
   agentsVersion?: number;
   /** The Session list, for preselecting the newest Session's Agent. */
   sessions?: SessionSummary[];
   /** Bump to reload the MCP Library. */
   mcpVersion?: number;
   onManageAgents?: () => void;
   /** Folder to open with (the + on a sidebar folder group); null: the most recent one. */
   folder?: string | null;
   /** Start from this task; the folder defaults to its origin Session's (`folder`). */
   task?: StartTask | null;
   client: HarnessClient;
   open: boolean;
   onOpenChange: (o: boolean) => void;
   onCreated: (sessionId: string) => void;
   /** The first prompt of a Session started from a task failed (the Session was made). */
   onPromptError?: (e: unknown) => void;
}) {
   const [title, setTitle] = useState("");
   const [more, setMore] = useState(false);
   const [busy, setBusy] = useState(false);
   const [error, setError] = useState<string | null>(null);

   // Start from a task: reset to the task's defaults each time it opens.
   const [prompt, setPrompt] = useState("");
   const [parts, setParts] = useState<TaskParts | null>(null);
   const [setStatus, setSetStatus] = useState<TaskStatus | null>(null);
   useEffect(() => {
      if (!isOpen || !task) return;
      setPrompt(task.prompt);
      setParts(defaultTaskParts(task));
      setSetStatus(defaultSetStatus(task.status));
   }, [isOpen, task]);

   // Workspace folder
   const [folderOpen, setFolderOpen] = useState(false);
   const [folderQuery, setFolderQuery] = useState("");

   // Start point
   const [target, setTarget] = useState<Target | null>(null);
   const [worktree, setWorktree] = useState(false);
   /** A PR opens in a Worktree unless turned off (then it is checked out in the folder). */
   const [prWorktree, setPrWorktree] = useState(true);
   const [startOpen, setStartOpen] = useState(false);
   const [branchQuery, setBranchQuery] = useState("");
   const [prQuery, setPrQuery] = useState("");

   const [agentOpen, setAgentOpen] = useState(false);
   const [agentQuery, setAgentQuery] = useState("");

   const {
      agents,
      frontends,
      agentId,
      setAgentId,
      frontendId,
      setFrontendId,
      mcpServers,
      mcpIds,
      setMcpIds,
   } = useComposerCatalog({
      client,
      isOpen,
      agentsVersion,
      mcpVersion,
      sessions,
      setError,
   });
   const { recent, folder, setFolder, noFolder, setNoFolder, recentBranch } = useRecentFolders({
      client,
      isOpen,
      presetFolder,
      folderOpen,
   });
   const { branches, updating, updateBranch } = useBranches({
      client,
      isOpen,
      folder,
      setError,
      onLoaded: (b) => {
         setTarget(defaultTarget(b));
         setWorktree(loadWorktreePref());
      },
   });

   const isRepo = branches?.repo_root != null;

   const { mode, setMode, prs, prError, prFilter, setPrFilter, pr, setPr } = usePullRequests({
      client,
      isOpen,
      folder,
      isRepo,
   });

   const pickFolder = (p: string) => {
      setNoFolder(false);
      setFolder(p);
      setFolderOpen(false);
      setFolderQuery("");
   };

   const pickNoFolder = () => {
      pickFolder("");
      setNoFolder(true);
   };

   const browse = async () => {
      setFolderOpen(false);
      const picked = await pickFolderDialog();
      if (picked) pickFolder(picked);
   };

   const create = async () => {
      setBusy(true);
      setError(null);
      try {
         const repoArgs = createArgs({
            isRepo,
            mode,
            pr,
            target,
            info: targetInfo(target, branches),
            current: branches?.current ?? null,
            worktree,
            prWorktree,
         });
         const common = { agentId, frontendId, title: title.trim() || null, mcpServers: mcpIds };
         const fromTask =
            task && parts
               ? startFromTaskArgs({ task, include: parts, setStatus, title, prompt })
               : null;
         const id =
            noFolder && !fromTask
               ? await client.createQuickSession(common)
               : await client.createSession({
                    folder: folder.trim(),
                    ...common,
                    ...repoArgs,
                    ...(fromTask && { title: fromTask.title, task: fromTask.task }),
                 });
         if (!noFolder) rememberFolder(folder.trim());
         // The Session exists now: a failed prompt is reported, but the dialog still closes on it.
         if (fromTask?.prompt)
            await client
               .sessionApi(id)
               .prompt(fromTask.prompt)
               .catch((e) => onPromptError?.(e));
         setTitle("");
         setMcpIds([]);
         setPr(null);
         onOpenChange(false);
         onCreated(id);
      } catch (e) {
         setError(errText(e));
      } finally {
         setBusy(false);
      }
   };

   const canCreate =
      !busy &&
      (task ? !!folder.trim() && !noFolder : noFolder || !!folder.trim()) &&
      !!agentId &&
      !!frontendId &&
      startPointReady({ isRepo, mode, pr, target });

   const onKeyDown = (e: React.KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "Enter" && canCreate) {
         e.preventDefault();
         void create();
      } else if (e.key.toLowerCase() === "o" && inTauri()) {
         e.preventDefault();
         void browse();
      }
   };

   return (
      <Dialog open={isOpen} onOpenChange={onOpenChange}>
         <DialogContent className="max-w-[32rem] gap-4 p-0" onKeyDown={onKeyDown}>
            <DialogHeader className="px-5 pt-5">
               <DialogTitle>{task ? "Start session from task" : "New Session"}</DialogTitle>
               <DialogDescription className="sr-only">
                  {task
                     ? "Pick the task context, the prompt, the Workspace folder and the Agent."
                     : "Pick the Workspace folder, where to start, the Agent and the Frontend."}
               </DialogDescription>
            </DialogHeader>

            <ScrollArea className="max-h-[calc(100vh-12rem)]" viewportClassName="max-h-[inherit]">
               <div className="grid gap-3 px-5 text-sm">
                  {task && parts && (
                     <>
                        <TaskCard task={task} />
                        <PromptField value={prompt} onChange={setPrompt} />
                        <TaskContextField
                           client={client}
                           task={task}
                           parts={parts}
                           setParts={(f) => setParts((p) => p && f(p))}
                        />
                     </>
                  )}
                  <FolderField
                     recent={recent}
                     recentBranch={recentBranch}
                     folder={folder}
                     noFolder={noFolder}
                     folderOpen={folderOpen}
                     setFolderOpen={setFolderOpen}
                     folderQuery={folderQuery}
                     setFolderQuery={setFolderQuery}
                     pickFolder={pickFolder}
                     pickNoFolder={task ? undefined : pickNoFolder}
                     browse={browse}
                  />

                  {isRepo && (
                     <StartFromField
                        branches={branches}
                        mode={mode}
                        setMode={setMode}
                        target={target}
                        setTarget={setTarget}
                        worktree={worktree}
                        setWorktree={setWorktree}
                        prWorktree={prWorktree}
                        setPrWorktree={setPrWorktree}
                        pr={pr}
                        setPr={setPr}
                        prs={prs}
                        prError={prError}
                        prFilter={prFilter}
                        setPrFilter={setPrFilter}
                        updating={updating}
                        updateBranch={updateBranch}
                        startOpen={startOpen}
                        setStartOpen={setStartOpen}
                        branchQuery={branchQuery}
                        setBranchQuery={setBranchQuery}
                        prQuery={prQuery}
                        setPrQuery={setPrQuery}
                     />
                  )}

                  <AgentField
                     agents={agents}
                     agentId={agentId}
                     setAgentId={setAgentId}
                     agentOpen={agentOpen}
                     setAgentOpen={setAgentOpen}
                     agentQuery={agentQuery}
                     setAgentQuery={setAgentQuery}
                     onManageAgents={onManageAgents}
                  />

                  <FrontendField
                     frontends={frontends}
                     frontendId={frontendId}
                     setFrontendId={setFrontendId}
                  />

                  {task && (
                     <SetStatusField
                        current={task.status}
                        value={setStatus}
                        onChange={setSetStatus}
                     />
                  )}

                  <MoreOptions
                     more={more}
                     setMore={setMore}
                     mcpServers={mcpServers}
                     mcpIds={mcpIds}
                     setMcpIds={setMcpIds}
                     title={title}
                     setTitle={setTitle}
                     mode={mode}
                     pr={pr}
                     noFolder={noFolder}
                     folder={folder}
                  />
                  {error && <p className="whitespace-pre-wrap text-destructive">{error}</p>}
               </div>
            </ScrollArea>

            <DialogFooter className="items-center border-t px-5 py-3">
               {task && (
                  <p className="mr-auto text-xs text-muted-foreground">
                     The new session links back to this task.
                  </p>
               )}
               <Button variant="outline" onClick={() => onOpenChange(false)}>
                  Cancel
               </Button>
               <Button disabled={!canCreate} onClick={() => void create()}>
                  {task ? "Start session" : "Create"} <span className="text-xs opacity-60">⌘↵</span>
               </Button>
            </DialogFooter>
         </DialogContent>
      </Dialog>
   );
}
