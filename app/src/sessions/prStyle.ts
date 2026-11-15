import type { PrInfo } from "@harness/api";
import { GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from "lucide-react";

export const PR_STYLE: Record<
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
