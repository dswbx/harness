import {
   type Branches,
   type BranchInfo,
   formatAge,
   type PrFilter,
   type PullRequest,
   parsePrRef,
} from "@harness/api";
import { cn } from "@harness/ui";
import { GitBranch, Plus } from "lucide-react";
import { useMemo } from "react";
import { branchChoices, matchesWords } from "./composer";
import { FieldButton, Picker, type PickItem } from "./Picker";
import { AheadBehind, Label, Pill, PrIcon, UpdateBranch } from "./parts";
import { type Target, targetInfo, worktreeAfterPick, worktreeSwitch } from "./startPoint";
import type { PickedPr } from "./usePullRequests";

const PR_FILTERS: [PrFilter, string][] = [
   ["open", "Open"],
   ["mine", "Mine"],
   ["review_requested", "Review requested"],
];

/** The "Start from" field of a repository: branch or PR tab, the picker and the Worktree switch. */
export function StartFromField({
   branches,
   mode,
   setMode,
   target,
   setTarget,
   worktree,
   setWorktree,
   prWorktree,
   setPrWorktree,
   pr,
   setPr,
   prs,
   prAvailable,
   prFilter,
   setPrFilter,
   updating,
   updateBranch,
   startOpen,
   setStartOpen,
   branchQuery,
   setBranchQuery,
   prQuery,
   setPrQuery,
}: {
   branches: Branches | null;
   mode: "branch" | "pr";
   setMode: (m: "branch" | "pr") => void;
   target: Target | null;
   setTarget: (t: Target) => void;
   worktree: boolean;
   setWorktree: (f: boolean | ((w: boolean) => boolean)) => void;
   prWorktree: boolean;
   setPrWorktree: (f: (w: boolean) => boolean) => void;
   pr: PickedPr | null;
   setPr: (p: PickedPr) => void;
   prs: PullRequest[] | null;
   prAvailable: boolean;
   prFilter: PrFilter;
   setPrFilter: (f: PrFilter) => void;
   updating: string | null;
   updateBranch: (b: BranchInfo) => void;
   startOpen: boolean;
   setStartOpen: (o: boolean) => void;
   branchQuery: string;
   setBranchQuery: (q: string) => void;
   prQuery: string;
   setPrQuery: (q: string) => void;
}) {
   const local = useMemo(() => new Map(branches?.branches.map((b) => [b.name, b])), [branches]);
   const targetBranch = targetInfo(target, branches);
   const {
      locked: wtLocked,
      on: wtOn,
      note: wtNote,
   } = worktreeSwitch({ mode, target, info: targetBranch, worktree, prWorktree });

   const pickTarget = (t: Target) => {
      setTarget(t);
      setStartOpen(false);
      setBranchQuery("");
      setWorktree(
         worktreeAfterPick(t, {
            current: branches?.current ?? null,
            info: t.kind === "local" ? local.get(t.name) : undefined,
            worktree,
         }),
      );
   };

   // ---- Branch list
   const bq = branchQuery.trim();
   const branchExists = (n: string) =>
      local.has(n) ||
      !!branches?.remote.some((b) => b.name === n || b.name.split("/").slice(1).join("/") === n);
   const branchRow = (b: BranchInfo, remote: boolean) => (
      <>
         <GitBranch className="size-4 shrink-0 text-muted-foreground" />
         <span className="truncate font-mono text-[13px]">{b.name}</span>
         {b.name === branches?.current && <Pill>current</Pill>}
         {b.worktree && <Pill>checked out elsewhere</Pill>}
         <span className="flex-1" />
         {!remote && <AheadBehind b={b} />}
         <span className="w-14 shrink-0 text-right text-xs text-muted-foreground">
            {b.time ? formatAge(b.time * 1000) : ""}
         </span>
      </>
   );
   const choices = branchChoices(branches, bq);
   const branchItems: PickItem[] = [
      ...(bq && !branchExists(bq)
         ? [
              {
                 key: "new",
                 onSelect: () => pickTarget({ kind: "new", name: bq }),
                 content: (
                    <>
                       <Plus className="size-4 shrink-0 text-muted-foreground" />
                       <span className="truncate">
                          Create branch{" "}
                          <span className="font-mono text-[13px] font-medium">{bq}</span>
                       </span>
                       <span className="flex-1" />
                       <span className="shrink-0 text-xs text-muted-foreground">
                          from {branches?.current ?? "HEAD"}
                       </span>
                    </>
                 ),
              },
           ]
         : []),
      ...(choices.defaultLocal
         ? [
              {
                 key: `l:${choices.defaultLocal.name}`,
                 selected: target?.kind === "local" && target.name === choices.defaultLocal.name,
                 onSelect: () => pickTarget({ kind: "local", name: choices.defaultLocal!.name }),
                 content: branchRow(choices.defaultLocal, false),
              } satisfies PickItem,
           ]
         : []),
      ...(choices.defaultRemote
         ? [
              {
                 key: `r:${choices.defaultRemote.name}`,
                 selected: target?.kind === "remote" && target.name === choices.defaultRemote.name,
                 onSelect: () => pickTarget({ kind: "remote", name: choices.defaultRemote!.name }),
                 content: branchRow(choices.defaultRemote, true),
              } satisfies PickItem,
           ]
         : []),
      ...choices.local.map(
         (b): PickItem => ({
            key: `l:${b.name}`,
            section: "Local",
            selected: target?.kind === "local" && target.name === b.name,
            onSelect: () => pickTarget({ kind: "local", name: b.name }),
            content: branchRow(b, false),
         }),
      ),
      ...choices.remote.map(
         (b): PickItem => ({
            key: `r:${b.name}`,
            section: "Remote only",
            selected: target?.kind === "remote" && target.name === b.name,
            onSelect: () => pickTarget({ kind: "remote", name: b.name }),
            content: branchRow(b, true),
         }),
      ),
   ];

   // ---- PR list
   const pq = prQuery.trim();
   const typedPr = parsePrRef(pq);
   const pickPr = (p: PickedPr) => {
      setPr(p);
      setStartOpen(false);
      setPrQuery("");
   };
   const prItems: PickItem[] = [
      ...(typedPr && !prs?.some((p) => p.number === typedPr)
         ? [
              {
                 key: "typed",
                 onSelect: () => pickPr({ number: typedPr }),
                 content: (
                    <>
                       <PrIcon />
                       <span>
                          Open PR <span className="font-medium">#{typedPr}</span>
                       </span>
                    </>
                 ),
              },
           ]
         : []),
      ...(prs ?? [])
         .filter(
            (p) =>
               typedPr === p.number || matchesWords(pq, p.title, `#${p.number}`, p.head, p.author),
         )
         .map(
            (p): PickItem => ({
               key: String(p.number),
               selected: pr?.number === p.number,
               onSelect: () => pickPr(p),
               content: (
                  <>
                     <PrIcon pr={p} className="self-start mt-0.5" />
                     <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="truncate">{p.title}</span>
                        <span className="truncate text-xs text-muted-foreground">
                           #{p.number} · {p.draft ? "draft · " : ""}
                           {p.author} ·{" "}
                           <span className="font-mono">{p.fork ? `fork:${p.head}` : p.head}</span> ·{" "}
                           {formatAge(Date.parse(p.updated_at))}
                        </span>
                     </span>
                  </>
               ),
            }),
         ),
   ];

   return (
      <div className="grid gap-2">
         <Label>Start from</Label>
         <Picker
            label={mode === "branch" ? "Branches" : "Pull requests"}
            open={startOpen}
            onOpenChange={(o) => {
               setStartOpen(o);
               if (!o) {
                  setBranchQuery("");
                  setPrQuery("");
               }
            }}
            search={
               mode === "branch"
                  ? {
                       value: branchQuery,
                       onChange: setBranchQuery,
                       placeholder: "Find or create a branch",
                       mono: true,
                    }
                  : {
                       value: prQuery,
                       onChange: setPrQuery,
                       placeholder: "Search PRs, or paste a number or URL",
                    }
            }
            header={
               prAvailable && (
                  <div className="flex items-center gap-1.5 border-b px-2 py-1.5">
                     <div
                        role="tablist"
                        aria-label="Start from"
                        className="flex shrink-0 rounded-md bg-muted p-0.5 text-xs"
                     >
                        {(["branch", "pr"] as const).map((m) => (
                           <button
                              key={m}
                              type="button"
                              role="tab"
                              aria-selected={mode === m}
                              onClick={() => setMode(m)}
                              className={cn(
                                 "h-6 rounded px-2.5",
                                 mode === m
                                    ? "bg-background text-foreground shadow-xs"
                                    : "text-muted-foreground hover:text-foreground",
                              )}
                           >
                              {m === "branch" ? "Branch" : "Pull request"}
                           </button>
                        ))}
                     </div>
                     {mode === "pr" && (
                        <div className="ml-auto flex gap-1">
                           {PR_FILTERS.map(([f, name]) => (
                              <button
                                 key={f}
                                 type="button"
                                 onClick={() => setPrFilter(f)}
                                 className={cn(
                                    "h-6 rounded-full px-2 text-xs",
                                    prFilter === f
                                       ? "bg-accent text-accent-foreground"
                                       : "border text-muted-foreground hover:text-foreground",
                                 )}
                              >
                                 {name}
                              </button>
                           ))}
                        </div>
                     )}
                  </div>
               )
            }
            items={mode === "branch" ? branchItems : prItems}
            empty={
               mode === "pr"
                  ? prs === null
                     ? "Loading pull requests…"
                     : "No pull requests"
                  : undefined
            }
            hint={
               mode === "branch"
                  ? "Another branch than the folder's opens in a new worktree."
                  : "Opens on the PR's head branch, checked out with gh."
            }
            trigger={
               mode === "branch" ? (
                  <FieldButton
                     icon={<GitBranch />}
                     placeholder="Pick a branch"
                     title={
                        target && (
                           <span className="flex items-center gap-2">
                              <span className="min-w-0 truncate font-mono text-[13px] font-normal">
                                 {target.name}
                              </span>
                              {target.kind === "local" && target.name === branches?.current && (
                                 <Pill>current</Pill>
                              )}
                              {target.kind === "new" && (
                                 <Pill>new from {branches?.current ?? "HEAD"}</Pill>
                              )}
                              {target.kind === "remote" && <Pill>remote</Pill>}
                              <span className="flex-1" />
                              <AheadBehind b={targetBranch} />
                           </span>
                        )
                     }
                  />
               ) : (
                  <FieldButton
                     icon={<PrIcon pr={pr} />}
                     placeholder="Pick a pull request"
                     title={
                        pr && (
                           <span className="truncate">
                              #{pr.number}
                              {pr.title ? ` ${pr.title}` : ""}
                           </span>
                        )
                     }
                  />
               )
            }
         />
         {targetBranch?.behind && mode === "branch" ? (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
               <span>
                  {targetBranch.name} is {targetBranch.behind}{" "}
                  {targetBranch.behind === 1 ? "commit" : "commits"} behind origin
                  {wtOn ? "; the new worktree starts from origin." : "."}
               </span>
               <UpdateBranch
                  b={targetBranch}
                  busy={updating === targetBranch.name}
                  onUpdate={updateBranch}
               />
            </p>
         ) : null}
         <label className={cn("flex items-center gap-2", wtLocked && "opacity-60")}>
            <button
               type="button"
               role="switch"
               aria-checked={wtOn}
               disabled={wtLocked}
               onClick={() => (mode === "pr" ? setPrWorktree((w) => !w) : setWorktree((w) => !w))}
               className={cn(
                  "relative h-4 w-7 shrink-0 rounded-full transition-colors",
                  wtOn ? "bg-primary" : "bg-muted-foreground/30",
               )}
            >
               <span
                  className={cn(
                     "absolute top-0.5 size-3 rounded-full bg-background transition-all",
                     wtOn ? "left-3.5" : "left-0.5",
                  )}
               />
            </button>
            <span>Work in a new worktree</span>
            <span className="truncate text-xs text-muted-foreground">{wtNote}</span>
         </label>
      </div>
   );
}
