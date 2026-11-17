import type { SessionSummary } from "@harness/api";
import { cn, ScrollArea } from "@harness/ui";
import { ChevronRight, Folder, Search, X } from "lucide-react";
import { Fragment, type ReactNode, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useStored } from "../platform/useStored";
import { GroupHeader } from "./GroupHeader";
import { SessionRow } from "./SessionRow";
import {
   bubbledStatus,
   bubbledUnseen,
   DEFAULT_VIEW,
   type Display,
   type GroupBy,
   groupSessions,
   moveFolder,
   nestSubSessions,
   type SortBy,
   sessionMatches,
   type ViewOptions,
   withNewFolders,
} from "./sessionGroups";
import { useFolderDrag } from "./useFolderDrag";
import { ViewOptionsButton } from "./ViewOptionsButton";

const oneOf =
   <T extends string>(...opts: T[]) =>
   (v: unknown): v is T =>
      opts.includes(v as T);
const strings = (v: unknown): v is string[] =>
   Array.isArray(v) && v.every((x) => typeof x === "string");

/**
 * The sidebar's Session list: search, view options (sort, display, grouping; kept in localStorage),
 * collapsible groups, then the Archived section. `children` goes at the end of the scroll area.
 */
export function SessionList({
   sessions,
   selected,
   onSelect,
   onArchive,
   onDelete,
   onOpenWindow,
   onNewInFolder,
   onNewQuick,
   children,
}: {
   sessions: SessionSummary[];
   selected: string | null;
   onSelect: (id: string) => void;
   onArchive: (s: SessionSummary) => void;
   onDelete: (s: SessionSummary) => void;
   /** Opens the Session in its own window. */
   onOpenWindow?: (s: SessionSummary) => void;
   /** Opens the Composer with this folder picked (the + on a folder group). */
   onNewInFolder?: (folder: string) => void;
   /** Starts a Quick Session right away (the + on the Quick group). */
   onNewQuick?: () => void;
   children?: ReactNode;
}) {
   const [query, setQuery] = useState("");
   const [sort, setSort] = useStored<SortBy>(
      "harness.sessionList.sort",
      DEFAULT_VIEW.sort,
      oneOf("recent", "created"),
   );
   const [display, setDisplay] = useStored<Display>(
      "harness.sessionList.display",
      DEFAULT_VIEW.display,
      oneOf("condensed", "detail"),
   );
   const [group, setGroup] = useStored<GroupBy>(
      "harness.sessionList.group",
      DEFAULT_VIEW.group,
      oneOf("none", "folder", "date"),
   );
   const [collapsed, setCollapsed] = useStored<string[]>(
      "harness.sessionList.collapsed",
      [],
      strings,
   );
   // Folder group ids in the user's order (drag a header to move one; new folders go on top).
   const [folderOrder, setFolderOrder] = useStored<string[]>(
      "harness.sessionList.folderOrder",
      [],
      strings,
   );
   const [archivedOpen, setArchivedOpen] = useState(false);
   const view: ViewOptions = { sort, display, group };
   const setView = (v: Partial<ViewOptions>) => {
      if (v.sort) setSort(v.sort);
      if (v.display) setDisplay(v.display);
      if (v.group) setGroup(v.group);
   };

   const q = query.trim().toLowerCase();
   const now = Date.now();
   // Sub Sessions nest under their parent. While searching, groups flatten into one list.
   const { groups, subs } = useMemo(() => {
      const n = nestSubSessions(
         sessions.filter((s) => !s.archived),
         q,
      );
      return {
         groups: groupSessions(
            n.roots,
            { sort, group: q ? "none" : group, folderOrder },
            undefined,
            n.children,
         ),
         subs: n.children,
      };
   }, [sessions, q, sort, group, folderOrder]);
   // Remember where new folders showed up (on top), so the next new one goes above them.
   useEffect(() => {
      const next = withNewFolders(folderOrder, groups);
      if (next !== folderOrder) setFolderOrder(next);
   }, [groups, folderOrder, setFolderOrder]);
   const shownFolders = groups.filter((g) => g.folder).map((g) => g.id);
   const { drag, start: startDrag } = useFolderDrag((id, before) => {
      const next = moveFolder(withNewFolders(folderOrder, groups), shownFolders, id, before);
      if (next) setFolderOrder(next);
   });
   // The drop line, unless the drop would leave the group where it is.
   const dropBefore =
      drag &&
      moveFolder(shownFolders, shownFolders, drag.id, drag.before) &&
      (drag.before ?? "quick");
   const archived = sessions.filter((s) => s.archived && sessionMatches(s, q));
   const empty = q !== "" && groups.every((g) => g.sessions.length === 0) && archived.length === 0;
   const toggle = (id: string) =>
      setCollapsed(collapsed.includes(id) ? collapsed.filter((c) => c !== id) : [...collapsed, id]);

   const row = (s: SessionSummary, parent?: SessionSummary) => (
      <SessionRow
         key={s.id}
         s={s}
         parent={parent}
         selected={s.id === selected}
         display={display}
         query={q}
         // A Sub Session can work in another repository than its parent: always named.
         showFolder={!!parent || group !== "folder" || q !== ""}
         now={now}
         onSelect={() => onSelect(s.id)}
         onArchive={() => onArchive(s)}
         onDelete={() => onDelete(s)}
         onOpenWindow={onOpenWindow && (() => onOpenWindow(s))}
      />
   );
   /** A root row, with its Sub Sessions indented below (expanded unless collapsed as `sub:<id>`). */
   const rootRow = (s: SessionSummary) => {
      const kids = subs.get(s.id);
      if (!kids?.length) return row(s);
      const key = `sub:${s.id}`;
      // While searching, matching Sub Sessions always show.
      const open = q !== "" || !collapsed.includes(key);
      return (
         <Fragment key={s.id}>
            <SessionRow
               s={s}
               status={open ? s.status : bubbledStatus(s, subs)}
               unseen={open ? s.unseen : bubbledUnseen(s, subs)}
               sub={{ count: kids.length, open, onToggle: () => toggle(key) }}
               selected={s.id === selected}
               display={display}
               query={q}
               showFolder={group !== "folder" || q !== ""}
               now={now}
               onSelect={() => onSelect(s.id)}
               onArchive={() => onArchive(s)}
               onDelete={() => onDelete(s)}
               onOpenWindow={onOpenWindow && (() => onOpenWindow(s))}
            />
            {open && (
               <li>
                  <ul className="ml-3 flex flex-col gap-px border-l pl-2">
                     {kids.map((k) => row(k, s))}
                  </ul>
               </li>
            )}
         </Fragment>
      );
   };

   const dragged = drag && groups.find((g) => g.id === drag.id);

   return (
      <>
         {drag &&
            dragged &&
            // A lifted copy of the header under the pointer, where it was grabbed.
            createPortal(
               <div
                  className="pointer-events-none fixed z-50 flex h-7 items-center gap-1.5 rounded-md border bg-popover px-1.5 text-xs font-medium text-muted-foreground opacity-90 shadow-lg"
                  style={{
                     left: drag.x - drag.dx,
                     top: drag.y - drag.dy,
                     width: drag.width,
                  }}
               >
                  <Folder className="size-3.25 shrink-0" />
                  <span className="min-w-0 truncate text-foreground">{dragged.label}</span>
                  <span className="shrink-0 tabular-nums">{dragged.sessions.length}</span>
               </div>,
               document.body,
            )}
         <div className="flex shrink-0 items-center gap-1.5 px-2.5 pb-2">
            <label className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md border px-2 text-muted-foreground focus-within:ring-1 focus-within:ring-ring">
               <Search className="size-3 shrink-0 opacity-80 " />
               <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                     if (e.key !== "Escape") return;
                     setQuery("");
                     e.currentTarget.blur();
                  }}
                  placeholder="Search sessions"
                  aria-label="Search sessions"
                  className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/50"
               />
               {query && (
                  <button
                     aria-label="Clear search"
                     onClick={() => setQuery("")}
                     className="grid size-5 shrink-0 place-items-center rounded hover:bg-accent hover:text-accent-foreground"
                  >
                     <X className="size-3" />
                  </button>
               )}
            </label>
            <ViewOptionsButton view={view} onChange={setView} />
         </div>
         <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col px-2 py-1">
               {sessions.length === 0 && (
                  <p className="p-3 text-xs text-muted-foreground">No Sessions yet.</p>
               )}
               {groups.map((g) => {
                  const open = g.id === "all" || !collapsed.includes(g.id);
                  return (
                     // Only an open group adds space below it; collapsed headers stack tight.
                     <div
                        key={g.id}
                        className={cn(
                           "relative flex flex-col transition-opacity",
                           open && "mb-4.5 last:mb-0",
                           drag?.id === g.id && "opacity-40",
                        )}
                     >
                        {dropBefore === g.id && (
                           <div className="pointer-events-none absolute inset-x-1 -top-0.5 h-0.5 rounded-full bg-primary" />
                        )}
                        {g.id !== "all" && (
                           <GroupHeader
                              g={g}
                              open={open}
                              onToggle={() => toggle(g.id)}
                              onNewInFolder={onNewInFolder}
                              onNewQuick={onNewQuick}
                              onDragStart={g.folder ? (e) => startDrag(g.id, e) : undefined}
                           />
                        )}
                        {open && (
                           <ul className="flex flex-col gap-px">{g.sessions.map(rootRow)}</ul>
                        )}
                     </div>
                  );
               })}
               {empty && (
                  <div className="flex flex-col items-center gap-2.5 px-4 py-10 text-center text-[13px] text-muted-foreground">
                     <span>No sessions match “{query.trim()}”</span>
                     <button
                        onClick={() => setQuery("")}
                        className="h-7 rounded-md border px-3 text-xs text-foreground hover:bg-accent hover:text-accent-foreground"
                     >
                        Clear search
                     </button>
                  </div>
               )}
            </div>
            {archived.length > 0 && (
               <div className="p-2 pt-1">
                  <button
                     className="flex w-full items-center gap-1 px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
                     aria-expanded={archivedOpen}
                     onClick={() => setArchivedOpen(!archivedOpen)}
                  >
                     <ChevronRight
                        className={cn("size-3 transition-transform", archivedOpen && "rotate-90")}
                     />
                     Archived ({archived.length})
                  </button>
                  {archivedOpen && (
                     <ul className="flex flex-col gap-px">{archived.map((s) => row(s))}</ul>
                  )}
               </div>
            )}
            {children}
         </ScrollArea>
      </>
   );
}
