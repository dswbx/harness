import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

/** JetBrains-like diff viewer: files (list or tree) and commits left, one file's diff right, keyboard navigation through files and changes. */
export function DiffWindow({ api, scope: initialScope }: { api: SessionApi; scope: DiffScope }) {
  const [scope, setScope] = useState(initialScope);
  const [diff, setDiff] = useState<Diff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [idx, setIdx] = useState(0);
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
    setIdx(0);
    setContents(new Map());
    change.current = -1;
    api.gitDiff(scope.from, scope.to).then((d) => !off && setDiff(d), (e) => !off && setError(errorMessage(e)));
    return () => { off = true; };
  }, [api, scope]);

  const files = useMemo(() => (diff ? splitPatch(diff.patch) : []), [diff]);
  const tree = useMemo(() => fileTree(files, closed), [files, closed]);
  /** Files in display order; `idx` points into it. */
  const order = view === "tree" ? tree.order : files;
  const orderIndex = useMemo(() => new Map(order.map((f, i) => [f.path, i])), [order]);
  const file: FilePatch | undefined = order[idx];

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

  // Selecting a file opens its folders, so keyboard navigation never lands in a hidden row. Collapsing one later stays collapsed.
  useEffect(() => {
    if (!file) return;
    setClosed((c) => {
      const hidden = ancestorKeys(c, file.path);
      return hidden.length ? new Set([...c].filter((k) => !hidden.includes(k))) : c;
    });
  }, [file]);

  const goFile = useCallback((i: number, jump: "first" | "last" | null = null) => {
    if (i < 0 || i >= order.length) return;
    change.current = -1;
    pendingJump.current = jump;
    setIdx(i);
  }, [order.length]);

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
  }, [idx]);

  useEffect(() => { change.current = -1; }, [mode]);

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${idx}"]`)?.scrollIntoView({ block: "nearest" });
    pane.current?.scrollTo({ top: 0 });
  }, [idx]);

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

  const changeView = (v: FileView) => {
    // Keep the selected file across the reorder.
    const path = file?.path;
    setView(v);
    setIdx(Math.max(0, (v === "tree" ? tree.order : files).findIndex((f) => f.path === path)));
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* per-viewer convenience only */ }
  };
  const toggleDir = (key: string) => setClosed((c) => {
    const n = new Set(c);
    if (!n.delete(key)) n.add(key);
    return n;
  });

  const pathComments = (p: string) => comments.filter((c) => c.path === p).length;
  const sum = (k: "additions" | "deletions") => files.reduce((s, f) => s + f[k], 0);
  const fileItem = (f: FilePatch, depth: number, showDir: boolean) => {
    const i = orderIndex.get(f.path)!;
    const s = STATUS[f.status];
    const n = pathComments(f.path);
    const slash = f.path.lastIndexOf("/");
    return (
      <li
        key={f.path}
        id={`diff-file-${i}`}
        data-index={i}
        role="option"
        aria-selected={i === idx}
        title={`${f.path} (${s.label})`}
        style={{ paddingLeft: 8 + depth * 14 }}
        className={cn("flex cursor-default items-center gap-1.5 py-0.5 pr-2 text-xs", i === idx ? "bg-accent text-accent-foreground" : "hover:bg-accent/50")}
        onClick={() => goFile(i)}
      >
        <s.Icon className={cn("size-3.5 shrink-0", s.className)} aria-label={s.label} />
        <span className="truncate">{f.path.slice(slash + 1)}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{showDir && slash > 0 ? f.path.slice(0, slash) : ""}</span>
        {n > 0 && <span className="flex items-center gap-0.5 text-muted-foreground" title={`${n} comments`}><MessageSquare className="size-3" />{n}</span>}
      </li>
    );
  };
  const dirItem = (r: Extract<TreeRow<FilePatch>, { kind: "dir" }>) => (
    <li key={`dir:${r.key}`} role="presentation">
      <button
        aria-expanded={r.open}
        title={r.key}
        style={{ paddingLeft: 8 + r.depth * 14 }}
        className="flex w-full cursor-default items-center gap-1.5 py-0.5 pr-2 text-left text-xs hover:bg-accent/50"
        onClick={() => toggleDir(r.key)}
      >
        <ChevronRight className={cn("size-3 shrink-0 text-muted-foreground transition-transform", r.open && "rotate-90")} />
        <Folder className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{r.name}</span>
        {!r.open && <span className="font-mono text-emerald-500">+{r.additions}</span>}
        {!r.open && r.deletions > 0 && <span className="font-mono text-red-500">−{r.deletions}</span>}
      </button>
    </li>
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b px-2 py-1.5 text-xs">
        <Button size="icon" variant="ghost" className="size-7" aria-label="Previous change" title="Previous change (Alt+↑)" onClick={() => goChange(-1)}><ArrowUp /></Button>
        <Button size="icon" variant="ghost" className="size-7" aria-label="Next change" title="Next change (Alt+↓)" onClick={() => goChange(1)}><ArrowDown /></Button>
        <div className="mx-1 h-4 w-px bg-border" />
        <Button size="icon" variant="ghost" className="size-7" aria-label="Previous file" title="Previous file (Alt+←)" disabled={idx === 0} onClick={() => goFile(idx - 1)}><ArrowLeft /></Button>
        <span className="tabular-nums text-muted-foreground">{order.length ? idx + 1 : 0}/{order.length} files</span>
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
        <div className="flex w-72 shrink-0 flex-col border-r">
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
            role="listbox"
            aria-label="Changed files"
            tabIndex={0}
            aria-activedescendant={file ? `diff-file-${idx}` : undefined}
            className="min-h-0 flex-1 overflow-auto pb-1 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            onKeyDown={(e) => {
              if (e.altKey) return;
              if (e.key === "ArrowDown") { e.preventDefault(); goFile(idx + 1); }
              else if (e.key === "ArrowUp") { e.preventDefault(); goFile(idx - 1); }
            }}
          >
            {error ? (
              <li role="alert" className="p-3 text-xs text-destructive">{error}</li>
            ) : !diff ? (
              <li className="p-3 text-xs text-muted-foreground">Loading...</li>
            ) : view === "tree" ? (
              tree.rows.map((r) => (r.kind === "dir" ? dirItem(r) : fileItem(r.file, r.depth, false)))
            ) : (
              files.map((f) => fileItem(f, 0, true))
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
