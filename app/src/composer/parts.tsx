import type { BranchInfo } from "@harness/api";
import { Button, cn, Tooltip } from "@harness/ui";
import { GitPullRequest, RefreshCw } from "lucide-react";
import type { PickedPr } from "./usePullRequests";

export function Label({ children, extra }: { children: React.ReactNode; extra?: React.ReactNode }) {
   return (
      <div className="flex min-h-6 items-center gap-1">
         <span className="text-xs font-medium text-muted-foreground">{children}</span>
         {extra}
      </div>
   );
}

export function PrIcon({ pr, className }: { pr?: PickedPr | null; className?: string }) {
   const color = !pr?.checks
      ? "text-muted-foreground"
      : pr.draft
        ? "text-muted-foreground/60"
        : {
             passing: "text-emerald-500",
             failing: "text-red-500",
             pending: "text-amber-500",
             none: "text-muted-foreground",
          }[pr.checks];
   const state = pr?.draft ? "Draft" : pr?.checks ? `Checks ${pr.checks}` : undefined;
   return (
      <GitPullRequest
         className={cn("size-4 shrink-0", color, className)}
         aria-label={state}
         aria-hidden={!state}
      />
   );
}

export function AheadBehind({ b }: { b?: BranchInfo }) {
   if (!b || (!b.ahead && !b.behind)) return null;
   return (
      <Tooltip
         content={[
            b.ahead ? `${b.ahead} ahead of` : "",
            b.behind ? `${b.behind} behind` : "",
            `origin/${b.name}`,
         ]
            .filter(Boolean)
            .join(b.ahead && b.behind ? ", " : " ")}
      >
         <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {b.ahead ? `↑${b.ahead}` : ""}
            {b.ahead && b.behind ? " " : ""}
            {b.behind ? `↓${b.behind}` : ""}
         </span>
      </Tooltip>
   );
}

/** "Update" for a branch behind its upstream: fast-forwards it, then the list reloads. */
export function UpdateBranch({
   b,
   onUpdate,
   busy,
}: {
   b?: BranchInfo;
   onUpdate: (b: BranchInfo) => void;
   busy: boolean;
}) {
   if (!b?.behind) return null;
   return (
      <Tooltip content={`Fast-forward ${b.name} to origin/${b.name}`}>
         <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            className="-my-1 h-6 shrink-0 gap-1 px-1.5 text-xs text-muted-foreground"
            onClick={(e) => {
               e.stopPropagation();
               onUpdate(b);
            }}
         >
            <RefreshCw className={cn("size-3", busy && "animate-spin")} />
            {busy ? "Updating" : "Update"}
         </Button>
      </Tooltip>
   );
}

export function Pill({ children }: { children: React.ReactNode }) {
   return (
      <span className="shrink-0 rounded-full border px-1.5 text-[11px] leading-4 text-muted-foreground">
         {children}
      </span>
   );
}

/** Widths of the placeholder title lines: they vary like real titles. */
const SKELETON_WIDTHS = ["72%", "55%", "80%", "48%", "64%"];

/** Still placeholder rows (no shimmer) in the shape of list items: an icon and one or two text lines. */
export function SkeletonRows({ lines = 1 }: { lines?: 1 | 2 }) {
   return (
      <div aria-hidden className="flex flex-col">
         {SKELETON_WIDTHS.map((width) => (
            <div key={width} className="flex items-start gap-2 px-2 py-1.5">
               <span className="mt-0.5 size-4 shrink-0 rounded-full bg-muted" />
               <span className="flex min-w-0 flex-1 flex-col gap-1.5 py-0.5">
                  <span className="h-3 rounded bg-muted" style={{ width }} />
                  {lines === 2 && <span className="h-2.5 w-2/5 rounded bg-muted/70" />}
               </span>
            </div>
         ))}
      </div>
   );
}
