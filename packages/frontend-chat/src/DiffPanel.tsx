import { type Diff, openWindow, type SessionApi, type WorkspaceInfo } from "@harness/api";
import {
   Button,
   cn,
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuSub,
   DropdownMenuSubContent,
   DropdownMenuSubTrigger,
   DropdownMenuTrigger,
   ScrollArea,
   Tooltip,
} from "@harness/ui";
import { ChevronRight, Copy, Maximize2, MoreHorizontal, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CommitsPane, useCommits } from "./CommitsPane";
import { CommentCount, DiffViewer } from "./DiffViewer";
import { diffWindowUrl } from "./DiffWindow";
import { type FilePatch, splitPatch } from "./diff";
import { PanelHeader } from "./PanelHeader";
import { type DiffComment, useDiffComments } from "./reviewComments";
import { type DiffScope, selectionScope } from "./scope";
import { useGitStatus } from "./useGitStatus";

export { ALL_CHANGES, type DiffScope } from "./scope";

const errorMessage = (err: unknown): string =>
   err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);

const copy = (text: string) => void navigator.clipboard.writeText(text).catch(() => {});

/** Per-file actions. Copy is a submenu so more top-level entries fit later. */
function FileMenu({ path, root }: { path: string; root: string | null | undefined }) {
   const name = path.slice(path.lastIndexOf("/") + 1);
   return (
      <DropdownMenu>
         <DropdownMenuTrigger
            aria-label={`Actions for ${path}`}
            className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-accent-foreground data-[state=open]:bg-accent"
            onClick={(e) => e.stopPropagation()}
         >
            <MoreHorizontal className="size-4" />
         </DropdownMenuTrigger>
         <DropdownMenuContent align="end" className="min-w-40">
            <DropdownMenuSub>
               <DropdownMenuSubTrigger>
                  <Copy /> Copy
               </DropdownMenuSubTrigger>
               <DropdownMenuSubContent>
                  {root && (
                     <DropdownMenuItem onSelect={() => copy(`${root.replace(/\/$/, "")}/${path}`)}>
                        Absolute path
                     </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onSelect={() => copy(path)}>Relative path</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => copy(name)}>Filename</DropdownMenuItem>
               </DropdownMenuSubContent>
            </DropdownMenuSub>
         </DropdownMenuContent>
      </DropdownMenu>
   );
}

/** One collapsible file: name, folder, +/− and actions; the condensed unified diff when open. */
function FileRow({
   api,
   file,
   comments,
   root,
   open,
   onToggle,
}: {
   api: SessionApi;
   file: FilePatch;
   comments: DiffComment[];
   root: string | null | undefined;
   open: boolean;
   onToggle: () => void;
}) {
   const slash = file.path.lastIndexOf("/");
   return (
      <div>
         <div className="group flex h-8 items-center gap-1.5 pr-2 pl-2 text-sm hover:bg-accent/50">
            <button
               className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch text-left"
               aria-expanded={open}
               onClick={onToggle}
            >
               <ChevronRight
                  className={cn(
                     "size-3.5 shrink-0 text-muted-foreground transition-transform",
                     open && "rotate-90",
                  )}
               />
               <span className="shrink-0 truncate">{file.path.slice(slash + 1)}</span>
               <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {slash > 0 ? file.path.slice(0, slash) : ""}
               </span>
               <CommentCount n={comments.filter((c) => c.path === file.path).length} />
               <span className="shrink-0 font-mono text-xs text-emerald-500">
                  +{file.additions}
               </span>
               <span className="w-8 shrink-0 font-mono text-xs text-red-500">
                  −{file.deletions}
               </span>
            </button>
            <FileMenu path={file.path} root={root} />
         </div>
         {open && (
            <div className="mb-2 border-y">
               <DiffViewer
                  sessionId={api.sessionId}
                  file={file}
                  comments={comments}
                  mode="unified"
                  wrap
               />
            </div>
         )}
      </div>
   );
}

export function DiffPanel({
   api,
   scope,
   onScope,
   refreshKey,
   onRefresh,
}: {
   api: SessionApi;
   scope: DiffScope;
   onScope: (s: DiffScope) => void;
   /** Changes whenever the Session log says the Workspace may have changed. */
   refreshKey: string;
   /** Also called by Refresh, for what the host shows of the same Workspace. */
   onRefresh?: () => void;
}) {
   const [workspace, setWorkspace] = useState<WorkspaceInfo | null | undefined>(undefined);
   const [diff, setDiff] = useState<Diff | null>(null);
   const [error, setError] = useState<string | null>(null);
   const [open, setOpen] = useState<Set<string>>(new Set());
   const comments = useDiffComments(api.sessionId);
   /** Bumped by Refresh and by a status change seen while polling: commits reload too. */
   const [tick, setTick] = useState(0);
   const commits = useCommits(api, `${refreshKey}:${tick}`);

   useEffect(() => {
      let off = false;
      api.workspace()
         .then((w) => !off && setWorkspace(w))
         .catch(() => !off && setWorkspace(null));
      return () => {
         off = true;
      };
   }, [api]);

   const noRepo = workspace !== undefined && !workspace?.repo_root;

   // A change seen by polling reloads the diff and the commits.
   const { status, changes } = useGitStatus(api, !!workspace?.repo_root, `${refreshKey}:${tick}`);
   useEffect(() => {
      if (changes) setTick((t) => t + 1);
   }, [changes]);

   const load = useCallback(async () => {
      setError(null);
      try {
         setDiff(await api.gitDiff(scope.from, scope.to));
      } catch (e) {
         setError(errorMessage(e));
      }
   }, [api, scope.from, scope.to]);

   useEffect(() => {
      if (workspace?.repo_root) void load();
   }, [workspace, load, refreshKey, tick]);

   const files = useMemo(() => (diff ? splitPatch(diff.patch) : []), [diff]);
   const toggle = (path: string) =>
      setOpen((o) => {
         const n = new Set(o);
         if (!n.delete(path)) n.add(path);
         return n;
      });
   const sum = (k: "additions" | "deletions") => files.reduce((s, f) => s + f[k], 0);

   return (
      <>
         <PanelHeader title={scope.label} titleHint={scope.label}>
            {diff && (
               <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                  {files.length} {files.length === 1 ? "file" : "files"}
                  <span className="font-mono text-emerald-500">+{sum("additions")}</span>
                  <span className="font-mono text-red-500">−{sum("deletions")}</span>
               </span>
            )}
            <div className="flex-1" />
            <Tooltip content="Open in window" side="bottom">
               <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  aria-label="Open diff in window"
                  disabled={noRepo}
                  onClick={() =>
                     void openWindow(`diff-${api.sessionId}`, diffWindowUrl(api.sessionId, scope), {
                        title: `Diff: ${scope.label}`,
                        remember: "diff",
                        overlayTitleBar: true,
                     })
                  }
               >
                  <Maximize2 />
               </Button>
            </Tooltip>
            <Tooltip content="Refresh" side="bottom">
               <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  aria-label="Refresh diff"
                  disabled={noRepo}
                  onClick={() => {
                     setTick((t) => t + 1);
                     onRefresh?.();
                  }}
               >
                  <RefreshCw />
               </Button>
            </Tooltip>
         </PanelHeader>
         {noRepo ? (
            <p className="p-4 text-sm text-muted-foreground">
               This Session's folder is not a git repository, so there is nothing to diff.
            </p>
         ) : (
            <>
               {error && (
                  <p role="alert" className="border-b px-3 py-2 text-xs text-destructive">
                     {error}
                  </p>
               )}
               <ScrollArea className="min-h-0 flex-1">
                  <div className="py-1">
                     {!diff ? (
                        !error && <p className="p-3 text-xs text-muted-foreground">Loading...</p>
                     ) : files.length === 0 ? (
                        <p className="p-3 text-xs text-muted-foreground">No changes.</p>
                     ) : (
                        files.map((f) => (
                           <FileRow
                              key={f.path}
                              api={api}
                              file={f}
                              comments={comments}
                              root={workspace?.repo_root}
                              open={open.has(f.path)}
                              onToggle={() => toggle(f.path)}
                           />
                        ))
                     )}
                  </div>
               </ScrollArea>
               <CommitsPane
                  commits={commits}
                  sel={scope.sel}
                  tipSide="left"
                  uncommitted={status?.files.length}
                  onSelect={(sel) => onScope(selectionScope(sel, commits))}
               />
            </>
         )}
      </>
   );
}
