import { useCallback, useEffect, useState, type ReactNode } from "react";
import { AppWindow, Code, Copy, FolderOpen, Info, MoreHorizontal, Settings } from "lucide-react";
import type { Editor, HarnessClient, SessionStatus, SessionSummary } from "@harness/api";
import { inTauri } from "@harness/api";
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger, Tooltip, cn } from "@harness/ui";
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

/** Menu label of an editor. */
export const editorName = (e: Editor): string =>
  ({ vscode: "VS Code", cursor: "Cursor", windsurf: "Windsurf", zed: "Zed", custom: "your editor", system: "the default app" })[e.type];

const iconBtn = "size-7 text-muted-foreground hover:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground";

/**
 * The one header above a Session's View: title, info popover, actions menu, and a slot the Frontend
 * fills with its own actions (`toolbarRef`), and one after the title for its state badges (`statusRef`). At the
 * far right a gear menu: Settings, and entries the Frontend adds to `menuRef` (it exists while the menu is open).
 * `leading` sits left of the title (traffic lights, sidebar toggle).
 */
export function SessionHeader({
  client, session, branch, leading, onOpenWindow, onChooseEditor, toolbarRef, statusRef, menuRef, onOpenSettings,
}: {
  client: HarnessClient;
  session: SessionSummary;
  /** Current git branch; none outside a repository. */
  branch?: string | null;
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
  const copy = () => navigator.clipboard.writeText(session.folder).catch((e) => report("Could not copy path", e));
  // Read when the menu opens, so a change in Settings shows at once.
  const [editor, setEditor] = useState<Editor | null | undefined>(undefined);
  const loadEditor = (open: boolean) => open && void client.getEditor().then(setEditor, () => setEditor(null));
  // The Frontend's entries are portaled in from another React tree, so the menu cannot see their clicks: close on a native one.
  const [gearOpen, setGearOpen] = useState(false);
  const [gearItems, setGearItems] = useState<HTMLDivElement | null>(null);
  const gearItemsRef = useCallback((el: HTMLDivElement | null) => { setGearItems(el); menuRef?.(el); }, [menuRef]);
  useEffect(() => {
    if (!gearItems) return;
    const onClick = (e: MouseEvent) => (e.target as Element).closest("[data-menu-close]") && setGearOpen(false);
    gearItems.addEventListener("click", onClick);
    return () => gearItems.removeEventListener("click", onClick);
  }, [gearItems]);
  const openInEditor = () =>
    editor ? client.openInEditor(session.id).catch((e) => report("Could not open the editor", e)) : onChooseEditor?.();
  return (
    <header data-tauri-drag-region className="flex h-13 shrink-0 items-center gap-1 border-b pl-5 pr-3">
      {leading}
      {/* Not a drag region, so the title can be selected and copied. */}
      <h1 className="mr-1 min-w-0 cursor-text select-text truncate text-sm font-semibold">{session.title}</h1>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Tooltip content="Session info" side="bottom">
            <Button size="icon" variant="ghost" className={iconBtn} aria-label="Session info">
              <Info />
            </Button>
          </Tooltip>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-96 p-4 text-sm" onCloseAutoFocus={(e) => e.preventDefault()}>
          <SessionDetails s={session} />
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu onOpenChange={loadEditor}>
        <DropdownMenuTrigger asChild>
          <Tooltip content="Session actions" side="bottom">
            <Button size="icon" variant="ghost" className={iconBtn} aria-label="Session actions">
              <MoreHorizontal />
            </Button>
          </Tooltip>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56" onCloseAutoFocus={(e) => e.preventDefault()}>
          {onOpenWindow && (
            <>
              <DropdownMenuItem onSelect={onOpenWindow}><AppWindow /> Open in new window</DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          {(editor || onChooseEditor) && (
            <DropdownMenuItem onSelect={() => void openInEditor()}>
              <Code /> {editor ? `Open in ${editorName(editor)}` : "Open in editor…"}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => void copy()}><Copy /> Copy path</DropdownMenuItem>
          {inTauri() && <DropdownMenuItem onSelect={() => void reveal()}><FolderOpen /> Reveal in Finder</DropdownMenuItem>}
        </DropdownMenuContent>
      </DropdownMenu>
      <div ref={statusRef} className="flex min-w-0 items-center gap-1 empty:hidden" />
      <div data-tauri-drag-region className="h-full min-w-4 flex-1" />
      {branch && (
        <Tooltip content={`Branch ${branch}`} side="bottom">
          <span className="min-w-0 max-w-64 truncate px-1 font-mono text-xs text-muted-foreground">{branch}</span>
        </Tooltip>
      )}
      <div ref={toolbarRef} className="flex items-center gap-1" />
      <DropdownMenu open={gearOpen} onOpenChange={setGearOpen}>
        <DropdownMenuTrigger asChild>
          <Tooltip content="Layout and settings" side="bottom">
            <Button size="icon" variant="ghost" className={iconBtn} aria-label="Layout and settings">
              <Settings />
            </Button>
          </Tooltip>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56" onCloseAutoFocus={(e) => e.preventDefault()}>
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
