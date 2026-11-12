import { cn } from "@harness/ui";
import { ChevronRight, Folder } from "lucide-react";
import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useEffect, useRef } from "react";
import type { TreeRow } from "./fileTree";

/** A row of a file list the cursor can be on: a file, or (tree view) a folder. Keys: `f:<path>`, `d:<folder>`. */
export type NavRow<T> =
   | { key: string; kind: "file"; depth: number; file: T; name: string }
   | { key: string; kind: "dir"; depth: number; dir: string; name: string; open: boolean };

export const fileRowKey = (path: string) => `f:${path}`;
export const dirRowKey = (dir: string) => `d:${dir}`;

/** A `fileTree` row as a list row. */
export const navRow = <T extends { path: string }>(r: TreeRow<T>): NavRow<T> =>
   r.kind === "dir"
      ? {
           key: dirRowKey(r.key),
           kind: "dir",
           depth: r.depth,
           dir: r.key,
           name: r.name,
           open: r.open,
        }
      : { key: fileRowKey(r.file.path), kind: "file", depth: r.depth, file: r.file, name: r.name };

/** Left padding of a row: 16px per level; files skip the chevron's width so their icon lines up with folder icons. */
const indent = (r: NavRow<unknown>) => 8 + r.depth * 16 + (r.kind === "file" ? 18 : 0);

/**
 * A keyboard-navigable file list or tree (diff window, Files panel). ↑/↓ move through visible rows; ← collapses a
 * folder or goes to the parent folder, → expands or goes to the first child. The parent owns the cursor and the
 * open folders.
 */
export function FileTreeList<T>({
   rows,
   activeKey,
   label,
   idPrefix,
   flat = false,
   placeholder,
   className,
   onSelect,
   onOpenFile,
   onSetOpen,
   renderFile,
}: {
   rows: NavRow<T>[];
   /** The cursor's row key. */
   activeKey: string | null;
   label: string;
   /** For the rows' ids (aria-activedescendant); unique per window. */
   idPrefix: string;
   /** List view: files are not indented. */
   flat?: boolean;
   /** Shown instead of the rows (loading, error). */
   placeholder?: ReactNode;
   className?: string;
   /** Keyboard moved the cursor, or a folder was clicked (a click also toggles it). */
   onSelect: (key: string) => void;
   /** A file row was clicked. */
   onOpenFile: (row: Extract<NavRow<T>, { kind: "file" }>) => void;
   onSetOpen: (dir: string, open: boolean) => void;
   /** A file row's content: icon, name, badges. */
   renderFile: (row: Extract<NavRow<T>, { kind: "file" }>) => ReactNode;
}) {
   const list = useRef<HTMLUListElement>(null);
   const activePos = rows.findIndex((r) => r.key === activeKey);

   useEffect(() => {
      if (activePos >= 0)
         list.current
            ?.querySelector<HTMLElement>(`[data-pos="${activePos}"]`)
            ?.scrollIntoView({ block: "nearest" });
   }, [activePos]);

   const onKeyDown = (e: ReactKeyboardEvent) => {
      if (e.altKey || e.metaKey || e.ctrlKey) return;
      const row = rows[activePos];
      const select = (r: NavRow<T> | undefined) => r && onSelect(r.key);
      const act = {
         ArrowDown: () => select(rows[activePos + 1]),
         ArrowUp: () => select(rows[activePos - 1]),
         ArrowLeft: () => {
            if (row?.kind === "dir" && row.open) onSetOpen(row.dir, false);
            else if (row)
               select(
                  rows
                     .slice(0, activePos)
                     .reverse()
                     .find((r) => r.depth < row.depth),
               );
         },
         ArrowRight: () => {
            if (row?.kind !== "dir") return;
            if (!row.open) onSetOpen(row.dir, true);
            else if ((rows[activePos + 1]?.depth ?? -1) > row.depth) select(rows[activePos + 1]);
         },
      }[e.key];
      if (!act) return;
      e.preventDefault();
      act();
   };

   const rowItem = (r: NavRow<T>, pos: number) => {
      const on = r.key === activeKey;
      const base = cn(
         "flex h-7 cursor-default items-center gap-1.5 pr-2 text-[13px]",
         on ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
      );
      if (r.kind === "dir")
         return (
            <li
               key={r.key}
               id={`${idPrefix}-${pos}`}
               data-pos={pos}
               role="treeitem"
               aria-selected={on}
               aria-expanded={r.open}
               style={{ paddingLeft: indent(r) }}
               className={base}
               onClick={() => {
                  onSelect(r.key);
                  onSetOpen(r.dir, !r.open);
               }}
            >
               <ChevronRight
                  aria-hidden
                  className={cn(
                     "size-3.5 shrink-0 text-muted-foreground transition-transform",
                     r.open && "rotate-90",
                  )}
               />
               <Folder className="size-4 shrink-0 text-muted-foreground" />
               <span className="min-w-0 flex-1 truncate">{r.name}</span>
            </li>
         );
      return (
         <li
            key={r.key}
            id={`${idPrefix}-${pos}`}
            data-pos={pos}
            role="treeitem"
            aria-selected={on}
            style={{ paddingLeft: flat ? 8 : indent(r) }}
            className={base}
            onClick={() => onOpenFile(r)}
         >
            {renderFile(r)}
         </li>
      );
   };

   return (
      <ul
         ref={list}
         role="tree"
         aria-label={label}
         tabIndex={0}
         aria-activedescendant={activePos >= 0 ? `${idPrefix}-${activePos}` : undefined}
         className={cn("min-h-0 flex-1 overflow-auto pb-1 outline-none", className)}
         onKeyDown={onKeyDown}
      >
         {placeholder ?? rows.map(rowItem)}
      </ul>
   );
}
