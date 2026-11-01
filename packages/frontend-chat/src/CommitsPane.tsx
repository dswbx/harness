import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Commit, SessionApi } from "@harness/api";
import { ScrollArea, Tooltip, cn } from "@harness/ui";
import { ALL, WIP, toggleSelection } from "./scope";
import { formatRelativeTime, fullMessageTime } from "./time";

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

/** Names from `Co-authored-by:` trailers. */
export const coAuthors = (body: string) => [...body.matchAll(/^Co-authored-by:\s*(.+)$/gim)].map((m) => m[1]!.trim());

/** Hover card content for a commit: message, hash, people, date. */
export function CommitInfo({ commit: c }: { commit: Commit }) {
  const message = c.body.replace(/^Co-authored-by:.*$/gim, "").trim();
  const co = coAuthors(c.body);
  return (
    <div className="space-y-2">
      <div className="font-medium">{c.subject}</div>
      {message && <div className="whitespace-pre-wrap text-muted-foreground">{message}</div>}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        <dt className="text-muted-foreground">Commit</dt>
        <dd className="font-mono break-all">{c.sha}</dd>
        <dt className="text-muted-foreground">Author</dt>
        <dd>{c.author}{c.author_email && <span className="text-muted-foreground"> &lt;{c.author_email}&gt;</span>}</dd>
        {c.committer !== c.author && (
          <>
            <dt className="text-muted-foreground">Committer</dt>
            <dd>{c.committer}</dd>
          </>
        )}
        {co.length > 0 && (
          <>
            <dt className="text-muted-foreground">Co-authors</dt>
            <dd>{co.map((a) => <div key={a}>{a}</div>)}</dd>
          </>
        )}
        <dt className="text-muted-foreground">Date</dt>
        <dd>{fullMessageTime(c.time * 1000)}</dd>
      </dl>
    </div>
  );
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
  commits, sel, onSelect, uncommitted, defaultHeight = 220, tipSide = "right",
}: {
  commits: readonly Commit[];
  /** Current selection; undefined when the shown range did not come from this pane (a Turn's changes). */
  sel: readonly string[] | undefined;
  onSelect: (sel: string[]) => void;
  /** Uncommitted file count, when known. */
  uncommitted?: number;
  defaultHeight?: number;
  /** Where commit hover cards open. */
  tipSide?: "left" | "right";
}) {
  const [height, setHeight] = useState(() => readHeight(defaultHeight));
  const drag = useRef<{ y: number; h: number } | null>(null);

  const items = [
    { id: ALL, commit: undefined, title: "All changes", sub: `${commits.length} ${commits.length === 1 ? "commit" : "commits"} + uncommitted` },
    { id: WIP, commit: undefined, title: "Uncommitted changes", sub: uncommitted == null ? "Working tree" : `${uncommitted} ${uncommitted === 1 ? "file" : "files"}` },
    ...commits.map((c) => ({ id: c.sha, commit: c, title: c.subject, sub: `${c.short} · ${c.author} · ${formatRelativeTime(c.time * 1000)}` })),
  ];

  // ↑/↓ select the previous/next item alone (from the last selected one) and keep it in view and focused.
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const onKey = (e: KeyboardEvent) => {
    if (e.altKey || e.metaKey || e.ctrlKey || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
    e.preventDefault();
    const last = sel?.length ? items.findIndex((it) => it.id === sel[sel.length - 1]) : -1;
    const next = items[last < 0 ? 0 : Math.min(items.length - 1, Math.max(0, last + (e.key === "ArrowDown" ? 1 : -1)))];
    if (!next) return;
    onSelect([next.id]);
    const el = buttons.current.get(next.id);
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: "nearest" });
  };

  return (
    <div className="flex shrink-0 flex-col border-t" style={{ height }}>
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize commits pane"
        className="relative -mt-1 h-2 shrink-0 cursor-row-resize after:absolute after:inset-x-0 after:top-1/2 after:h-px after:-translate-y-1/2 after:transition-colors hover:after:bg-ring"
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
      <ScrollArea className="min-h-0 flex-1"><div role="listbox" aria-label="Commits" aria-multiselectable className="px-1.5 pb-1.5" onKeyDown={onKey}>
        {items.map((it) => {
          const on = !!sel?.includes(it.id);
          const row = (
            <button
              key={it.id}
              ref={(el) => { if (el) buttons.current.set(it.id, el); else buttons.current.delete(it.id); }}
              role="option"
              aria-selected={on}
              className={cn("flex w-full select-none flex-col outline-none gap-0.5 rounded-md px-2 py-1.5 text-left text-xs", on ? "bg-accent text-accent-foreground" : "hover:bg-accent/50")}
              onClick={(e) => {
                // WebKit (Tauri on macOS) doesn't focus a clicked button; focus it so ↑/↓ reach this list instead of scrolling the page.
                e.currentTarget.focus({ preventScroll: true });
                onSelect(toggleSelection(sel ?? [], it.id, e.metaKey || e.ctrlKey || e.shiftKey));
              }}
            >
              <span className="w-full truncate">{it.title}</span>
              <span className="w-full truncate text-[11px] text-muted-foreground">{it.sub}</span>
            </button>
          );
          return it.commit ? (
            <Tooltip key={it.id} side={tipSide} align="start" delay={400} className="max-w-[28rem]" content={<CommitInfo commit={it.commit} />}>
              {row}
            </Tooltip>
          ) : row;
        })}
      </div></ScrollArea>
    </div>
  );
}
