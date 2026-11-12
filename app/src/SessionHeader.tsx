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
   ArrowRight,
   ArrowUp,
   Check,
   Clock,
   Code,
   Copy,
   ExternalLink,
   FolderOpen,
   GitBranch,
   GitMerge,
   GitPullRequest,
   GitPullRequestClosed,
   GitPullRequestDraft,
   Info,
   Loader2,
   MoreHorizontal,
   Plus,
   RefreshCw,
   Settings,
   X,
   Zap,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useReportError } from "./toast";

/** The Session's git ref as the header shows it (see App's `useGitRef`). */
export type GitRef = {
   /** Null outside a repository or until loaded. */
   status: GitStatus | null;
   /** The GitHub repo of the folder, when it has one. */
   repo: RepoId | null;
   /** The PR the Session works on, when there is one. */
   pr: PrInfo | null;
   /** Where the branch merges to: the Worktree's base, else the PR's, else the default branch. */
   base: string | null;
   refresh: () => void;
   /** A refresh asked for by the user is loading. */
   refreshing: boolean;
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

/** How a PR shows: its state's icon and color; an open PR with failing checks is red. */
export function prStyle(state: PrInfo["state"], checks?: PrInfo["checks"] | null) {
   const st = PR_STYLE[state];
   return state === "open" && checks === "failing"
      ? { ...st, cls: "text-red-600 dark:text-red-400", label: "Checks failing" }
      : st;
}

const CHECKS: Record<PrInfo["checks"], { icon: typeof Check; cls: string; label: string } | null> =
   {
      passing: {
         icon: Check,
         cls: "text-emerald-600 dark:text-emerald-400",
         label: "checks passing",
      },
      failing: { icon: X, cls: "text-red-600 dark:text-red-400", label: "checks failing" },
      pending: { icon: Clock, cls: "text-amber-600 dark:text-amber-400", label: "checks running" },
      none: null,
   };

/** A git action the header runs itself (no Agent turn), shown as a spinner on the count it will change. */
type Working = "pull" | "push";

const Count = ({
   n,
   dir,
   busy,
   className,
}: {
   n: number;
   dir: "up" | "down";
   busy: boolean;
   className: string;
}) => (
   <span className={cn("flex items-center gap-px tabular-nums", className)}>
      {busy ? (
         <Loader2 className="size-[11px] animate-spin" />
      ) : dir === "up" ? (
         <ArrowUp className="size-[11px]" />
      ) : (
         <ArrowDown className="size-[11px]" />
      )}
      {n}
   </span>
);

/**
 * The Session's git ref, right of the title: one pill (PR number with checks, else the branch, then
 * ↑unpushed ↓behind) that opens a menu: the PR, branch → where it merges to, open on GitHub,
 * fast-forward, push, copy. Actions run in the core, never through the Agent; the count they change
 * spins meanwhile, failures toast.
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
   const [working, setWorking] = useState<Working | null>(null);
   const { status, repo, pr, base } = git;
   const branch = status?.branch ?? null;
   if (!status && !pr) return null;
   const ahead = status?.ahead ?? 0;
   const behind = status?.behind ?? 0;
   const done = pr?.state === "merged" || pr?.state === "closed";
   const checks = pr && pr.checks_total > 0 ? CHECKS[pr.checks] : null;
   const st = pr && PR_STYLE[pr.state];
   const Icon = st ? st.icon : GitBranch;

   const run = (what: Working, p: Promise<unknown>, failed: string) => {
      setWorking(what);
      p.then(git.refresh, (e) => report(failed, e)).finally(() => setWorking(null));
   };
   const pull = () =>
      branch &&
      run("pull", client.updateBranch(session.folder, branch), `Could not fast-forward ${branch}`);
   const push = () =>
      run(
         "push",
         client.sessionApi(session.id).gitPush(),
         `Could not push ${branch ?? "the branch"}`,
      );
   const copy = (text: string, what: string) =>
      navigator.clipboard.writeText(text).catch((e) => report(`Could not copy ${what}`, e));
   const open = (url: string) =>
      inTauri()
         ? import("@tauri-apps/plugin-opener")
              .then(({ openUrl }) => openUrl(url))
              .catch((e) => report("Could not open the browser", e))
         : void window.open(url, "_blank", "noopener");
   const branchUrl =
      repo && branch ? `https://github.com/${repo.owner}/${repo.name}/tree/${branch}` : null;
   /** On the base itself (main in the folder): nothing to merge, no PR to create. */
   const onBase = !!branch && branch === base;
   const compareUrl =
      repo && branch && base && !onBase
         ? `https://github.com/${repo.owner}/${repo.name}/compare/${base}...${branch}?expand=1`
         : null;
   const n = (k: number, one: string) => `${k} ${k === 1 ? one : `${one}s`}`;

   const label = [
      pr ? `Pull request #${pr.number}, ${st?.label}` : `Branch ${branch}`,
      checks && pr ? `${pr.checks_passed} of ${pr.checks_total} ${checks.label}` : "",
      ahead ? `${ahead} unpushed` : "",
      behind ? `${behind} behind` : "",
   ]
      .filter(Boolean)
      .join(", ");

   return (
      <DropdownMenu>
         <DropdownMenuTrigger asChild>
            <button
               aria-label={label}
               disabled={working !== null || git.refreshing}
               className={cn(
                  "flex h-7 max-w-80 min-w-0 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-accent data-[state=open]:text-accent-foreground disabled:cursor-progress disabled:opacity-70",
               )}
            >
               <Icon className={cn("size-3.5 shrink-0", st?.cls)} />
               {pr ? (
                  <span className="shrink-0 font-medium text-foreground/90">#{pr.number}</span>
               ) : (
                  <span className="min-w-0 truncate font-mono text-foreground/90">{branch}</span>
               )}
               {checks && pr && (
                  <span className={cn("flex items-center gap-0.5 tabular-nums", checks.cls)}>
                     <checks.icon className="size-[11px]" />
                     {pr.checks_passed}/{pr.checks_total}
                  </span>
               )}
               {!done && (ahead > 0 || behind > 0) && (
                  <>
                     <span aria-hidden className="h-3.5 w-px shrink-0 bg-border" />
                     {ahead > 0 && (
                        <Count n={ahead} dir="up" busy={working === "push"} className="" />
                     )}
                     {behind > 0 && (
                        <Count
                           n={behind}
                           dir="down"
                           busy={working === "pull"}
                           className="text-amber-600 dark:text-amber-400"
                        />
                     )}
                  </>
               )}
            </button>
         </DropdownMenuTrigger>
         <DropdownMenuContent
            align="end"
            className="w-80"
            onCloseAutoFocus={(e) => e.preventDefault()}
         >
            <div className="flex gap-2 px-2 pt-2 pb-1.5">
               <Icon className={cn("mt-0.5 size-4 shrink-0", st?.cls)} />
               <div className="flex min-w-0 flex-col gap-0.5">
                  {pr ? (
                     <>
                        <span className="text-sm font-medium">
                           #{pr.number} {pr.title}
                        </span>
                        <span className={cn("text-xs text-muted-foreground", done && st?.cls)}>
                           {st?.label}
                           {checks && ` · ${pr.checks_passed}/${pr.checks_total} ${checks.label}`}
                           {` · ${pr.author} · ${relative(pr.updated_at)}`}
                        </span>
                     </>
                  ) : (
                     <>
                        <span className="font-mono text-sm font-medium">
                           {branch ?? "detached"}
                        </span>
                        <span className="text-xs text-muted-foreground">
                           {!repo
                              ? "No GitHub remote"
                              : onBase
                                ? "Default branch"
                                : "No pull request yet"}
                        </span>
                     </>
                  )}
               </div>
            </div>
            {branch && base && !onBase && (
               <div className="flex items-center gap-1.5 px-2 pb-1.5 text-xs">
                  <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 truncate font-mono">{branch}</span>
                  <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
                  <GitMerge className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="shrink-0 font-mono">{base}</span>
               </div>
            )}
            <DropdownMenuSeparator />
            {pr && (
               <DropdownMenuItem onSelect={() => void open(pr.url)}>
                  <ExternalLink /> Open pull request on GitHub
               </DropdownMenuItem>
            )}
            {!pr && compareUrl && !done && (
               <DropdownMenuItem onSelect={() => void open(compareUrl)}>
                  <Plus /> Create pull request on GitHub…
               </DropdownMenuItem>
            )}
            {branchUrl && (
               <DropdownMenuItem onSelect={() => void open(branchUrl)}>
                  <GitBranch /> Open branch on GitHub
               </DropdownMenuItem>
            )}
            {branch && (behind > 0 || ahead > 0) && (
               <>
                  <DropdownMenuSeparator />
                  {behind > 0 && (
                     <DropdownMenuItem onSelect={() => void pull()}>
                        <ArrowDown className="text-amber-600 dark:text-amber-400" /> Fast-forward{" "}
                        {n(behind, "commit")} from origin
                     </DropdownMenuItem>
                  )}
                  {ahead > 0 && (
                     <DropdownMenuItem onSelect={() => void push()}>
                        <ArrowUp /> Push {n(ahead, "commit")}
                     </DropdownMenuItem>
                  )}
               </>
            )}
            <DropdownMenuSeparator />
            {branch && (
               <DropdownMenuItem onSelect={() => void copy(branch, "the branch name")}>
                  <Copy /> Copy branch name
               </DropdownMenuItem>
            )}
            {pr && (
               <DropdownMenuItem onSelect={() => void copy(pr.url, "the PR link")}>
                  <Copy /> Copy PR link
               </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={git.refresh}>
               <RefreshCw /> Refresh
            </DropdownMenuItem>
         </DropdownMenuContent>
      </DropdownMenu>
   );
}

/** "2h ago", "3d ago" from an RFC 3339 time. */
function relative(iso: string): string {
   const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
   if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
   if (s < 86400) return `${Math.round(s / 3600)}h ago`;
   return `${Math.round(s / 86400)}d ago`;
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
            {s.quick && row("Kind", "Quick Session")}
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
   indicatorRef,
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
   indicatorRef?: (el: HTMLSpanElement | null) => void;
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
                  <Button
                     size="icon"
                     variant="ghost"
                     className={cn(iconBtn, "relative")}
                     aria-label="Session info"
                  >
                     <Info />
                     <span
                        ref={indicatorRef}
                        className="absolute right-0.5 top-0.5 flex empty:hidden"
                     />
                  </Button>
               </Tooltip>
            </DropdownMenuTrigger>
            <DropdownMenuContent
               align="start"
               className="w-96 p-3 text-sm"
               onCloseAutoFocus={(e) => e.preventDefault()}
            >
               <div ref={statusRef} className="mb-2.5 border-b pb-2.5 empty:hidden" />
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
         <div data-tauri-drag-region className="h-full min-w-4 flex-1" />
         {git && <GitRefButton client={client} session={session} git={git} />}
         {session.quick && (
            <span className="flex shrink-0 items-center gap-1.5 px-1.5 text-xs text-muted-foreground">
               <Zap className="size-3" />
               Quick Session
            </span>
         )}
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
