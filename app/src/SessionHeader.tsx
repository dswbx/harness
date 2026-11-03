import type {
   Editor,
   GitStatus,
   HarnessClient,
   PrInfo,
   RepoId,
   SessionStatus,
   SessionSummary,
} from "@harness/api";
import { inTauri } from "@harness/api";
import {
   Button,
   cn,
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuSeparator,
   DropdownMenuShortcut,
   DropdownMenuTrigger,
   Tooltip,
} from "@harness/ui";
import {
   AppWindow,
   ArrowDown,
   ArrowUp,
   Code,
   Copy,
   FolderOpen,
   GitBranch,
   GitMerge,
   GitPullRequest,
   GitPullRequestClosed,
   GitPullRequestDraft,
   Info,
   MoreHorizontal,
   RefreshCw,
   Settings,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { openExternal } from "./openExternal";
import { useReportError } from "./toast";

/** The Session's git ref as the header shows it (see App's `useGitRef`). */
export type GitRef = {
   /** Null outside a repository or until loaded. */
   status: GitStatus | null;
   /** The GitHub repo of the folder, when it has one. */
   repo: RepoId | null;
   /** The PR the Session works on, when there is one. */
   pr: PrInfo | null;
   refresh: () => void;
};

const PR_STYLE: Record<
   PrInfo["state"],
   { icon: typeof GitPullRequest; cls: string; label: string }
> = {
   open: { icon: GitPullRequest, cls: "text-emerald-600 dark:text-emerald-400", label: "Open" },
   draft: { icon: GitPullRequestDraft, cls: "text-muted-foreground", label: "Draft" },
   merged: { icon: GitMerge, cls: "text-violet-600 dark:text-violet-400", label: "Merged" },
   closed: { icon: GitPullRequestClosed, cls: "text-red-600 dark:text-red-400", label: "Closed" },
};

const CHECKS_LABEL: Record<PrInfo["checks"], string> = {
   passing: "checks passing",
   failing: "checks failing",
   pending: "checks running",
   none: "no checks",
};

const refBtn =
   "flex h-7 max-w-72 min-w-0 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground [&_svg]:size-3.5 [&_svg]:shrink-0";

/**
 * Branch or PR of the Session, right of the title: opens it on GitHub. A branch behind its upstream
 * shows ↓n, a click fast-forwards it; ahead shows ↑n.
 */
function GitRefButton({
   client,
   session,
   git,
}: {
   client: HarnessClient;
   session: SessionSummary;
   git: GitRef;
}) {
   const report = useReportError();
   const [updating, setUpdating] = useState(false);
   const { status, repo, pr } = git;
   const branch = status?.branch ?? null;
   if (!status && !pr) return null;

   const update = () => {
      if (!branch) return;
      setUpdating(true);
      client
         .updateBranch(session.folder, branch)
         .then(git.refresh, (e) => report(`Could not update ${branch}`, e))
         .finally(() => setUpdating(false));
   };

   const counts = status && (status.ahead > 0 || status.behind > 0) && (
      <span className="flex shrink-0 items-center gap-1 tabular-nums">
         {status.ahead > 0 && (
            <Tooltip
               side="bottom"
               content={`${status.ahead} ${status.ahead === 1 ? "commit" : "commits"} not pushed`}
            >
               <span className="flex items-center text-muted-foreground">
                  <ArrowUp className="size-3" />
                  {status.ahead}
               </span>
            </Tooltip>
         )}
         {status.behind > 0 && (
            <Tooltip
               side="bottom"
               content={`${status.behind} ${status.behind === 1 ? "commit" : "commits"} behind ${status.upstream ?? "upstream"} · click to fast-forward`}
            >
               <button
                  aria-label={`Update ${branch}: ${status.behind} behind`}
                  disabled={updating}
                  onClick={update}
                  className="flex h-5 items-center rounded px-1 text-amber-600 hover:bg-amber-500/15 disabled:opacity-60 dark:text-amber-400"
               >
                  {updating ? <RefreshCw className="size-3 animate-spin" /> : <ArrowDown />}
                  {status.behind}
               </button>
            </Tooltip>
         )}
      </span>
   );

   if (pr) {
      const st = PR_STYLE[pr.state];
      const Icon = st.icon;
      const checks =
         pr.checks_total > 0
            ? `${pr.checks_passed}/${pr.checks_total} ${CHECKS_LABEL[pr.checks]}`
            : CHECKS_LABEL[pr.checks];
      return (
         <span className="flex min-w-0 items-center gap-0.5">
            <Tooltip
               side="bottom"
               className="max-w-80"
               content={
                  <div className="flex flex-col gap-0.5">
                     <span className="font-medium">
                        #{pr.number} {pr.title}
                     </span>
                     <span className="text-muted-foreground">
                        {st.label} · {checks}
                        {branch ? ` · ${branch}` : ""}
                     </span>
                     <span className="text-muted-foreground">Opens on GitHub</span>
                  </div>
               }
            >
               <a
                  href={pr.url}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => openExternal(e, pr.url)}
                  aria-label={`Pull request #${pr.number}, ${st.label}, ${checks}; opens on GitHub`}
                  className={refBtn}
               >
                  <Icon className={st.cls} />
                  <span className="shrink-0 font-medium text-foreground/90">#{pr.number}</span>
                  <span className="min-w-0 truncate">{pr.title}</span>
                  {pr.checks_total > 0 && (
                     <span
                        aria-hidden
                        className={cn(
                           "size-1.5 shrink-0 rounded-full",
                           {
                              passing: "bg-emerald-500",
                              failing: "bg-red-500",
                              pending: "bg-amber-500",
                              none: "bg-muted-foreground/40",
                           }[pr.checks],
                        )}
                     />
                  )}
               </a>
            </Tooltip>
            {counts}
         </span>
      );
   }

   if (!branch) return null;
   const url = repo ? `https://github.com/${repo.owner}/${repo.name}/tree/${branch}` : null;
   const label = (
      <>
         <GitBranch />
         <span className="min-w-0 truncate font-mono">{branch}</span>
      </>
   );
   return (
      <span className="flex min-w-0 items-center gap-0.5">
         {url ? (
            <Tooltip side="bottom" content={`Branch ${branch} · opens on GitHub`}>
               <a
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => openExternal(e, url)}
                  aria-label={`Branch ${branch}; opens on GitHub`}
                  className={refBtn}
               >
                  {label}
               </a>
            </Tooltip>
         ) : (
            <Tooltip side="bottom" content={`Branch ${branch}`}>
               <span className={cn(refBtn, "hover:bg-transparent hover:text-muted-foreground")}>
                  {label}
               </span>
            </Tooltip>
         )}
         {counts}
      </span>
   );
}

/** Room for the macOS traffic lights (overlay title bar, `trafficLightPosition` in tauri.conf.json: y centers them in the 52px header). */
export const trafficLights = inTauri();

const statusLabel: Record<SessionStatus, string> = {
   idle: "Idle",
   working: "Working",
   needs_attention: "Needs attention",
};

export function StatusDot({ status, className }: { status: SessionStatus; className?: string }) {
   if (status === "idle") return null;
   return (
      <span
         aria-label={statusLabel[status]}
         className={cn(
            "size-2 shrink-0 rounded-full",
            status === "working" ? "animate-pulse bg-sky-500" : "bg-amber-500",
            className,
         )}
      />
   );
}

/** Folder, Worktree, Agent and timing of a Session: the sidebar hover card and the header's info popover. */
export function SessionDetails({ s }: { s: SessionSummary }) {
   const ws = s.workspace;
   const row = (label: string, value: ReactNode, mono = false) => (
      <>
         <dt className="text-muted-foreground">{label}</dt>
         <dd className={cn("min-w-0 break-words", mono && "font-mono text-[0.92em]")}>{value}</dd>
      </>
   );
   return (
      <div className="flex flex-col gap-2.5">
         <div className="flex items-center gap-2">
            <StatusDot status={s.status} />
            <span className="text-muted-foreground">
               {statusLabel[s.status]}
               {s.archived ? " · archived" : ""}
            </span>
         </div>
         <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5">
            {row("Folder", s.folder, true)}
            {row(
               "Worktree",
               ws.worktree_branch
                  ? `${ws.worktree_branch} (from ${ws.base_branch ?? "?"})`
                  : "None, works in folder",
               !!ws.worktree_branch,
            )}
            {!ws.repo_root && row("Git", "Not a git repository")}
            {row("Agent", s.agent_id)}
            {row("Frontend", s.frontend_id)}
            {row(
               "Started",
               new Date(s.created_ms).toLocaleString(undefined, {
                  dateStyle: "medium",
                  timeStyle: "short",
               }),
            )}
         </dl>
      </div>
   );
}

/** Menu label of an editor. */
export const editorName = (e: Editor): string =>
   ({
      vscode: "VS Code",
      cursor: "Cursor",
      windsurf: "Windsurf",
      zed: "Zed",
      custom: "your editor",
      system: "the default app",
   })[e.type];

const iconBtn =
   "size-7 text-muted-foreground hover:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground";

/**
 * The one header above a Session's View: title, info popover, actions menu, and a slot the Frontend
 * fills with its own actions (`toolbarRef`), and one after the title for its state badges (`statusRef`). At the
 * far right a gear menu: Settings, and entries the Frontend adds to `menuRef` (it exists while the menu is open).
 * `leading` sits left of the title (traffic lights, sidebar toggle).
 */
export function SessionHeader({
   client,
   session,
   git,
   leading,
   onOpenWindow,
   onChooseEditor,
   toolbarRef,
   statusRef,
   menuRef,
   onOpenSettings,
}: {
   client: HarnessClient;
   session: SessionSummary;
   /** Branch, counts and PR; none outside a repository. */
   git?: GitRef;
   leading?: ReactNode;
   onOpenWindow?: () => void;
   /** Opens Settings at the editor choice (no editor chosen yet). */
   onChooseEditor?: () => void;
   toolbarRef: (el: HTMLDivElement | null) => void;
   statusRef?: (el: HTMLDivElement | null) => void;
   menuRef?: (el: HTMLDivElement | null) => void;
   /** Opens Settings; without it the gear menu has no Settings entry. */
   onOpenSettings?: () => void;
}) {
   const report = useReportError();
   const reveal = () =>
      import("@tauri-apps/plugin-opener")
         .then(({ revealItemInDir }) => revealItemInDir(session.folder))
         .catch((e) => report("Could not reveal folder", e));
   const copy = () =>
      navigator.clipboard.writeText(session.folder).catch((e) => report("Could not copy path", e));
   // Read when the menu opens, so a change in Settings shows at once.
   const [editor, setEditor] = useState<Editor | null | undefined>(undefined);
   const loadEditor = (open: boolean) =>
      open && void client.getEditor().then(setEditor, () => setEditor(null));
   // The Frontend's entries are portaled in from another React tree, so the menu cannot see their clicks: close on a native one.
   const [gearOpen, setGearOpen] = useState(false);
   const [gearItems, setGearItems] = useState<HTMLDivElement | null>(null);
   const gearItemsRef = useCallback(
      (el: HTMLDivElement | null) => {
         setGearItems(el);
         menuRef?.(el);
      },
      [menuRef],
   );
   useEffect(() => {
      if (!gearItems) return;
      const onClick = (e: MouseEvent) =>
         (e.target as Element).closest("[data-menu-close]") && setGearOpen(false);
      gearItems.addEventListener("click", onClick);
      return () => gearItems.removeEventListener("click", onClick);
   }, [gearItems]);
   const openInEditor = () =>
      editor
         ? client.openInEditor(session.id).catch((e) => report("Could not open the editor", e))
         : onChooseEditor?.();
   return (
      <header
         data-tauri-drag-region
         className="flex h-13 shrink-0 items-center gap-1 border-b pl-4 pr-1.5"
      >
         {leading}
         {/* Not a drag region, so the title can be selected and copied. */}
         <h1 className="mr-1 min-w-0 cursor-text select-text truncate text-sm font-semibold">
            {session.title}
         </h1>
         <DropdownMenu>
            <DropdownMenuTrigger asChild>
               <Tooltip content="Session info" side="bottom">
                  <Button size="icon" variant="ghost" className={iconBtn} aria-label="Session info">
                     <Info />
                  </Button>
               </Tooltip>
            </DropdownMenuTrigger>
            <DropdownMenuContent
               align="start"
               className="w-96 p-3 text-sm"
               onCloseAutoFocus={(e) => e.preventDefault()}
            >
               <SessionDetails s={session} />
            </DropdownMenuContent>
         </DropdownMenu>
         <DropdownMenu onOpenChange={loadEditor}>
            <DropdownMenuTrigger asChild>
               <Tooltip content="Session actions" side="bottom">
                  <Button
                     size="icon"
                     variant="ghost"
                     className={iconBtn}
                     aria-label="Session actions"
                  >
                     <MoreHorizontal />
                  </Button>
               </Tooltip>
            </DropdownMenuTrigger>
            <DropdownMenuContent
               align="start"
               className="w-56"
               onCloseAutoFocus={(e) => e.preventDefault()}
            >
               {onOpenWindow && (
                  <>
                     <DropdownMenuItem onSelect={onOpenWindow}>
                        <AppWindow /> Open in new window
                     </DropdownMenuItem>
                     <DropdownMenuSeparator />
                  </>
               )}
               {(editor || onChooseEditor) && (
                  <DropdownMenuItem onSelect={() => void openInEditor()}>
                     <Code /> {editor ? `Open in ${editorName(editor)}` : "Open in editor…"}
                  </DropdownMenuItem>
               )}
               <DropdownMenuItem onSelect={() => void copy()}>
                  <Copy /> Copy path
               </DropdownMenuItem>
               {inTauri() && (
                  <DropdownMenuItem onSelect={() => void reveal()}>
                     <FolderOpen /> Reveal in Finder
                  </DropdownMenuItem>
               )}
            </DropdownMenuContent>
         </DropdownMenu>
         <div ref={statusRef} className="flex min-w-0 items-center gap-1 empty:hidden" />
         <div data-tauri-drag-region className="h-full min-w-4 flex-1" />
         {git && <GitRefButton client={client} session={session} git={git} />}
         <div ref={toolbarRef} className="flex items-center gap-1" />
         <DropdownMenu open={gearOpen} onOpenChange={setGearOpen}>
            <DropdownMenuTrigger asChild>
               <Tooltip content="Layout and settings" side="bottom">
                  <Button
                     size="icon"
                     variant="ghost"
                     className={iconBtn}
                     aria-label="Layout and settings"
                  >
                     <Settings />
                  </Button>
               </Tooltip>
            </DropdownMenuTrigger>
            <DropdownMenuContent
               align="end"
               className="w-56"
               onCloseAutoFocus={(e) => e.preventDefault()}
            >
               <div ref={gearItemsRef} className="peer flex flex-col empty:hidden" />
               {onOpenSettings && (
                  <>
                     <DropdownMenuSeparator className="hidden peer-[:not(:empty)]:block" />
                     <DropdownMenuItem onSelect={onOpenSettings}>
                        <Settings /> Settings… <DropdownMenuShortcut>⌘,</DropdownMenuShortcut>
                     </DropdownMenuItem>
                  </>
               )}
            </DropdownMenuContent>
         </DropdownMenu>
      </header>
   );
}
