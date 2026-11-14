import {
   errText,
   type HarnessClient,
   inTauri,
   pickFolderDialog,
   type SessionSummary,
} from "@harness/api";
import {
   Button,
   Dialog,
   DialogContent,
   DialogDescription,
   DialogFooter,
   DialogHeader,
   DialogTitle,
} from "@harness/ui";
import { useState } from "react";
import { AgentField } from "./AgentField";
import { rememberFolder } from "./composer";
import { FolderField } from "./FolderField";
import { FrontendField } from "./FrontendField";
import { MoreOptions } from "./MoreOptions";
import { StartFromField } from "./StartFromField";
import { createArgs, defaultTarget, startPointReady, type Target } from "./startPoint";
import { useBranches } from "./useBranches";
import { useComposerCatalog } from "./useComposerCatalog";
import { usePullRequests } from "./usePullRequests";
import { useRecentFolders } from "./useRecentFolders";

/** The Composer: sets up a new Session (Workspace, start point, Agent, Frontend) before work starts. */
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
   client: HarnessClient;
   open: boolean;
   onOpenChange: (o: boolean) => void;
   onCreated: (sessionId: string) => void;
}) {
   const [title, setTitle] = useState("");
   const [more, setMore] = useState(false);
   const [busy, setBusy] = useState(false);
   const [error, setError] = useState<string | null>(null);

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
         setWorktree(false);
      },
   });

   const isRepo = branches?.repo_root != null;

   const { mode, setMode, prs, prAvailable, prFilter, setPrFilter, pr, setPr } = usePullRequests({
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
            current: branches?.current ?? null,
            worktree,
            prWorktree,
         });
         const common = { agentId, frontendId, title: title.trim() || null, mcpServers: mcpIds };
         const id = noFolder
            ? await client.createQuickSession(common)
            : await client.createSession({ folder: folder.trim(), ...common, ...repoArgs });
         if (!noFolder) rememberFolder(folder.trim());
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
      (noFolder || !!folder.trim()) &&
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
               <DialogTitle>New Session</DialogTitle>
               <DialogDescription className="sr-only">
                  Pick the Workspace folder, where to start, the Agent and the Frontend.
               </DialogDescription>
            </DialogHeader>

            <div className="grid gap-3 px-5 text-sm">
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
                  pickNoFolder={pickNoFolder}
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
                     prAvailable={prAvailable}
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

            <DialogFooter className="border-t px-5 py-3">
               <Button variant="outline" onClick={() => onOpenChange(false)}>
                  Cancel
               </Button>
               <Button disabled={!canCreate} onClick={() => void create()}>
                  Create <span className="text-xs opacity-60">⌘↵</span>
               </Button>
            </DialogFooter>
         </DialogContent>
      </Dialog>
   );
}
