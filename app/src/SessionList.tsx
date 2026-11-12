import { type SessionSummary, useSessionHasDraft } from "@harness/api";
import { cn, Popover, PopoverContent, PopoverTrigger, ScrollArea, Tooltip } from "@harness/ui";
import {
   Archive,
   ArchiveRestore,
   Check,
   ChevronRight,
   Folder,
   GitBranch,
   GitFork,
   GitPullRequest,
   ListFilter,
   MoreHorizontal,
   Pencil,
   Plus,
   Search,
   Trash2,
   X,
   Zap,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { SessionDetails, StatusDot } from "./SessionHeader";
import {
   branchOf,
   DEFAULT_VIEW,
   type Display,
   folderName,
   type GroupBy,
   groupSessions,
   highlight,
   matches,
   refTitle,
   relativeTime,
   type SortBy,
   type ViewOptions,
   viewChanges,
} from "./sessionGroups";
import { useStored } from "./useStored";

const oneOf =
   <T extends string>(...opts: T[]) =>
   (v: unknown): v is T =>
      opts.includes(v as T);
const strings = (v: unknown): v is string[] =>
   Array.isArray(v) && v.every((x) => typeof x === "string");

/** One row's detail line: folder, then branch / Worktree / PR, then the last activity. */
function DetailLine({
   s,
   showFolder,
   now,
}: {
   s: SessionSummary;
   showFolder: boolean;
   now: number;
}) {
   const ws = s.workspace;
   const branch = branchOf(ws);
   const draft = useSessionHasDraft(s.id);
   return (
      <span className="flex w-full items-center gap-2 text-xs font-normal text-muted-foreground/70">
         <span className="flex min-w-0 flex-1 items-center gap-2.5 overflow-hidden">
            {showFolder && (
               <span className="flex shrink-0 items-center gap-1">
                  {s.quick ? (
                     <Zap className="size-3 shrink-0" />
                  ) : (
                     <Folder className="size-3 shrink-0" />
                  )}
                  <span className="whitespace-nowrap">
                     {s.quick ? "Quick" : folderName(s.folder)}
                  </span>
               </span>
            )}
            {(branch || ws.pr != null) && (
               <span title={refTitle(ws)} className="flex min-w-0 items-center gap-1">
                  {ws.worktree_branch ? (
                     <GitFork className="size-3 shrink-0" aria-label="Worktree" />
                  ) : (
                     ws.pr == null && <GitBranch className="size-3 shrink-0" aria-label="Branch" />
                  )}
                  {ws.pr != null ? (
                     <span className="flex shrink-0 items-center gap-0.5 text-emerald-600 dark:text-emerald-400">
                        <GitPullRequest className="size-3 shrink-0" aria-label="Pull request" />#
                        {ws.pr}
                     </span>
                  ) : (
                     <span className="truncate">{branch}</span>
                  )}
               </span>
            )}
         </span>
         {draft && <Pencil className="size-[9px] shrink-0" aria-label="Unsent draft" />}
         <span className="shrink-0 tabular-nums">{relativeTime(s.updated_ms, now)}</span>
      </span>
   );
}

function SessionRow({
   s,
   selected,
   display,
   query,
   showFolder,
   now,
   onSelect,
   onArchive,
   onDelete,
}: {
   s: SessionSummary;
   selected: boolean;
   display: Display;
   /** Lowercased search, highlighted in the title. */
   query: string;
   showFolder: boolean;
   now: number;
   onSelect: () => void;
   onArchive: () => void;
   onDelete: () => void;
}) {
   const [menu, setMenu] = useState(false);
   const item =
      "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground";
   const hit = highlight(s.title, query);
   // Detail rows with nothing but a date (no folder shown, no git ref) stay one line, the date next to the title.
   const sub =
      display === "detail" && (showFolder || !!branchOf(s.workspace) || s.workspace.pr != null);
   const inlineDate = display === "detail" && !sub;
   return (
      <li
         className="group relative"
         onContextMenu={(e) => {
            e.preventDefault();
            setMenu(true);
         }}
      >
         <Tooltip
            side="right"
            align="start"
            delay={700}
            className="w-80 max-w-80 p-3 text-xs"
            content={
               <>
                  <div className="mb-2 text-sm font-semibold">{s.title}</div>
                  <SessionDetails s={s} />
               </>
            }
         >
            <button
               onClick={onSelect}
               aria-current={selected || undefined}
               className={cn(
                  "flex w-full rounded-md px-2.5 text-left text-sm text-foreground/80 hover:bg-accent/60 hover:text-accent-foreground",
                  // Detail: only the title line makes room for the menu button, so the date stays put.
                  sub
                     ? "min-h-12 flex-col justify-center gap-0.5 py-1.5"
                     : "h-8 items-center transition-[padding] group-hover:pr-8 group-has-focus-visible:pr-8",
                  selected &&
                     "bg-accent font-medium text-accent-foreground hover:bg-accent hover:text-accent-foreground",
                  s.archived && "opacity-70",
               )}
            >
               <span
                  className={cn(
                     "flex w-full items-center gap-2",
                     sub && "transition-[padding] group-hover:pr-6 group-has-focus-visible:pr-6",
                  )}
               >
                  <span className="min-w-0 flex-1 truncate">
                     {hit ? (
                        <>
                           {hit[0]}
                           <mark className="rounded-sm bg-sky-400/30 text-foreground">
                              {hit[1]}
                           </mark>
                           {hit[2]}
                        </>
                     ) : (
                        s.title
                     )}
                  </span>
                  <StatusDot status={s.status} className="group-hover:hidden" />
                  {inlineDate && (
                     <span className="shrink-0 text-xs tabular-nums text-muted-foreground/70">
                        {relativeTime(s.updated_ms, now)}
                     </span>
                  )}
               </span>
               {sub && <DetailLine s={s} showFolder={showFolder} now={now} />}
            </button>
         </Tooltip>
         <button
            aria-label="Session menu"
            className="absolute right-1 top-1 translate-x-1 rounded p-1 text-muted-foreground opacity-0 transition hover:bg-background group-hover:translate-x-0 group-hover:opacity-100 group-has-focus-visible:translate-x-0 group-has-focus-visible:opacity-100"
            onClick={() => setMenu(!menu)}
         >
            <MoreHorizontal className="size-4" />
         </button>
         {menu && (
            <>
               <div
                  className="fixed inset-0 z-10"
                  onClick={() => setMenu(false)}
                  onContextMenu={(e) => {
                     e.preventDefault();
                     setMenu(false);
                  }}
               />
               <div
                  role="menu"
                  className="absolute right-1 top-8 z-20 w-36 rounded-md border bg-popover p-1 shadow-md"
               >
                  <button
                     role="menuitem"
                     className={item}
                     onClick={() => {
                        setMenu(false);
                        onArchive();
                     }}
                  >
                     {s.archived ? (
                        <ArchiveRestore className="size-4" />
                     ) : (
                        <Archive className="size-4" />
                     )}
                     {s.archived ? "Unarchive" : "Archive"}
                  </button>
                  <button
                     role="menuitem"
                     className={cn(item, "text-destructive")}
                     onClick={() => {
                        setMenu(false);
                        onDelete();
                     }}
                  >
                     <Trash2 className="size-4" /> Delete
                  </button>
               </div>
            </>
         )}
      </li>
   );
}

const OPTIONS: { key: keyof ViewOptions; label: string; opts: [string, string][] }[] = [
   {
      key: "sort",
      label: "SORT BY",
      opts: [
         ["recent", "Recent activity"],
         ["created", "Created"],
      ],
   },
   {
      key: "display",
      label: "DISPLAY",
      opts: [
         ["condensed", "Condensed"],
         ["detail", "Detail"],
      ],
   },
   {
      key: "group",
      label: "GROUP BY",
      opts: [
         ["none", "None"],
         ["folder", "Folder"],
         ["date", "Date"],
      ],
   },
];

/** Sort, display and grouping, in the style of the Session Log's filter popover. */
function ViewOptionsButton({
   view,
   onChange,
}: {
   view: ViewOptions;
   onChange: (v: Partial<ViewOptions>) => void;
}) {
   const changed = viewChanges(view);
   return (
      <Popover>
         <Tooltip content="View options" side="bottom">
            <PopoverTrigger
               aria-label={changed ? `View options, ${changed} changed` : "View options"}
               className={cn(
                  "grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground data-[state=open]:bg-accent [&_svg]:size-4",
                  changed > 0 && "bg-accent text-accent-foreground",
               )}
            >
               <ListFilter />
            </PopoverTrigger>
         </Tooltip>
         <PopoverContent
            align="end"
            className="w-64 p-0 text-[13px]"
            onOpenAutoFocus={(e) => e.preventDefault()}
         >
            <ScrollArea
               className="max-h-[min(32rem,var(--radix-popover-content-available-height))]"
               viewportClassName="max-h-[inherit] p-1"
            >
               {OPTIONS.map((o, i) => (
                  <div key={o.key}>
                     {i > 0 && <div className="my-1 h-px bg-border" />}
                     <div className="flex items-center justify-between px-2 pt-1 pb-1">
                        <span className="text-[11px] font-semibold tracking-wide text-muted-foreground">
                           {o.label}
                        </span>
                        {i === 0 && (
                           <button
                              className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-40"
                              disabled={!changed}
                              onClick={() => onChange(DEFAULT_VIEW)}
                           >
                              Reset
                           </button>
                        )}
                     </div>
                     {o.opts.map(([value, label]) => (
                        <button
                           key={value}
                           aria-pressed={view[o.key] === value}
                           onClick={() => onChange({ [o.key]: value })}
                           className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-accent hover:text-accent-foreground"
                        >
                           <span className="flex w-3.5 shrink-0">
                              {view[o.key] === value && <Check className="size-3.5" />}
                           </span>
                           {label}
                        </button>
                     ))}
                  </div>
               ))}
            </ScrollArea>
         </PopoverContent>
      </Popover>
   );
}

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
   onNewInFolder,
   onNewQuick,
   children,
}: {
   sessions: SessionSummary[];
   selected: string | null;
   onSelect: (id: string) => void;
   onArchive: (s: SessionSummary) => void;
   onDelete: (s: SessionSummary) => void;
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
   const [archivedOpen, setArchivedOpen] = useState(false);
   const view: ViewOptions = { sort, display, group };
   const setView = (v: Partial<ViewOptions>) => {
      if (v.sort) setSort(v.sort);
      if (v.display) setDisplay(v.display);
      if (v.group) setGroup(v.group);
   };

   const q = query.trim().toLowerCase();
   const now = Date.now();
   // While searching, groups flatten into one list.
   const groups = useMemo(
      () =>
         groupSessions(
            sessions.filter((s) => !s.archived && matches(s, q)),
            { sort, group: q ? "none" : group },
         ),
      [sessions, q, sort, group],
   );
   const archived = sessions.filter((s) => s.archived && matches(s, q));
   const empty = q !== "" && groups.every((g) => g.sessions.length === 0) && archived.length === 0;
   const toggle = (id: string) =>
      setCollapsed(collapsed.includes(id) ? collapsed.filter((c) => c !== id) : [...collapsed, id]);

   const row = (s: SessionSummary) => (
      <SessionRow
         key={s.id}
         s={s}
         selected={s.id === selected}
         display={display}
         query={q}
         showFolder={group !== "folder" || q !== ""}
         now={now}
         onSelect={() => onSelect(s.id)}
         onArchive={() => onArchive(s)}
         onDelete={() => onDelete(s)}
      />
   );

   return (
      <>
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
                     <div key={g.id} className={cn("flex flex-col", open && "mb-4.5 last:mb-0")}>
                        {g.id !== "all" && (
                           <div className="group/hdr relative flex items-center">
                              <button
                                 aria-expanded={open}
                                 onClick={() => toggle(g.id)}
                                 className={cn(
                                    "flex h-7 w-full items-center gap-1.5 rounded-md px-1.5 text-left text-xs font-medium text-muted-foreground transition-[padding] hover:text-foreground group-hover/hdr:pr-7 group-has-focus-visible/hdr:pr-7",
                                    g.quick && "pr-7",
                                 )}
                              >
                                 {g.folder && <Folder className="size-3.25 shrink-0" />}
                                 {g.quick && <Zap className="size-3.25 shrink-0" />}
                                 <span className="min-w-0 truncate text-foreground/75 group-hover/hdr:text-foreground">
                                    {g.label}
                                 </span>
                                 <span className="shrink-0 tabular-nums">{g.sessions.length}</span>
                                 <ChevronRight
                                    className={cn(
                                       "size-3 shrink-0 transition-transform",
                                       open && "rotate-90",
                                    )}
                                 />
                              </button>
                              {g.folder && onNewInFolder && g.sessions[0] && (
                                 <button
                                    aria-label={`New Session in ${g.label}`}
                                    onClick={() =>
                                       onNewInFolder(
                                          g.sessions[0]!.workspace.source_folder ||
                                             g.sessions[0]!.folder,
                                       )
                                    }
                                    className="absolute right-1 grid size-5 place-items-center rounded text-muted-foreground opacity-0 transition hover:bg-accent hover:text-accent-foreground group-hover/hdr:opacity-100 group-has-focus-visible/hdr:opacity-100 focus-visible:opacity-100"
                                 >
                                    <Plus className="size-3.5" />
                                 </button>
                              )}
                              {g.quick && onNewQuick && (
                                 <button
                                    aria-label="New Quick Session"
                                    onClick={() => {
                                       if (!open) toggle(g.id);
                                       onNewQuick();
                                    }}
                                    className="absolute right-1 grid size-5 place-items-center rounded text-muted-foreground transition hover:bg-accent hover:text-accent-foreground"
                                 >
                                    <Plus className="size-3.5" />
                                 </button>
                              )}
                           </div>
                        )}
                        {open && <ul className="flex flex-col gap-px">{g.sessions.map(row)}</ul>}
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
                  {archivedOpen && <ul className="flex flex-col gap-px">{archived.map(row)}</ul>}
               </div>
            )}
            {children}
         </ScrollArea>
      </>
   );
}
