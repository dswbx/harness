import type { Diff, SessionApi } from "@harness/api";
import { Button, cn, ResizeHandle, Tooltip, useResizableWidth } from "@harness/ui";
import {
   ArrowDown,
   ArrowLeft,
   ArrowRight,
   ArrowUp,
   Columns2,
   FileMinus,
   FilePen,
   FilePlus,
   List,
   ListTree,
   Rows2,
   WrapText,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CommitInfo, CommitsPane, useCommits } from "./CommitsPane";
import { CommentCount, DiffViewer, type FileContents } from "./DiffViewer";
import { type FilePatch, splitPatch } from "./diff";
import { errorMessage } from "./errors";
import { FileTreeList, fileRowKey, type NavRow, navRow } from "./FileTreeList";
import { ancestorKeys, fileTree } from "./fileTree";
import { useDiffComments } from "./reviewComments";
import { type DiffScope, selectionScope } from "./scope";

/** URL of the pop-out diff window. Boots through the app entry like any solo View window. */
export function diffWindowUrl(sessionId: string, scope: DiffScope) {
   const q = new URLSearchParams({
      session: sessionId,
      solo: "1",
      pane: "diff",
      label: scope.label,
   });
   if (scope.from) q.set("from", scope.from);
   if (scope.to) q.set("to", scope.to);
   if (scope.sel) q.set("sel", scope.sel.join(","));
   return `/?${q}`;
}

/** The diff window's scope, or null when this window is a normal View. */
export function diffWindowScope(search: string): DiffScope | null {
   const q = new URLSearchParams(search);
   if (q.get("pane") !== "diff") return null;
   const sel = q.get("sel");
   return {
      from: q.get("from"),
      to: q.get("to"),
      label: q.get("label") ?? "Changes",
      ...(sel && { sel: sel.split(",") }),
   };
}

const STATUS = {
   A: { Icon: FilePlus, className: "text-emerald-600", label: "added" },
   D: { Icon: FileMinus, className: "text-red-600", label: "deleted" },
   M: { Icon: FilePen, className: "text-sky-600", label: "modified" },
} as const;

/** git-diff-view marks changed lines only by their line-number color, or an empty side (split mode). */
const CHANGED =
   'td[style*="-add-lineNumber--"], td[style*="-del-lineNumber--"], td.diff-line-old-placeholder, td.diff-line-new-placeholder';

/** First row of each change block (a run of changed rows) in the rendered diff; the first table only in split mode. */
function changeRows(root: HTMLElement | null): HTMLElement[] {
   const table = root?.querySelector("table");
   if (!table) return [];
   const rows = [...table.querySelectorAll<HTMLElement>("tr.diff-line")].filter(
      (r) => !r.matches(".diff-line-extend, .diff-line-widget"),
   );
   const changed = rows.map((r) => !!r.querySelector(CHANGED));
   return rows.filter((_, i) => changed[i] && !changed[i - 1]);
}

const fileKey = (f: FilePatch) => fileRowKey(f.path);

const VIEW_KEY = "harness:diff-file-view";
const WRAP_KEY = "harness:diff-wrap";
type FileView = "list" | "tree";
const readView = (): FileView => {
   try {
      return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "tree";
   } catch {
      return "tree";
   }
};

/** JetBrains-like diff viewer: files (list or tree) and commits left, one file's diff right, keyboard navigation through files and changes. */
export function DiffWindow({ api, scope: initialScope }: { api: SessionApi; scope: DiffScope }) {
   const [scope, setScope] = useState(initialScope);
   const [diff, setDiff] = useState<Diff | null>(null);
   const [error, setError] = useState<string | null>(null);
   /** Selected row key; null = the first file. */
   const [cursor, setCursor] = useState<string | null>(null);
   const [mode, setMode] = useState<"split" | "unified">("split");
   const [view, setView] = useState<FileView>(readView);
   const [wrap, setWrap] = useState(() => {
      try {
         return localStorage.getItem(WRAP_KEY) === "1";
      } catch {
         return false;
      }
   });
   const [closed, setClosed] = useState<Set<string>>(new Set());
   const [contents, setContents] = useState<Map<string, FileContents>>(new Map());
   const comments = useDiffComments(api.sessionId);
   const commits = useCommits(api);
   const sidebar = useResizableWidth({
      storageKey: "harness:diff-sidebar-width",
      initial: 320,
      min: 200,
      max: 640,
      edge: "right",
   });
   const pane = useRef<HTMLDivElement>(null);
   const change = useRef(-1);
   /** After a file switch from "next/previous change", jump to its first or last change once rendered. */
   const pendingJump = useRef<"first" | "last" | null>(null);

   useEffect(() => {
      let off = false;
      document.title = `Diff: ${scope.label}`;
      // A reload keeps the current selection.
      history.replaceState(null, "", diffWindowUrl(api.sessionId, scope));
      setDiff(null);
      setError(null);
      setCursor(null);
      setContents(new Map());
      change.current = -1;
      api.gitDiff(scope.from, scope.to).then(
         (d) => !off && setDiff(d),
         (e) => !off && setError(errorMessage(e)),
      );
      return () => {
         off = true;
      };
   }, [api, scope]);

   const files = useMemo(() => (diff ? splitPatch(diff.patch) : []), [diff]);
   const tree = useMemo(() => fileTree(files, closed), [files, closed]);
   /** Files in display order, for next/previous file. */
   const order = view === "tree" ? tree.order : files;
   const orderIndex = useMemo(() => new Map(order.map((f, i) => [f.path, i])), [order]);
   const rows: NavRow<FilePatch>[] = useMemo(
      () =>
         view === "tree"
            ? tree.rows.map((r) => navRow(r))
            : files.map((f) => ({
                 key: fileKey(f),
                 kind: "file" as const,
                 depth: 0,
                 file: f,
                 name: f.path,
              })),
      [view, tree, files],
   );
   // A folder shows its first changed file.
   const file: FilePatch | undefined = cursor?.startsWith("d:")
      ? (order.find((f) => f.path.startsWith(cursor.slice(2) + "/")) ?? order[0])
      : (order.find((f) => fileKey(f) === cursor) ?? order[0]);
   const idx = file ? orderIndex.get(file.path)! : -1;
   const activeKey =
      cursor && rows.some((r) => r.key === cursor) ? cursor : file ? fileKey(file) : null;

   // Full contents let git-diff-view expand the collapsed unchanged regions.
   useEffect(() => {
      if (!diff || !file || contents.has(file.path)) return;
      let off = false;
      const read = (rev: string, path: string | null) =>
         path ? api.gitShowFile(rev, path) : Promise.resolve("");
      Promise.all([read(diff.from, file.oldPath), read(diff.to, file.newPath)]).then(
         ([o, n]) => !off && setContents((m) => new Map(m).set(file.path, { old: o, new: n })),
         () => {}, // Without contents the diff still renders; only expanding is off.
      );
      return () => {
         off = true;
      };
   }, [api, diff, file, contents]);

   /** Selects a file by its place in `order`, opening its folders. */
   const goFile = useCallback(
      (i: number, jump: "first" | "last" | null = null) => {
         const f = order[i];
         if (!f) return;
         change.current = -1;
         pendingJump.current = jump;
         setClosed((c) => {
            const hidden = ancestorKeys(c, f.path);
            return hidden.length ? new Set([...c].filter((k) => !hidden.includes(k))) : c;
         });
         setCursor(fileKey(f));
      },
      [order],
   );

   const setOpen = (dir: string, open: boolean) => {
      setClosed((c) => {
         const n = new Set(c);
         if (open) n.delete(dir);
         else n.add(dir);
         return n;
      });
      // Collapsing the folder of the selected file moves the selection onto the folder.
      if (!open && file?.path.startsWith(dir + "/")) setCursor(`d:${dir}`);
   };

   const scrollTo = (rows: HTMLElement[], i: number) => {
      change.current = i;
      rows[i]?.scrollIntoView({ block: "center" });
      for (const r of rows) r.classList.remove("harness-diff-current");
      rows[i]?.classList.add("harness-diff-current");
   };

   const goChange = useCallback(
      (dir: 1 | -1) => {
         const rows = changeRows(pane.current);
         const next = change.current + dir;
         if (next >= 0 && next < rows.length) scrollTo(rows, next);
         else goFile(idx + dir, dir === 1 ? "first" : "last");
      },
      [goFile, idx],
   );

   // A pending jump waits for the new file's rows: git-diff-view renders them a few frames after the switch.
   useEffect(() => {
      const jump = pendingJump.current;
      pendingJump.current = null;
      if (!jump) return;
      let tries = 0;
      let raf = 0;
      const tick = () => {
         const rows = changeRows(pane.current);
         if (rows.length) scrollTo(rows, jump === "first" ? 0 : rows.length - 1);
         else if (tries++ < 60) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(raf);
   }, [file?.path]);

   useEffect(() => {
      change.current = -1;
   }, [mode]);

   useEffect(() => {
      pane.current?.scrollTo({ top: 0 });
   }, [file?.path]);

   // Alt+↑/↓: changes, Alt+←/→: files (like F7 / Ctrl+Alt+arrows in JetBrains). Plain arrows stay for scrolling and text.
   useEffect(() => {
      const onKey = (e: KeyboardEvent) => {
         if (!e.altKey || e.metaKey || e.ctrlKey) return;
         const k = {
            ArrowDown: () => goChange(1),
            ArrowUp: () => goChange(-1),
            ArrowRight: () => goFile(idx + 1),
            ArrowLeft: () => goFile(idx - 1),
         }[e.key];
         if (!k) return;
         e.preventDefault();
         k();
      };
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
   }, [goChange, goFile, idx]);

   const toggleWrap = () => {
      setWrap(!wrap);
      try {
         localStorage.setItem(WRAP_KEY, wrap ? "0" : "1");
      } catch {
         /* per-viewer convenience only */
      }
   };
   const selectedCommits = commits.filter((c) => scope.sel?.includes(c.sha));

   const changeView = (v: FileView) => {
      setView(v);
      try {
         localStorage.setItem(VIEW_KEY, v);
      } catch {
         /* per-viewer convenience only */
      }
   };

   const pathComments = (p: string) => comments.filter((c) => c.path === p).length;
   const sum = (k: "additions" | "deletions") => files.reduce((s, f) => s + f[k], 0);
   return (
      <div className="flex h-full flex-col">
         <div className="flex items-center gap-1 border-b px-2 py-1.5 text-xs">
            <Tooltip content="Previous change" shortcut={["⌥", "↑"]} side="bottom">
               <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  aria-label="Previous change"
                  onClick={() => goChange(-1)}
               >
                  <ArrowUp />
               </Button>
            </Tooltip>
            <Tooltip content="Next change" shortcut={["⌥", "↓"]} side="bottom">
               <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  aria-label="Next change"
                  onClick={() => goChange(1)}
               >
                  <ArrowDown />
               </Button>
            </Tooltip>
            <div className="mx-1 h-4 w-px bg-border" />
            <Tooltip content="Previous file" shortcut={["⌥", "←"]} side="bottom">
               <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  aria-label="Previous file"
                  disabled={idx <= 0}
                  onClick={() => goFile(idx - 1)}
               >
                  <ArrowLeft />
               </Button>
            </Tooltip>
            <span className="tabular-nums text-muted-foreground">
               {idx + 1}/{order.length} files
            </span>
            <Tooltip content="Next file" shortcut={["⌥", "→"]} side="bottom">
               <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  aria-label="Next file"
                  disabled={idx >= order.length - 1}
                  onClick={() => goFile(idx + 1)}
               >
                  <ArrowRight />
               </Button>
            </Tooltip>
            <Tooltip
               side="bottom"
               align="start"
               className="max-h-[70vh] max-w-[28rem] overflow-auto"
               content={
                  selectedCommits.length ? (
                     <div className="space-y-3 divide-y">
                        {selectedCommits.map((c) => (
                           <div key={c.sha} className="pt-3 first:pt-0">
                              <CommitInfo commit={c} />
                           </div>
                        ))}
                     </div>
                  ) : null
               }
            >
               <span className="ml-2 max-w-64 shrink-0 truncate rounded-full bg-muted px-2 py-0.5">
                  {scope.label}
               </span>
            </Tooltip>
            <span className="ml-2 min-w-0 flex-1 truncate font-mono text-muted-foreground">
               {file?.path}
            </span>
            {file && (
               <span className="flex gap-1.5 font-mono tabular-nums">
                  <span className="text-emerald-500">+{file.additions}</span>
                  <span className="text-red-500">−{file.deletions}</span>
               </span>
            )}
            <Tooltip content="Soft wrap" side="bottom">
               <Button
                  size="icon"
                  variant={wrap ? "secondary" : "ghost"}
                  className="ml-2 size-7"
                  aria-label="Soft wrap"
                  aria-pressed={wrap}
                  onClick={toggleWrap}
               >
                  <WrapText />
               </Button>
            </Tooltip>
            <div className="ml-2 flex rounded-md border">
               <Tooltip content="Side by side" side="bottom">
                  <Button
                     size="icon"
                     variant={mode === "split" ? "secondary" : "ghost"}
                     className="size-7 rounded-r-none"
                     aria-label="Side by side"
                     aria-pressed={mode === "split"}
                     onClick={() => setMode("split")}
                  >
                     <Columns2 />
                  </Button>
               </Tooltip>
               <Tooltip content="Unified" side="bottom">
                  <Button
                     size="icon"
                     variant={mode === "unified" ? "secondary" : "ghost"}
                     className="size-7 rounded-l-none"
                     aria-label="Unified"
                     aria-pressed={mode === "unified"}
                     onClick={() => setMode("unified")}
                  >
                     <Rows2 />
                  </Button>
               </Tooltip>
            </div>
         </div>
         <div className="flex min-h-0 flex-1">
            <div
               className="relative flex shrink-0 flex-col border-r"
               style={{ width: sidebar.width }}
            >
               <ResizeHandle label="Resize file list" {...sidebar.handle} />
               <div className="flex items-center gap-1.5 py-1 pr-1.5 pl-3 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground/80">Changed files</span>
                  <span>{files.length}</span>
                  <span className="font-mono text-emerald-500">+{sum("additions")}</span>
                  <span className="font-mono text-red-500">−{sum("deletions")}</span>
                  <div
                     className="ml-auto flex rounded-md border"
                     role="group"
                     aria-label="File view"
                  >
                     <Tooltip content="List" side="bottom">
                        <Button
                           size="icon"
                           variant={view === "list" ? "secondary" : "ghost"}
                           className="size-6 rounded-r-none"
                           aria-label="List"
                           aria-pressed={view === "list"}
                           onClick={() => changeView("list")}
                        >
                           <List />
                        </Button>
                     </Tooltip>
                     <Tooltip content="Tree" side="bottom">
                        <Button
                           size="icon"
                           variant={view === "tree" ? "secondary" : "ghost"}
                           className="size-6 rounded-l-none"
                           aria-label="Tree"
                           aria-pressed={view === "tree"}
                           onClick={() => changeView("tree")}
                        >
                           <ListTree />
                        </Button>
                     </Tooltip>
                  </div>
               </div>
               <FileTreeList<FilePatch>
                  rows={rows}
                  activeKey={activeKey}
                  label="Changed files"
                  idPrefix="diff-row"
                  flat={view === "list"}
                  placeholder={
                     error ? (
                        <li role="alert" className="p-3 text-xs text-destructive">
                           {error}
                        </li>
                     ) : !diff ? (
                        <li className="p-3 text-xs text-muted-foreground">Loading...</li>
                     ) : undefined
                  }
                  onSelect={setCursor}
                  onOpenFile={(r) => goFile(orderIndex.get(r.file.path)!)}
                  onSetOpen={setOpen}
                  fileTitle={(r) => `${r.file.path} (${STATUS[r.file.status].label})`}
                  renderFile={({ file: f }) => {
                     const s = STATUS[f.status];
                     const slash = f.path.lastIndexOf("/");
                     return (
                        <>
                           <s.Icon
                              className={cn("size-4 shrink-0", s.className)}
                              aria-label={s.label}
                           />
                           <span className="truncate">{f.path.slice(slash + 1)}</span>
                           <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                              {view === "list" && slash > 0 ? f.path.slice(0, slash) : ""}
                           </span>
                           <CommentCount n={pathComments(f.path)} />
                        </>
                     );
                  }}
               />
               <CommitsPane
                  commits={commits}
                  sel={scope.sel}
                  defaultHeight={250}
                  onSelect={(sel) => setScope(selectionScope(sel, commits))}
               />
            </div>
            <div ref={pane} className="min-w-0 flex-1 overflow-auto">
               {file ? (
                  <DiffViewer
                     key={file.path}
                     sessionId={api.sessionId}
                     file={file}
                     comments={comments}
                     mode={mode}
                     wrap={wrap}
                     resizable
                     contents={contents.get(file.path)}
                  />
               ) : (
                  diff && <p className="p-4 text-sm text-muted-foreground">No changes.</p>
               )}
            </div>
         </div>
      </div>
   );
}
