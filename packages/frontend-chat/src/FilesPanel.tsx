import { openWindow, type SessionApi, type WorkspaceInfo } from "@harness/api";
import { Button, cn, Input, ResizeHandle, Tooltip, useResizableWidth } from "@harness/ui";
import { ExternalLink, File, ListTree, Maximize2, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useWrapCode, WrapButton } from "./CodeBlock";
import { CommentCount } from "./DiffViewer";
import { errorMessage } from "./errors";
import { dirRowKey, FileTreeList, fileRowKey, navRow } from "./FileTreeList";
import { FileView, type LineRange } from "./FileView";
import { ancestorKeys, fileTree, folderStatus } from "./fileTree";
import { PanelHeader } from "./PanelHeader";
import { useFileComments } from "./reviewComments";
import { useGitStatus } from "./useGitStatus";

/** A file to show, with the lines to mark (a code lens, a comment chip). A new object shows it again. */
export type FileTarget = { path: string; start?: number | null; end?: number | null };

/** URL of the pop-out Files window. Boots through the app entry like any solo View window. */
export function filesWindowUrl(sessionId: string, path?: string | null, line?: number | null) {
   const q = new URLSearchParams({ session: sessionId, solo: "1", pane: "files" });
   if (path) q.set("path", path);
   if (path && line) q.set("line", String(line));
   return `/?${q}`;
}

/** The Files window's first file (`path` null: none), or null when this window is not the Files window. */
export function filesWindowTarget(
   search: string,
): { path: string | null; line: number | null } | null {
   const q = new URLSearchParams(search);
   if (q.get("pane") !== "files") return null;
   const line = Number(q.get("line"));
   return { path: q.get("path") || null, line: Number.isInteger(line) && line > 0 ? line : null };
}

/** What the panel remembers per Session (per viewer): the open file, the open folders, the tree's visibility. */
type Saved = { path?: string; open?: string[]; tree?: boolean };
const storeKey = (sessionId: string) => `harness.files.${sessionId}`;
function readSaved(sessionId: string): Saved {
   try {
      const v: unknown = JSON.parse(localStorage.getItem(storeKey(sessionId)) ?? "null");
      return v && typeof v === "object" ? (v as Saved) : {};
   } catch {
      return {};
   }
}
function writeSaved(sessionId: string, s: Saved) {
   try {
      localStorage.setItem(storeKey(sessionId), JSON.stringify(s));
   } catch {
      /* per-viewer convenience only */
   }
}

/** git status letters, as the Changes views color them. */
const GIT: Record<string, { className: string; label: string }> = {
   M: { className: "text-sky-600", label: "modified" },
   A: { className: "text-emerald-600", label: "added" },
   "?": { className: "text-emerald-600", label: "untracked" },
   D: { className: "text-red-600", label: "deleted" },
   R: { className: "text-sky-600", label: "renamed" },
   U: { className: "text-amber-600", label: "conflict" },
};
function GitLetter({ status }: { status: string | undefined }) {
   if (!status) return null;
   const g = GIT[status] ?? { className: "text-muted-foreground", label: status };
   return (
      <span
         className={cn("w-3 shrink-0 text-center font-mono text-xs font-semibold", g.className)}
         title={g.label}
         aria-label={g.label}
      >
         {status === "?" ? "U" : status}
      </span>
   );
}

/** The read error in plain words. */
function readError(path: string, e: unknown) {
   const m = errorMessage(e);
   return /not found|no such file|os error 2/i.test(m) ? `${path} does not exist.` : m;
}

const NO_FOLDERS: ReadonlySet<string> = new Set();
type Change = { path: string; additions: number; deletions: number };

/**
 * The Session folder's files: a tree (right, toggleable, with a name filter) and the open file (left) with line
 * comments that go to the prompt box. `target`: show that file and mark its lines. `popout`: the panel fills its
 * own window (no pop-out button).
 */
export function FilesPanel({
   api,
   target,
   onTargetShown,
   popout = false,
}: {
   api: SessionApi;
   target?: FileTarget | null;
   /** The panel took `target`: the parent can drop it, so a later mount shows the remembered file. */
   onTargetShown?: () => void;
   popout?: boolean;
}) {
   const sessionId = api.sessionId;
   const [saved] = useState(() => readSaved(sessionId));
   const [files, setFiles] = useState<string[] | null>(null);
   /** The folder's path in its repository: git status paths start with it, `files` do not. */
   const [prefix, setPrefix] = useState("");
   const [listError, setListError] = useState<string | null>(null);
   const [selected, setSelected] = useState<string | null>(target?.path ?? saved.path ?? null);
   const [range, setRange] = useState<LineRange | null>(null);
   /** The tree row the keyboard is on; null: the open file's row. */
   const [cursor, setCursor] = useState<string | null>(null);
   const [openDirs, setOpenDirs] = useState<Set<string>>(() => new Set(saved.open ?? []));
   /** A file whose folders open once the list is known (a target from outside the tree). */
   const [reveal, setReveal] = useState<string | null>(target?.path ?? null);
   const [showTree, setShowTree] = useState(saved.tree ?? true);
   const [query, setQuery] = useState("");
   /** The open file: `req` the path asked for, `path` the one found (a partial path finds the whole one). */
   const [file, setFile] = useState<{ req: string; path: string; lines: string[] } | null>(null);
   const [fileError, setFileError] = useState<string | null>(null);
   const [workspace, setWorkspace] = useState<WorkspaceInfo | null | undefined>(undefined);
   /** Bumped by Refresh and by a git status change: the list and the open file load again. */
   const [tick, setTick] = useState(0);
   const git = useGitStatus(api, !!workspace?.repo_root, tick);
   const comments = useFileComments(sessionId);
   const wrap = useWrapCode();
   const sidebar = useResizableWidth({
      storageKey: "harness:files-tree-width",
      initial: 220,
      min: 160,
      max: 480,
      edge: "left",
   });

   useEffect(() => {
      let off = false;
      api.workspace()
         .then((w) => !off && setWorkspace(w))
         .catch(() => !off && setWorkspace(null));
      return () => {
         off = true;
      };
   }, [api]);

   useEffect(() => {
      if (git.changes) setTick((t) => t + 1);
   }, [git.changes]);

   // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` only triggers a reload.
   useEffect(() => {
      let off = false;
      api.listSessionFiles().then(
         (l) => {
            if (off) return;
            setFiles(l.files);
            setPrefix(l.prefix);
            setListError(null);
         },
         (e) => !off && setListError(errorMessage(e)),
      );
      return () => {
         off = true;
      };
   }, [api, tick]);

   // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` only triggers a reload.
   useEffect(() => {
      if (!selected) return;
      let off = false;
      setFileError(null);
      api.readSessionFile(selected).then(
         (r) => !off && setFile({ req: selected, path: r.path, lines: r.lines }),
         (e) => {
            if (off) return;
            setFile(null);
            setFileError(readError(selected, e));
         },
      );
      return () => {
         off = true;
      };
   }, [api, selected, tick]);

   useEffect(() => {
      if (!target) return;
      setSelected(target.path);
      setCursor(null);
      setReveal(target.path);
      setRange(target.start ? { start: target.start, end: target.end ?? target.start } : null);
      onTargetShown?.();
   }, [target, onTargetShown]);

   useEffect(
      () =>
         writeSaved(sessionId, {
            path: selected ?? undefined,
            open: [...openDirs],
            tree: showTree,
         }),
      [sessionId, selected, openDirs, showTree],
   );

   useEffect(() => {
      if (!popout) return;
      document.title = selected ? `Files: ${selected}` : "Files";
      // A reload keeps the open file.
      history.replaceState(null, "", filesWindowUrl(sessionId, selected, range?.start));
   }, [popout, sessionId, selected, range]);

   const q = query.trim().toLowerCase();
   const shown: Change[] = useMemo(
      () =>
         (files ?? [])
            .filter((p) => !q || p.toLowerCase().includes(q))
            .map((path) => ({ path, additions: 0, deletions: 0 })),
      [files, q],
   );
   /** Every folder key of the tree (folders are closed unless opened). */
   const allDirs = useMemo(
      () =>
         new Set(
            fileTree(shown, NO_FOLDERS).rows.flatMap((r) => (r.kind === "dir" ? [r.key] : [])),
         ),
      [shown],
   );
   // While filtering, every match shows.
   const closed = useMemo(
      () => (q ? NO_FOLDERS : new Set([...allDirs].filter((k) => !openDirs.has(k)))),
      [q, allDirs, openDirs],
   );
   const rows = useMemo(() => fileTree(shown, closed).rows.map((r) => navRow(r)), [shown, closed]);

   useEffect(() => {
      if (!reveal || !files) return;
      const hidden = ancestorKeys(allDirs, reveal).filter((k) => !openDirs.has(k));
      if (hidden.length) setOpenDirs((o) => new Set([...o, ...hidden]));
      setReveal(null);
   }, [reveal, files, allDirs, openDirs]);

   const status = useMemo(
      () => folderStatus(git.status?.files ?? [], prefix),
      [git.status, prefix],
   );
   const commentsOn = (p: string) => comments.filter((c) => c.path === p).length;

   const select = (path: string) => {
      setSelected(path);
      setRange(null);
      setCursor(null);
   };
   const setOpen = (dir: string, open: boolean) => {
      setOpenDirs((o) => {
         const n = new Set(o);
         if (open) n.add(dir);
         else n.delete(dir);
         return n;
      });
      // Collapsing the folder of the open file moves the cursor onto the folder.
      if (!open && selected?.startsWith(`${dir}/`)) setCursor(dirRowKey(dir));
   };
   const selectedKey = selected ? fileRowKey(selected) : null;
   const activeKey = cursor && rows.some((r) => r.key === cursor) ? cursor : selectedKey;

   const shownPath = file?.path ?? selected;
   const slash = shownPath?.lastIndexOf("/") ?? -1;
   const title = shownPath ? (
      <span className="font-mono text-xs font-normal" title={shownPath}>
         {slash > 0 && (
            <span className="text-muted-foreground">
               {shownPath.slice(0, slash).split("/").join(" / ")} /{" "}
            </span>
         )}
         <span className="font-medium">{shownPath.slice(slash + 1)}</span>
      </span>
   ) : (
      "Files"
   );

   const iconButton = (
      label: string,
      icon: React.ReactNode,
      onClick: () => void,
      opts: { pressed?: boolean; disabled?: boolean } = {},
   ) => (
      <Tooltip content={label} side="bottom">
         <Button
            size="icon"
            variant={opts.pressed ? "secondary" : "ghost"}
            className="size-7"
            aria-label={label}
            aria-pressed={opts.pressed}
            disabled={opts.disabled}
            onClick={onClick}
         >
            {icon}
         </Button>
      </Tooltip>
   );

   return (
      <div className="flex h-full min-h-0 flex-1 flex-col">
         <PanelHeader title={title} titleHint={shownPath ?? undefined}>
            {shownPath && <GitLetter status={status.get(shownPath)} />}
            <div className="flex-1" />
            <WrapButton />
            {iconButton("Show file tree", <ListTree />, () => setShowTree(!showTree), {
               pressed: showTree,
            })}
            {iconButton(
               "Open in editor",
               <ExternalLink />,
               () => void api.openInEditor(shownPath ?? undefined, range?.start).catch(() => {}),
               { disabled: !shownPath },
            )}
            {iconButton("Refresh", <RefreshCw />, () => setTick((t) => t + 1))}
            {!popout &&
               iconButton(
                  "Open in window",
                  <Maximize2 />,
                  () =>
                     void openWindow(
                        `files-${sessionId}`,
                        filesWindowUrl(sessionId, shownPath, range?.start),
                        { title: shownPath ? `Files: ${shownPath}` : "Files" },
                     ),
               )}
         </PanelHeader>
         <div className="flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col">
               {!selected ? (
                  <p className="p-4 text-sm text-muted-foreground">Select a file in the list.</p>
               ) : fileError ? (
                  <p role="alert" className="p-4 text-sm text-destructive">
                     Can't show this file: {fileError}
                  </p>
               ) : !file || file.req !== selected ? (
                  <p className="p-4 text-xs text-muted-foreground">Loading...</p>
               ) : file.lines.length === 0 ? (
                  <p className="p-4 text-sm text-muted-foreground">The file is empty.</p>
               ) : (
                  <FileView
                     key={file.path}
                     sessionId={sessionId}
                     path={file.path}
                     lines={file.lines}
                     comments={comments}
                     target={range}
                     wrap={wrap}
                     mode="comment"
                  />
               )}
            </div>
            {showTree && (
               <div
                  className="relative flex shrink-0 flex-col border-l"
                  style={{ width: sidebar.width }}
               >
                  <ResizeHandle label="Resize file tree" {...sidebar.handle} />
                  <div className="p-1.5">
                     <Input
                        value={query}
                        placeholder="Filter files"
                        aria-label="Filter files"
                        className="h-7 text-xs"
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={(e) =>
                           e.key === "Escape" && query && (e.stopPropagation(), setQuery(""))
                        }
                     />
                  </div>
                  <FileTreeList<Change>
                     rows={rows}
                     activeKey={activeKey}
                     label="Files"
                     idPrefix={popout ? "files-window-row" : "files-row"}
                     placeholder={
                        listError ? (
                           <li role="alert" className="p-3 text-xs text-destructive">
                              {listError}
                           </li>
                        ) : !files ? (
                           <li className="p-3 text-xs text-muted-foreground">Loading...</li>
                        ) : rows.length === 0 ? (
                           <li className="p-3 text-xs text-muted-foreground">
                              {q ? "No matching files." : "No files."}
                           </li>
                        ) : undefined
                     }
                     onSelect={(key) => {
                        setCursor(key);
                        if (key.startsWith("f:")) {
                           setSelected(key.slice(2));
                           setRange(null);
                        }
                     }}
                     onOpenFile={(r) => select(r.file.path)}
                     onSetOpen={setOpen}
                     renderFile={(r) => (
                        <>
                           <File className="size-4 shrink-0 text-muted-foreground" />
                           <span className="min-w-0 flex-1 truncate">{r.name}</span>
                           <CommentCount n={commentsOn(r.file.path)} />
                           <GitLetter status={status.get(r.file.path)} />
                        </>
                     )}
                  />
               </div>
            )}
         </div>
      </div>
   );
}
