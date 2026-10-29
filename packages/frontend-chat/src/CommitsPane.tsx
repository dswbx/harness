import { useEffect, useRef, useState } from "react";
import type { Commit, SessionApi } from "@harness/api";
import { cn } from "@harness/ui";
import { ALL, WIP, toggleSelection } from "./scope";
import { formatRelativeTime } from "./time";

/** The Session's commits (newest first); reloads when `refreshKey` changes. Empty on error. */
export function useCommits(api: SessionApi, refreshKey?: string): Commit[] {
  const [commits, setCommits] = useState<Commit[]>([]);
  useEffect(() => {
    let off = false;
    api.gitLog().then((c) => !off && setCommits(c), () => !off && setCommits([]));
    return () => { off = true; };
  }, [api, refreshKey]);
  return commits;
}

const HEIGHT_KEY = "harness:commits-pane-height";
const readHeight = (fallback: number) => {
  try {
    return Number(localStorage.getItem(HEIGHT_KEY)) || fallback;
  } catch {
    return fallback;
  }
};

/** Bottom pane: All changes, Uncommitted changes, then the Session's commits. ⌘/Ctrl/⇧-click combines; drag the top edge to resize. */
export function CommitsPane({
  commits, sel, onSelect, uncommitted, defaultHeight = 220,
}: {
  commits: readonly Commit[];
  /** Current selection; undefined when the shown range did not come from this pane (a Turn's changes). */
  sel: readonly string[] | undefined;
  onSelect: (sel: string[]) => void;
  /** Uncommitted file count, when known. */
  uncommitted?: number;
  defaultHeight?: number;
}) {
  const [height, setHeight] = useState(() => readHeight(defaultHeight));
  const drag = useRef<{ y: number; h: number } | null>(null);

  const items = [
    { id: ALL, title: "All changes", sub: `${commits.length} ${commits.length === 1 ? "commit" : "commits"} + uncommitted` },
    { id: WIP, title: "Uncommitted changes", sub: uncommitted == null ? "Working tree" : `${uncommitted} ${uncommitted === 1 ? "file" : "files"}` },
    ...commits.map((c) => ({ id: c.sha, title: c.subject, sub: `${c.short} · ${c.author} · ${formatRelativeTime(c.time * 1000)}` })),
  ];

  return (
    <div className="flex shrink-0 flex-col border-t" style={{ height }}>
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize commits pane"
        className="-mt-1 h-2 shrink-0 cursor-row-resize"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { y: e.clientY, h: height };
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          setHeight(Math.min(Math.max(drag.current.h + drag.current.y - e.clientY, 80), window.innerHeight - 160));
        }}
        onPointerUp={() => {
          drag.current = null;
          try { localStorage.setItem(HEIGHT_KEY, String(height)); } catch { /* per-viewer convenience only */ }
        }}
      />
      <div className="flex items-center gap-1.5 px-3 pb-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground/80">Commits</span>
        <span>{commits.length}</span>
        <span className="ml-auto text-[11px]">⌘/⇧-click to combine</span>
      </div>
      <div role="listbox" aria-label="Commits" aria-multiselectable className="min-h-0 flex-1 overflow-auto px-1.5 pb-1.5">
        {items.map((it) => {
          const on = !!sel?.includes(it.id);
          return (
            <button
              key={it.id}
              role="option"
              aria-selected={on}
              title={it.title}
              className={cn("flex w-full select-none flex-col gap-0.5 rounded-md px-2 py-1.5 text-left text-xs", on ? "bg-accent text-accent-foreground" : "hover:bg-accent/50")}
              onClick={(e) => onSelect(toggleSelection(sel ?? [], it.id, e.metaKey || e.ctrlKey || e.shiftKey))}
            >
              <span className="w-full truncate">{it.title}</span>
              <span className="w-full truncate text-[11px] text-muted-foreground">{it.sub}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
