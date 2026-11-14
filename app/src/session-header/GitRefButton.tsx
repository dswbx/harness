import type { GitStatus, HarnessClient, PrInfo, RepoId, SessionSummary } from "@harness/api";
import { inTauri } from "@harness/api";
import {
   cn,
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuSeparator,
   DropdownMenuTrigger,
} from "@harness/ui";
import {
   ArrowDown,
   ArrowRight,
   ArrowUp,
   Check,
   Clock,
   Copy,
   ExternalLink,
   GitBranch,
   GitMerge,
   Loader2,
   Plus,
   RefreshCw,
   X,
} from "lucide-react";
import { useState } from "react";
import { useReportError } from "../platform/toast";
import { PR_STYLE } from "../sessions/prStyle";

/** The Session's git ref as the header shows it (see `useGitRef`). */
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
export function GitRefButton({
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
