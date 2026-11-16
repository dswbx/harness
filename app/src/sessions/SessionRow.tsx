import {
   baseName,
   formatAge,
   type SessionStatus,
   type SessionSummary,
   useSessionHasDraft,
} from "@harness/api";
import { cn, Tooltip } from "@harness/ui";
import {
   AppWindow,
   Archive,
   ArchiveRestore,
   ChevronDown,
   Folder,
   GitBranch,
   GitFork,
   GitPullRequest as GitPullRequestIcon,
   MoreHorizontal,
   Pencil,
   Trash2,
   Zap,
} from "lucide-react";
import { useState } from "react";
import { prStyle } from "./prStyle";
import { SessionDetails } from "./SessionDetails";
import { StatusDot } from "./StatusDot";
import { branchOf, type Display, highlight } from "./sessionGroups";

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
   // Before the first lookup the PR's state is unknown: shown neutral.
   const pr = ws.pr_state ? prStyle(ws.pr_state, ws.pr_checks) : null;
   const PrIcon = pr?.icon ?? GitPullRequestIcon;
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
                     {s.quick ? "Quick" : baseName(s.folder)}
                  </span>
               </span>
            )}
            {(branch || ws.pr != null) && (
               <span className="flex min-w-0 items-center gap-1">
                  {ws.worktree_branch ? (
                     <GitFork className="size-3 shrink-0" aria-label="Worktree" />
                  ) : (
                     ws.pr == null && <GitBranch className="size-3 shrink-0" aria-label="Branch" />
                  )}
                  {ws.pr != null ? (
                     <span className={cn("flex shrink-0 items-center gap-0.5", pr?.cls)}>
                        <PrIcon
                           className="size-3 shrink-0"
                           aria-label={pr ? `Pull request: ${pr.label}` : "Pull request"}
                        />
                        #{ws.pr}
                     </span>
                  ) : (
                     <span className="truncate">{branch}</span>
                  )}
               </span>
            )}
         </span>
         {draft && <Pencil className="size-[9px] shrink-0" aria-label="Unsent draft" />}
         <span className="shrink-0 tabular-nums">{formatAge(s.updated_ms, now)}</span>
      </span>
   );
}

/** A parent row's Sub Session count and the caret that shows or hides them. */
export type SubToggle = { count: number; open: boolean; onToggle: () => void };

export function SessionRow({
   s,
   status = s.status,
   unseen = s.unseen,
   parent,
   sub: subToggle,
   selected,
   display,
   query,
   showFolder,
   now,
   onSelect,
   onArchive,
   onDelete,
   onOpenWindow,
}: {
   s: SessionSummary;
   /** The dot's status; a collapsed parent shows its Sub Sessions'. */
   status?: SessionStatus;
   /** A Turn ended that nobody looked at; a collapsed parent also shows its Sub Sessions'. */
   unseen?: boolean;
   /** The parent of a Sub Session, for the hover card. */
   parent?: SessionSummary;
   sub?: SubToggle;
   selected: boolean;
   display: Display;
   /** Lowercased search, highlighted in the title. */
   query: string;
   showFolder: boolean;
   now: number;
   onSelect: () => void;
   onArchive: () => void;
   onDelete: () => void;
   onOpenWindow?: () => void;
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
            className="w-80 max-w-80 p-3 text-xs"
            content={
               <>
                  <div className="mb-2 text-sm font-semibold">{s.title}</div>
                  <SessionDetails s={s} parent={parent} />
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
                  <span
                     className={cn(
                        "min-w-0 truncate",
                        !subToggle && "flex-1",
                        unseen && "font-semibold text-foreground",
                     )}
                  >
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
                     {unseen && <span className="sr-only"> (new, not seen)</span>}
                  </span>
                  {subToggle && (
                     <>
                        <span className="shrink-0 text-xs font-normal tabular-nums text-muted-foreground/70">
                           {subToggle.count}
                        </span>
                        {/* A span: a button may not hold another button. */}
                        <span
                           role="button"
                           tabIndex={0}
                           aria-expanded={subToggle.open}
                           aria-label={subToggle.open ? "Hide sub sessions" : "Show sub sessions"}
                           onClick={(e) => {
                              e.stopPropagation();
                              subToggle.onToggle();
                           }}
                           onKeyDown={(e) => {
                              if (e.key !== "Enter" && e.key !== " ") return;
                              e.preventDefault();
                              e.stopPropagation();
                              subToggle.onToggle();
                           }}
                           className="-ml-1 grid size-4 shrink-0 place-items-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
                        >
                           <ChevronDown
                              className={cn(
                                 "size-3 transition-transform",
                                 !subToggle.open && "-rotate-90",
                              )}
                           />
                        </span>
                        <span className="flex-1" />
                     </>
                  )}
                  <StatusDot status={status} className="group-hover:hidden" />
                  {inlineDate && (
                     <span className="shrink-0 text-xs tabular-nums text-muted-foreground/70">
                        {formatAge(s.updated_ms, now)}
                     </span>
                  )}
               </span>
               {sub && <DetailLine s={s} showFolder={showFolder} now={now} />}
            </button>
         </Tooltip>
         {/* Flush with the sidebar's right border: through the list's px-2. */}
         {unseen && (
            <span
               aria-hidden
               className="pointer-events-none absolute -right-2 top-[7px] bottom-[7px] w-[3px] rounded-l-[2px] bg-foreground"
            />
         )}
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
                  className="absolute right-1 top-8 z-20 w-48 rounded-md border bg-popover p-1 shadow-md"
               >
                  {onOpenWindow && (
                     <button
                        role="menuitem"
                        className={item}
                        onClick={() => {
                           setMenu(false);
                           onOpenWindow();
                        }}
                     >
                        <AppWindow className="size-4" /> Open in new window
                     </button>
                  )}
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
