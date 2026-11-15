import { formatDateTime, type SessionSummary } from "@harness/api";
import { cn } from "@harness/ui";
import type { ReactNode } from "react";
import { StatusDot, statusLabel } from "./StatusDot";

/**
 * Folder, Worktree, Agent and timing of a Session: the sidebar hover card and the header's info
 * popover. `parent` names the parent of a Sub Session.
 */
export function SessionDetails({ s, parent }: { s: SessionSummary; parent?: SessionSummary }) {
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
            {s.parent && row("Kind", parent ? `Sub session of ${parent.title}` : "Sub session")}
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
            {row("Started", formatDateTime(s.created_ms))}
            {row("Updated", formatDateTime(s.updated_ms))}
         </dl>
      </div>
   );
}
