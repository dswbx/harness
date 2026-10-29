import type { ReactNode } from "react";
import { AppWindow, Copy, FolderOpen, GitBranch, Info, MoreHorizontal } from "lucide-react";
import type { SessionStatus, SessionSummary } from "@harness/api";
import { inTauri } from "@harness/api";
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, cn } from "@harness/ui";
import { useReportError } from "./toast";

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
      className={cn("size-2 shrink-0 rounded-full", status === "working" ? "animate-pulse bg-sky-500" : "bg-amber-500", className)}
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
        <span className="text-muted-foreground">{statusLabel[s.status]}{s.archived ? " · archived" : ""}</span>
      </div>
      <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5">
        {row("Folder", s.folder, true)}
        {row("Worktree", ws.worktree_branch ? `${ws.worktree_branch} (from ${ws.base_branch ?? "?"})` : "None, works in folder", !!ws.worktree_branch)}
        {!ws.repo_root && row("Git", "Not a git repository")}
        {row("Agent", s.agent_id)}
        {row("Frontend", s.frontend_id)}
        {row("Started", new Date(s.created_ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }))}
      </dl>
    </div>
  );
}

const iconBtn = "size-7 text-muted-foreground hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground";

/**
 * The one header above a Session's View: title, info popover, actions menu, and a slot the Frontend
 * fills with its own actions (`toolbarRef`). `leading` sits left of the title (traffic lights, sidebar toggle).
 */
export function SessionHeader({
  session, branch, leading, onOpenWindow, toolbarRef,
}: {
  session: SessionSummary;
  /** Current git branch; none outside a repository. */
  branch?: string | null;
  leading?: ReactNode;
  onOpenWindow?: () => void;
  toolbarRef: (el: HTMLDivElement | null) => void;
}) {
  const report = useReportError();
  const reveal = () =>
    import("@tauri-apps/plugin-opener")
      .then(({ revealItemInDir }) => revealItemInDir(session.folder))
      .catch((e) => report("Could not reveal folder", e));
  const copy = () => navigator.clipboard.writeText(session.folder).catch((e) => report("Could not copy path", e));
  return (
    <header data-tauri-drag-region className="flex h-13 shrink-0 items-center gap-1 border-b pl-5 pr-3">
      {leading}
      <h1 data-tauri-drag-region className="mr-1 min-w-0 truncate text-sm font-semibold">{session.title}</h1>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon" variant="ghost" className={iconBtn} aria-label="Session info" title="Session info">
            <Info />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-96 p-4 text-sm" onCloseAutoFocus={(e) => e.preventDefault()}>
          <SessionDetails s={session} />
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon" variant="ghost" className={iconBtn} aria-label="Session actions" title="Session actions">
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56" onCloseAutoFocus={(e) => e.preventDefault()}>
          {onOpenWindow && (
            <>
              <DropdownMenuItem onSelect={onOpenWindow}><AppWindow /> Open in new window</DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem onSelect={() => void copy()}><Copy /> Copy path</DropdownMenuItem>
          {inTauri() && <DropdownMenuItem onSelect={() => void reveal()}><FolderOpen /> Reveal in Finder</DropdownMenuItem>}
        </DropdownMenuContent>
      </DropdownMenu>
      <div data-tauri-drag-region className="h-full min-w-4 flex-1" />
      {branch && (
        <span className="flex min-w-0 max-w-64 items-center gap-1.5 px-1 text-xs text-muted-foreground" title={`Branch ${branch}`}>
          <GitBranch className="size-3.5 shrink-0" />
          <span className="truncate font-mono">{branch}</span>
        </span>
      )}
      <div ref={toolbarRef} className="flex items-center gap-1" />
    </header>
  );
}
