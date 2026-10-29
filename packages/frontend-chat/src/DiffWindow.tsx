import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronRight, Columns2, FileMinus, FilePen, FilePlus, Folder, List, ListTree, MessageSquare, Rows2 } from "lucide-react";
import type { Diff, SessionApi } from "@harness/api";
import { Button, cn } from "@harness/ui";
import { CommitsPane, useCommits } from "./CommitsPane";
import { changeCount, splitPatch, type FilePatch } from "./diff";
import { DiffViewer, type FileContents } from "./DiffViewer";
import { ancestorKeys, fileTree, type TreeRow } from "./fileTree";
import { useReviewComments } from "./reviewComments";
import { errorMessage } from "./errors";
import { selectionScope, type DiffScope } from "./scope";

/** URL of the pop-out diff window. Boots through the app entry like any solo View window. */
export function diffWindowUrl(sessionId: string, scope: DiffScope) {
  const q = new URLSearchParams({ session: sessionId, solo: "1", pane: "diff", label: scope.label });
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
  return { from: q.get("from"), to: q.get("to"), label: q.get("label") ?? "Changes", ...(sel && { sel: sel.split(",") }) };
}

const STATUS = {
  A: { Icon: FilePlus, className: "text-emerald-600", label: "added" },
  D: { Icon: FileMinus, className: "text-red-600", label: "deleted" },
  M: { Icon: FilePen, className: "text-sky-600", label: "modified" },
} as const;

/** git-diff-view marks changed lines only by their line-number color, or an empty side (split mode). */
const CHANGED = 'td[style*="-add-lineNumber--"], td[style*="-del-lineNumber--"], td.diff-line-old-placeholder, td.diff-line-new-placeholder';

/** First row of each change block (a run of changed rows) in the rendered diff; the first table only in split mode. */
function changeRows(root: HTMLElement | null): HTMLElement[] {
  const table = root?.querySelector("table");
  if (!table) return [];
  const rows = [...table.querySelectorAll<HTMLElement>("tr.diff-line")].filter((r) => !r.matches(".diff-line-extend, .diff-line-widget"));
  const changed = rows.map((r) => !!r.querySelector(CHANGED));
  return rows.filter((_, i) => changed[i] && !changed[i - 1]);
}

const VIEW_KEY = "harness:diff-file-view";
type FileView = "list" | "tree";
const readView = (): FileView => {
  try {
    return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "tree";
  } catch {
    return "tree";
  }
};

/** A row of the file list the cursor can be on: a file, or (tree view) a folder. Keys: `f:<path>`, `d:<folder>`. */
type NavRow =
  | { key: string; kind: "file"; depth: number; file: FilePatch; name: string }
  | { key: string; kind: "dir"; depth: number; dir: string; name: string; open: boolean; additions: number; deletions: number };
const fileKey = (f: FilePatch) => `f:${f.path}`;
const navRow = (r: TreeRow<FilePatch>): NavRow =>
  r.kind === "dir"
    ? { key: `d:${r.key}`, kind: "dir", depth: r.depth, dir: r.key, name: r.name, open: r.open, additions: r.additions, deletions: r.deletions }
    : { key: fileKey(r.file), kind: "file", depth: r.depth, file: r.file, name: r.name };
/** Left padding of a row: 16px per level; files skip the chevron's width so their icon lines up with folder icons. */
const indent = (r: NavRow) => 8 + r.depth * 16 + (r.kind === "file" ? 18 : 0);

/** JetBrains-like diff viewer: files (list or tree) and commits left, one file's diff right, keyboard navigation through files and changes. */
export function DiffWindow({ api, scope: initialScope }: { api: SessionApi; scope: DiffScope }) {
  const [scope, setScope] = useState(initialScope);
  const [diff, setDiff] = useState<Diff | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Selected row key; null = the first file. */
  const [cursor, setCursor] = useState<string | null>(null);
  const [mode, setMode] = useState<"split" | "unified">("split");
  const [view, setView] = useState<FileView>(readView);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [contents, setContents] = useState<Map<string, FileContents>>(new Map());
  const comments = useReviewComments(api.sessionId);
  const commits = useCommits(api);
  const pane = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
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
    api.gitDiff(scope.from, scope.to).then((d) => !off && setDiff(d), (e) => !off && setError(errorMessage(e)));
    return () => { off = true; };
  }, [api, scope]);

  const files = useMemo(() => (diff ? splitPatch(diff.patch) : []), [diff]);
  const tree = useMemo(() => fileTree(files, closed), [files, closed]);
  /** Files in display order, for next/previous file. */
  const order = view === "tree" ? tree.order : files;
  const orderIndex = useMemo(() => new Map(order.map((f, i) => [f.path, i])), [order]);
  const rows: NavRow[] = useMemo(
    () => (view === "tree" ? tree.rows.map(navRow) : files.map((f) => ({ key: fileKey(f), kind: "file" as const, depth: 0, file: f, name: f.path }))),
    [view, tree, files],
  );
  // A folder shows its first changed file.
  const file: FilePatch | undefined = cursor?.startsWith("d:")
    ? order.find((f) => f.path.startsWith(cursor.slice(2) + "/")) ?? order[0]
    : order.find((f) => fileKey(f) === cursor) ?? order[0];
  const idx = file ? orderIndex.get(file.path)! : -1;
  const activeKey = cursor && rows.some((r) => r.key === cursor) ? cursor : file ? fileKey(file) : null;
  const activePos = rows.findIndex((r) => r.key === activeKey);

  // Full contents let git-diff-view expand the collapsed unchanged regions.
  useEffect(() => {
    if (!diff || !file || contents.has(file.path)) return;
    let off = false;
    const read = (rev: string, path: string | null) => (path ? api.gitShowFile(rev, path) : Promise.resolve(""));
    Promise.all([read(diff.from, file.oldPath), read(diff.to, file.newPath)]).then(
      ([o, n]) => !off && setContents((m) => new Map(m).set(file.path, { old: o, new: n })),
      () => {}, // Without contents the diff still renders; only expanding is off.
    );
    return () => { off = true; };
  }, [api, diff, file, contents]);

  /** Selects a file by its place in `order`, opening its folders. */
  const goFile = useCallback((i: number, jump: "first" | "last" | null = null) => {
    const f = order[i];
    if (!f) return;
    change.current = -1;
    pendingJump.current = jump;
    setClosed((c) => {
      const hidden = ancestorKeys(c, f.path);
      return hidden.length ? new Set([...c].filter((k) => !hidden.includes(k))) : c;
    });
    setCursor(fileKey(f));
  }, [order]);

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

  const goChange = useCallback((dir: 1 | -1) => {
    const rows = changeRows(pane.current);
    const next = change.current + dir;
    if (next >= 0 && next < rows.length) scrollTo(rows, next);
    else goFile(idx + dir, dir === 1 ? "first" : "last");
  }, [goFile, idx]);

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

  useEffect(() => { change.current = -1; }, [mode]);

  useEffect(() => {
    if (activePos >= 0) list.current?.querySelector<HTMLElement>(`[data-pos="${activePos}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activePos]);

  useEffect(() => {
    pane.current?.scrollTo({ top: 0 });
  }, [file?.path]);

  // Alt+↑/↓: changes, Alt+←/→: files (like F7 / Ctrl+Alt+arrows in JetBrains). Plain arrows stay for scrolling and text.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.metaKey || e.ctrlKey) return;
      const k = { ArrowDown: () => goChange(1), ArrowUp: () => goChange(-1), ArrowRight: () => goFile(idx + 1), ArrowLeft: () => goFile(idx - 1) }[e.key];
      if (!k) return;
      e.preventDefault();
      k();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goChange, goFile, idx]);

  // ↑/↓ move through visible rows; ← collapses a folder or goes to the parent folder, → expands or goes to the first child.
  const onListKey = (e: ReactKeyboardEvent) => {
    if (e.altKey || e.metaKey || e.ctrlKey) return;
    const row = rows[activePos];
    const select = (r: NavRow | undefined) => r && setCursor(r.key);
    const act = {
      ArrowDown: () => select(rows[activePos + 1]),
      ArrowUp: () => select(rows[activePos - 1]),
      ArrowLeft: () => {
        if (row?.kind === "dir" && row.open) setOpen(row.dir, false);
        else if (row) select(rows.slice(0, activePos).reverse().find((r) => r.depth < row.depth));
      },
      ArrowRight: () => {
        if (row?.kind !== "dir") return;
        if (!row.open) setOpen(row.dir, true);
        else if (rows[activePos + 1]?.depth! > row.depth) select(rows[activePos + 1]);
      },
    }[e.key];
    if (!act) return;
    e.preventDefault();
    act();
  };

  const changeView = (v: FileView) => {
    setView(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* per-viewer convenience only */ }
  };

  const pathComments = (p: string) => comments.filter((c) => c.path === p).length;
  const sum = (k: "additions" | "deletions") => files.reduce((s, f) => s + f[k], 0);
  const rowItem = (r: NavRow, pos: number) => {
    const on = r.key === activeKey;
    const base = cn("flex h-7 cursor-default items-center gap-1.5 pr-2 text-[13px]", on ? "bg-accent text-accent-foreground" : "hover:bg-accent/50");
    if (r.kind === "dir")
      return (
        <li key={r.key} id={`diff-row-${pos}`} data-pos={pos} role="treeitem" aria-selected={on} aria-expanded={r.open} title={r.dir}
          style={{ paddingLeft: indent(r) }} className={base} onClick={() => setCursor(r.key)} onDoubleClick={() => setOpen(r.dir, !r.open)}>
          <button tabIndex={-1} aria-label={r.open ? "Collapse" : "Expand"} className="-m-0.5 rounded p-0.5 hover:bg-accent"
            onClick={(e) => { e.stopPropagation(); setCursor(r.key); setOpen(r.dir, !r.open); }}>
            <ChevronRight className={cn("size-3.5 text-muted-foreground transition-transform", r.open && "rotate-90")} />
          </button>
          <Folder className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{r.name}</span>
          {!r.open && <span className="font-mono text-xs text-emerald-500">+{r.additions}</span>}
          {!r.open && r.deletions > 0 && <span className="font-mono text-xs text-red-500">−{r.deletions}</span>}
        </li>
      );
    const f = r.file;
    const s = STATUS[f.status];
    const n = pathComments(f.path);
    const slash = f.path.lastIndexOf("/");
    return (
      <li key={r.key} id={`diff-row-${pos}`} data-pos={pos} role="treeitem" aria-selected={on} title={`${f.path} (${s.label})`}
        style={{ paddingLeft: view === "tree" ? indent(r) : 8 }} className={base} onClick={() => goFile(orderIndex.get(f.path)!)}>
        <s.Icon className={cn("size-4 shrink-0", s.className)} aria-label={s.label} />
        <span className="truncate">{f.path.slice(slash + 1)}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{view === "list" && slash > 0 ? f.path.slice(0, slash) : ""}</span>
        {n > 0 && <span className="flex items-center gap-0.5 text-xs text-muted-foreground" title={`${n} comments`}><MessageSquare className="size-3" />{n}</span>}
      </li>
    );
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b px-2 py-1.5 text-xs">
        <Button size="icon" variant="ghost" className="size-7" aria-label="Previous change" title="Previous change (Alt+↑)" onClick={() => goChange(-1)}><ArrowUp /></Button>
        <Button size="icon" variant="ghost" className="size-7" aria-label="Next change" title="Next change (Alt+↓)" onClick={() => goChange(1)}><ArrowDown /></Button>
        <div className="mx-1 h-4 w-px bg-border" />
        <Button size="icon" variant="ghost" className="size-7" aria-label="Previous file" title="Previous file (Alt+←)" disabled={idx <= 0} onClick={() => goFile(idx - 1)}><ArrowLeft /></Button>
        <span className="tabular-nums text-muted-foreground">{idx + 1}/{order.length} files</span>
        <Button size="icon" variant="ghost" className="size-7" aria-label="Next file" title="Next file (Alt+→)" disabled={idx >= order.length - 1} onClick={() => goFile(idx + 1)}><ArrowRight /></Button>
        <span className="ml-2 max-w-64 shrink-0 truncate rounded-full bg-muted px-2 py-0.5" title={scope.label}>{scope.label}</span>
        <span className="ml-2 min-w-0 flex-1 truncate font-mono text-muted-foreground">{file?.path}</span>
        {file && <span className="tabular-nums text-muted-foreground">{changeCount(file.text)} {changeCount(file.text) === 1 ? "difference" : "differences"}</span>}
        <div className="ml-2 flex rounded-md border">
          <Button size="icon" variant={mode === "split" ? "secondary" : "ghost"} className="size-7 rounded-r-none" aria-label="Side by side" aria-pressed={mode === "split"} title="Side by side" onClick={() => setMode("split")}><Columns2 /></Button>
          <Button size="icon" variant={mode === "unified" ? "secondary" : "ghost"} className="size-7 rounded-l-none" aria-label="Unified" aria-pressed={mode === "unified"} title="Unified" onClick={() => setMode("unified")}><Rows2 /></Button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex w-80 shrink-0 flex-col border-r">
          <div className="flex items-center gap-1.5 py-1 pr-1.5 pl-3 text-xs text-muted-foreground">
            <span className="font-medium text-foreground/80">Changed files</span>
            <span>{files.length}</span>
            <span className="font-mono text-emerald-500">+{sum("additions")}</span>
            <span className="font-mono text-red-500">−{sum("deletions")}</span>
            <div className="ml-auto flex rounded-md border" role="group" aria-label="File view">
              <Button size="icon" variant={view === "list" ? "secondary" : "ghost"} className="size-6 rounded-r-none" aria-label="List" aria-pressed={view === "list"} title="List" onClick={() => changeView("list")}><List /></Button>
              <Button size="icon" variant={view === "tree" ? "secondary" : "ghost"} className="size-6 rounded-l-none" aria-label="Tree" aria-pressed={view === "tree"} title="Tree" onClick={() => changeView("tree")}><ListTree /></Button>
            </div>
          </div>
          <ul
            ref={list}
            role="tree"
            aria-label="Changed files"
            tabIndex={0}
            aria-activedescendant={activePos >= 0 ? `diff-row-${activePos}` : undefined}
            className="min-h-0 flex-1 overflow-auto pb-1 outline-none"
            onKeyDown={onListKey}
          >
            {error ? (
              <li role="alert" className="p-3 text-xs text-destructive">{error}</li>
            ) : !diff ? (
              <li className="p-3 text-xs text-muted-foreground">Loading...</li>
            ) : (
              rows.map(rowItem)
            )}
          </ul>
          <CommitsPane commits={commits} sel={scope.sel} defaultHeight={250} onSelect={(sel) => setScope(selectionScope(sel, commits))} />
        </div>
        <div ref={pane} className="min-w-0 flex-1 overflow-auto">
          {file ? (
            <DiffViewer key={file.path} sessionId={api.sessionId} file={file} comments={comments} mode={mode} contents={contents.get(file.path)} />
          ) : (
            diff && <p className="p-4 text-sm text-muted-foreground">No changes.</p>
          )}
        </div>
      </div>
    </div>
  );
}
