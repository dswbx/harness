import {
   errText,
   inTauri,
   onSessionForgotten,
   openWindow,
   rememberWindowFrame,
   type SessionApi,
   type Stored,
   storedNumber,
   storedValue,
   useGitStatus,
   type WorkspaceInfo,
} from "@harness/api";
import {
   Button,
   cn,
   DropdownMenuItem,
   Input,
   ResizeHandle,
   ScrollArea,
   Tooltip,
   useResizableWidth,
} from "@harness/ui";
import {
   Check,
   Code,
   ExternalLink,
   Eye,
   File,
   ListTree,
   Maximize2,
   RefreshCw,
   WrapText,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { PanelHeader } from "../../panels/PanelHeader";
import { CommentCount } from "../changes/DiffViewer";
import { dirRowKey, FileTreeList, fileRowKey, navRow } from "../fileTree/FileTreeList";
import { ancestorKeys, fileTree, folderStatus } from "../fileTree/fileTree";
import { setWrapCode, useWrapCode } from "../markdown/CodeBlock";
import { Markdown } from "../markdown/Markdown";
import { activeCommentsOn, fileViewComments } from "../review/reviewComments";
import { useLineComments } from "../review/useLineComments";
import { FileTabStrip } from "./FileTabStrip";
import { FileView, type LineRange } from "./FileView";
import {
   closeTab,
   type FileTab,
   isMarkdown,
   moveTab,
   openTab,
   parseTabs,
   patchTab,
} from "./fileTabs";

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

/** What the panel remembers per Session (per viewer): the open tabs and file, the open folders, the tree's visibility. */
type Saved = { path?: string; tabs?: FileTab[]; open?: string[]; tree?: boolean };
const treeWidth = storedNumber("harness:files-tree-width");
const savedStores = new Map<string, Stored<Saved>>();
onSessionForgotten((id) => void savedStores.delete(id));
const savedStore = (sessionId: string) => {
   let s = savedStores.get(sessionId);
   if (!s) {
      s = storedValue<Saved>({
         key: `harness.files.${sessionId}`,
         scope: { session: sessionId },
         parse: (raw) => {
            const v: unknown = JSON.parse(raw ?? "null");
            return v && typeof v === "object" ? (v as Saved) : {};
         },
         sync: false,
      });
      savedStores.set(sessionId, s);
   }
   return s;
};
const readSaved = (sessionId: string): Saved => savedStore(sessionId).get();
const writeSaved = (sessionId: string, s: Saved) => void savedStore(sessionId).set(s);

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
         aria-label={g.label}
      >
         {status === "?" ? "U" : status}
      </span>
   );
}

/** The read error in plain words. */
function readError(path: string, e: unknown) {
   const m = errText(e);
   return /not found|no such file|os error 2/i.test(m) ? `${path} does not exist.` : m;
}

const NO_FOLDERS: ReadonlySet<string> = new Set();
/** While the window is visible, the open file is read again this often, so outside edits show. */
const FILE_POLL_MS = 3_000;

const sameLines = (a: string[], b: string[]) =>
   a.length === b.length && a.every((l, i) => l === b[i]);

/** An icon button with a tooltip, for the header. */
function HeaderButton({
   label,
   onClick,
   disabled,
   pressed,
   children,
}: {
   label: string;
   onClick: () => void;
   disabled?: boolean;
   pressed?: boolean;
   children: ReactNode;
}) {
   return (
      <Tooltip content={label} side="bottom">
         <Button
            size="icon"
            variant={pressed ? "secondary" : "ghost"}
            className="size-7 shrink-0"
            aria-label={label}
            aria-pressed={pressed}
            disabled={disabled}
            onClick={onClick}
         >
            {children}
         </Button>
      </Tooltip>
   );
}
type Change = { path: string; additions: number; deletions: number };

/**
 * The Session folder's files: a tree (right, toggleable, with a name filter) and the open file (left) with line
 * comments that go to the prompt box. `target`: show that file and mark its lines. `popout`: the panel fills its
 * own window (no pop-out button).
 */
export function FilesPanel({
   api,
   target,
   popout = false,
}: {
   api: SessionApi;
   target?: FileTarget | null;
   popout?: boolean;
}) {
   const sessionId = api.sessionId;
   const [saved] = useState(() => readSaved(sessionId));
   const [files, setFiles] = useState<string[] | null>(null);
   /** The folder's path in its repository: git status paths start with it, `files` do not. */
   const [prefix, setPrefix] = useState("");
   const [listError, setListError] = useState<string | null>(null);
   const [selected, setSelected] = useState<string | null>(target?.path ?? saved.path ?? null);
   const [tabs, setTabs] = useState<FileTab[]>(() => {
      const t = parseTabs(saved.tabs);
      const first = target?.path ?? saved.path;
      return first ? openTab(t, first) : t;
   });
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
   /** Bumped by the poll: only the open file loads again. */
   const [fileTick, setFileTick] = useState(0);
   const git = useGitStatus(api, { enabled: !!workspace?.repo_root, refreshKey: tick });
   const allComments = useLineComments(api);
   const comments = useMemo(() => fileViewComments(allComments), [allComments]);
   const wrap = useWrapCode();
   const sidebar = useResizableWidth({
      store: treeWidth,
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

   // Outside edits (an editor, a terminal): back to the window loads all again, and while visible the open file
   // is read again every few seconds.
   useEffect(() => {
      const back = () => !document.hidden && setTick((t) => t + 1);
      const poll = setInterval(() => !document.hidden && setFileTick((t) => t + 1), FILE_POLL_MS);
      window.addEventListener("focus", back);
      document.addEventListener("visibilitychange", back);
      return () => {
         clearInterval(poll);
         window.removeEventListener("focus", back);
         document.removeEventListener("visibilitychange", back);
      };
   }, []);

   useEffect(() => (popout ? rememberWindowFrame("files") : undefined), [popout]);

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
         (e) => !off && setListError(errText(e)),
      );
      return () => {
         off = true;
      };
   }, [api, tick]);

   // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` and `fileTick` only trigger a reload.
   useEffect(() => {
      if (!selected) return;
      let off = false;
      api.readSessionFile(selected).then(
         (r) => {
            if (off) return;
            setFileError(null);
            // The same text keeps the same object: a poll that found no change renders nothing.
            setFile((f) =>
               f && f.req === selected && f.path === r.path && sameLines(f.lines, r.lines)
                  ? f
                  : { req: selected, path: r.path, lines: r.lines },
            );
         },
         (e) => {
            if (off) return;
            setFile(null);
            setFileError(readError(selected, e));
         },
      );
      return () => {
         off = true;
      };
   }, [api, selected, tick, fileTick]);

   useEffect(() => {
      if (!target) return;
      setTabs((t) => openTab(t, target.path));
      setSelected(target.path);
      setCursor(null);
      setReveal(target.path);
      setRange(target.start ? { start: target.start, end: target.end ?? target.start } : null);
   }, [target]);

   useEffect(
      () =>
         writeSaved(sessionId, {
            path: selected ?? undefined,
            tabs,
            open: [...openDirs],
            tree: showTree,
         }),
      [sessionId, selected, tabs, openDirs, showTree],
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
   const commentsOn = (p: string) => activeCommentsOn(comments, p);

   /** Shows `path`: in the preview tab, or a tab of its own when `pin`. */
   const select = (path: string, pin = false) => {
      setTabs((t) => openTab(t, path, pin));
      setSelected(path);
      setRange(null);
      setCursor(null);
   };
   const close = (path: string) => {
      const next = closeTab(tabs, path, selected);
      setTabs(next.tabs);
      if (next.active !== selected) {
         setSelected(next.active);
         setRange(null);
         setCursor(null);
      }
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
   // The last loaded file stays until the next one loads (no "Loading" flash between files).
   const view = selected ? file : null;
   const tab = tabs.find((t) => t.path === view?.req);
   const markdown = !!view && isMarkdown(view.req);
   const rendered = markdown && !tab?.source;
   const setSource = (source: boolean) =>
      view && setTabs((t) => patchTab(t, view.req, { source: source || undefined }));

   const openInEditor = () =>
      void api.openInEditor(shownPath ?? undefined, range?.start).catch(() => {});
   const openPopout = () =>
      void openWindow(`files-${sessionId}`, filesWindowUrl(sessionId, shownPath, range?.start), {
         title: shownPath ? `Files: ${shownPath}` : "Files",
         remember: "files",
         overlayTitleBar: true,
      });
   const tabStrip = (
      <FileTabStrip
         tabs={tabs}
         active={selected}
         dragRegion={popout}
         onShow={(path) => {
            setSelected(path);
            setRange(null);
            setCursor(null);
         }}
         onPin={(path) => select(path, true)}
         onClose={close}
         onMove={(path, to) => setTabs((t) => moveTab(t, path, to))}
      />
   );
   const refreshButton = (
      <HeaderButton label="Refresh" onClick={() => setTick((t) => t + 1)}>
         <RefreshCw />
      </HeaderButton>
   );
   const editorButton = (
      <HeaderButton label="Open in editor" disabled={!shownPath} onClick={openInEditor}>
         <ExternalLink />
      </HeaderButton>
   );
   const treeButton = (
      <HeaderButton
         label="Show file tree"
         pressed={showTree}
         onClick={() => setShowTree(!showTree)}
      >
         <ListTree />
      </HeaderButton>
   );

   return (
      <div className="flex h-full min-h-0 flex-1 flex-col">
         {popout ? (
            <div
               data-tauri-drag-region
               className={cn(
                  "flex h-13 shrink-0 items-center gap-1 border-b pr-2",
                  // Room for the traffic lights (overlay title bar).
                  inTauri() ? "pl-[92px]" : "pl-2",
               )}
            >
               {tabStrip}
               <HeaderButton label="Wrap lines" pressed={wrap} onClick={() => setWrapCode(!wrap)}>
                  <WrapText />
               </HeaderButton>
               {refreshButton}
               {editorButton}
               {treeButton}
            </div>
         ) : (
            <PanelHeader
               className="gap-1"
               menu={
                  <>
                     <DropdownMenuItem onSelect={() => setWrapCode(!wrap)}>
                        <WrapText /> Wrap lines
                        {wrap && <Check className="ml-auto" />}
                     </DropdownMenuItem>
                     <DropdownMenuItem disabled={!shownPath} onSelect={openInEditor}>
                        <ExternalLink /> Open in editor
                     </DropdownMenuItem>
                  </>
               }
            >
               {tabStrip}
               {refreshButton}
               <HeaderButton label="Open in window" onClick={openPopout}>
                  <Maximize2 />
               </HeaderButton>
               {treeButton}
            </PanelHeader>
         )}
         <div className="flex min-h-0 flex-1">
            <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
               {markdown && !fileError && view.lines.length > 0 && (
                  <div
                     role="group"
                     aria-label="View"
                     className="absolute top-2 right-3 z-10 flex gap-0.5 rounded-md border bg-background p-0.5 shadow-xs"
                  >
                     {(
                        [
                           [false, "Preview", Eye],
                           [true, "Source", Code],
                        ] as const
                     ).map(([source, label, Icon]) => (
                        <button
                           key={label}
                           type="button"
                           aria-label={label}
                           aria-pressed={!!tab?.source === source}
                           className={cn(
                              "grid h-[22px] w-6 place-items-center rounded-[5px]",
                              !!tab?.source === source
                                 ? "bg-accent text-accent-foreground"
                                 : "text-muted-foreground hover:text-foreground",
                           )}
                           onClick={() => setSource(source)}
                        >
                           <Icon className="size-3.5" />
                        </button>
                     ))}
                  </div>
               )}
               {!selected ? (
                  <p className="p-4 text-sm text-muted-foreground">Select a file in the list.</p>
               ) : fileError ? (
                  <p role="alert" className="p-4 text-sm text-destructive">
                     Can't show this file: {fileError}
                  </p>
               ) : !view ? null : view.lines.length === 0 ? (
                  <p className="p-4 text-sm text-muted-foreground">The file is empty.</p>
               ) : rendered ? (
                  <ScrollArea className="min-h-0 flex-1">
                     <Markdown html className="px-6 py-5">
                        {view.lines.join("\n")}
                     </Markdown>
                  </ScrollArea>
               ) : (
                  <FileView
                     key={view.path}
                     api={api}
                     path={view.path}
                     lines={view.lines}
                     comments={comments}
                     target={range}
                     wrap={wrap}
                     mode="comment"
                  />
               )}
            </div>
            {showTree && (
               <div
                  className="relative flex shrink-0 flex-col border-l bg-background"
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
                           const path = key.slice(2);
                           setTabs((t) => openTab(t, path));
                           setSelected(path);
                           setRange(null);
                        }
                     }}
                     onOpenFile={(r) => select(r.file.path)}
                     onPinFile={(r) => select(r.file.path, true)}
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
