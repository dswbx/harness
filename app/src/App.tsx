import { useCallback, useEffect, useMemo, useState } from "react";
import { Archive, ArchiveRestore, ChevronRight, MoreHorizontal, PanelLeft, Plus, Settings, Trash2 } from "lucide-react";
import type { HarnessClient, SessionSummary, Transport } from "@harness/api";
import { HarnessClient as Client } from "@harness/api";
import {
  Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, HoverTip, ScrollArea, Separator, cn,
} from "@harness/ui";
import { ComposerDialog } from "./ComposerDialog";
import { SettingsDialog, type SettingsSection } from "./SettingsDialog";
import { ViewHost } from "./ViewHost";
import { SessionDetails, SessionHeader, StatusDot, trafficLights } from "./SessionHeader";
import { openViewWindow } from "./openWindow";
import { makeTransport } from "./transport";
import { ToastProvider, errText, useReportError } from "./toast";

const params = new URLSearchParams(window.location.search);

function useTransport() {
  const [t, setT] = useState<Transport | null>(null);
  useEffect(() => {
    void makeTransport().then(setT);
  }, []);
  return t;
}

export function App() {
  const transport = useTransport();
  if (!transport) return null;
  const solo = params.get("solo") === "1" && params.get("session");
  return (
    <ToastProvider>
      {solo ? <Solo transport={transport} sessionId={params.get("session")!} /> : <Shell transport={transport} />}
    </ToastProvider>
  );
}

/** A window showing only one Session's View. */
function Solo({ transport, sessionId }: { transport: Transport; sessionId: string }) {
  const [session, setSession] = useState<SessionSummary | null | undefined>(undefined);
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null);
  const report = useReportError();
  useEffect(() => {
    new Client(transport).listSessions().then((l) => setSession(l.find((s) => s.id === sessionId) ?? null)).catch((e) => {
      report("Could not load session", e);
      setSession(null);
    });
  }, [transport, sessionId, report]);
  useEffect(() => {
    if (session) document.title = session.title;
  }, [session]);
  if (session === undefined) return null;
  if (session === null) return <div className="p-6 text-sm text-destructive">Session not found.</div>;
  // A Frontend's own window (`pane=...`, e.g. a pop-out diff) brings its own chrome.
  if (params.get("pane")) {
    return (
      <div className="h-full">
        <ViewHost transport={transport} sessionId={session.id} frontendId={session.frontend_id} />
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col">
      <SessionHeader session={session} toolbarRef={setToolbar} leading={trafficLights && <div className="w-12 shrink-0" />} />
      <div className="min-h-0 flex-1">
        <ViewHost transport={transport} sessionId={session.id} frontendId={session.frontend_id} toolbar={toolbar} />
      </div>
    </div>
  );
}

function SessionRow({
  s, selected, onSelect, onArchive, onDelete,
}: {
  s: SessionSummary;
  selected: boolean;
  onSelect: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const item = "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent";
  return (
    <li className="group relative" onContextMenu={(e) => { e.preventDefault(); setMenu(true); }}>
      <HoverTip side="right" align="start" delay={700} className="w-80 max-w-80 p-3 text-xs" content={<><div className="mb-2 text-sm font-semibold">{s.title}</div><SessionDetails s={s} /></>}>
        <button
          onClick={onSelect}
          aria-current={selected || undefined}
          className={cn("flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left transition-[padding] group-hover:pr-8 group-has-focus-visible:pr-8 text-sm text-foreground/80 hover:bg-accent/60 hover:text-foreground", selected && "bg-accent font-medium text-foreground hover:bg-accent", s.archived && "opacity-70")}
        >
          <span className="min-w-0 flex-1 truncate">{s.title}</span>
          <StatusDot status={s.status} className="group-hover:hidden" />
        </button>
      </HoverTip>
      <button
        aria-label="Session menu"
        title="Session menu"
        className="absolute right-1 top-1 translate-x-1 rounded p-1 text-muted-foreground opacity-0 transition hover:bg-background group-hover:translate-x-0 group-hover:opacity-100 group-has-focus-visible:translate-x-0 group-has-focus-visible:opacity-100"
        onClick={() => setMenu(!menu)}
      >
        <MoreHorizontal className="size-4" />
      </button>
      {menu && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setMenu(false)} onContextMenu={(e) => { e.preventDefault(); setMenu(false); }} />
          <div role="menu" className="absolute right-1 top-8 z-20 w-36 rounded-md border bg-popover p-1 shadow-md">
            <button role="menuitem" className={item} onClick={() => { setMenu(false); onArchive(); }}>
              {s.archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
              {s.archived ? "Unarchive" : "Archive"}
            </button>
            <button role="menuitem" className={cn(item, "text-destructive")} onClick={() => { setMenu(false); onDelete(); }}>
              <Trash2 className="size-4" /> Delete
            </button>
          </div>
        </>
      )}
    </li>
  );
}

/** Sidebar toggle and New Session, next to the traffic lights. */
function WindowControls({ sidebarOpen, onToggleSidebar, onNew }: { sidebarOpen: boolean; onToggleSidebar: () => void; onNew: () => void }) {
  const btn = "size-7 text-muted-foreground hover:text-foreground";
  return (
    <div className="flex items-center gap-0.5">
      <Button size="icon" variant="ghost" className={btn} aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"} title={sidebarOpen ? "Hide sidebar" : "Show sidebar"} onClick={onToggleSidebar}>
        <PanelLeft />
      </Button>
      <Button size="icon" variant="ghost" className={btn} aria-label="New Session" title="New Session" onClick={onNew}>
        <Plus />
      </Button>
    </div>
  );
}

const SIDEBAR_KEY = "harness.sidebarOpen";

function useSidebarOpen() {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const toggle = useCallback(() => {
    setOpen((o) => {
      try {
        localStorage.setItem(SIDEBAR_KEY, o ? "0" : "1");
      } catch { /* per-window convenience only */ }
      return !o;
    });
  }, []);
  return [open, toggle] as const;
}

const WIDTH_KEY = "harness.sidebarWidth";
const MIN_WIDTH = 200;
const MAX_WIDTH = 480;

/** Sidebar width, dragged from its right edge (double-click resets). */
function useSidebarWidth() {
  const [width, setWidth] = useState(() => {
    try {
      const w = Number(localStorage.getItem(WIDTH_KEY));
      return w >= MIN_WIDTH && w <= MAX_WIDTH ? w : 256;
    } catch {
      return 256;
    }
  });
  const save = (w: number) => {
    try {
      localStorage.setItem(WIDTH_KEY, String(w));
    } catch { /* per-window convenience only */ }
  };
  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const start = width;
    let last = start;
    const move = (ev: PointerEvent) => {
      last = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, start + ev.clientX - startX));
      setWidth(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
      save(last);
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const reset = () => {
    setWidth(256);
    save(256);
  };
  return { width, onPointerDown, reset };
}

/** The Session's current branch, when its folder is a git repository (refreshed as its status changes). */
function useBranch(client: HarnessClient, s: SessionSummary | null) {
  const [branch, setBranch] = useState<string | null>(null);
  const id = s?.workspace.repo_root ? s.id : null;
  const status = s?.status;
  useEffect(() => {
    if (!id) return setBranch(null);
    let off = false;
    client.sessionApi(id).gitStatus().then((g) => !off && setBranch(g.branch), () => !off && setBranch(null));
    return () => { off = true; };
  }, [client, id, status]);
  return branch;
}

function Shell({ transport }: { transport: Transport }) {
  const [client] = useState<HarnessClient>(() => new Client(transport));
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [composer, setComposer] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null);
  const [agentsVersion, setAgentsVersion] = useState(0);
  const [mcpVersion, setMcpVersion] = useState(0);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [toDelete, setToDelete] = useState<SessionSummary | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [menuError, setMenuError] = useState<string | null>(null);
  const [sidebarOpen, toggleSidebar] = useSidebarOpen();
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null);

  const report = useReportError();

  // Push-driven: SessionsChanged reloads, SessionStatus patches one row. The slow poll is a safety net.
  useEffect(() => {
    let stop = false;
    let failed = false;
    const load = () =>
      client.listSessions().then(
        (l) => {
          failed = false;
          if (!stop) setSessions(l);
        },
        (e) => {
          if (!failed) report("Could not load sessions", e);
          failed = true;
        },
      );
    void load();
    const poll = setInterval(load, 30_000);
    let unsub: (() => void) | undefined;
    client
      .subscribeApp((e) => {
        if (stop) return;
        if (e.type === "SessionsChanged") void load();
        else if (e.type === "SessionStatus") {
          setSessions((l) => {
            const i = l.findIndex((s) => s.id === e.session_id);
            if (i < 0) {
              void load(); // unknown Session: the list is stale
              return l;
            }
            if (l[i]!.status === e.status && l[i]!.title === e.title) return l;
            return l.map((s, n) => (n === i ? { ...s, status: e.status, title: e.title } : s));
          });
        } else if (e.type === "AgentsChanged") setAgentsVersion((v) => v + 1);
      })
      .then((u) => (stop ? u() : (unsub = u)))
      .catch((e) => report("Live updates unavailable (falling back to polling)", e));
    return () => {
      stop = true;
      clearInterval(poll);
      unsub?.();
    };
  }, [client, report]);

  const current = sessions.find((s) => s.id === selected) ?? null;
  const branch = useBranch(client, current);
  const sidebar = useSidebarWidth();
  // Sessions needing attention first (stable within each group).
  const active = useMemo(() => {
    const l = sessions.filter((s) => !s.archived);
    return [...l.filter((s) => s.status === "needs_attention"), ...l.filter((s) => s.status !== "needs_attention")];
  }, [sessions]);
  const archived = sessions.filter((s) => s.archived);
  const attention = active.filter((s) => s.status === "needs_attention").length;
  const refresh = useCallback(() => client.listSessions().then(setSessions), [client]);

  useEffect(() => {
    document.title = attention > 0 ? `(${attention}) Harness` : "Harness";
  }, [attention]);

  const toggleArchive = (s: SessionSummary) => {
    setMenuError(null);
    (s.archived ? client.unarchiveSession(s.id) : client.archiveSession(s.id)).then(refresh).catch((e) => setMenuError(errText(e)));
  };
  const askDelete = (s: SessionSummary) => {
    setToDelete(s);
    setDeleteError(null);
  };
  /** First attempt is safe; once the core refused, the same button becomes "Delete anyway". */
  const confirmDelete = async () => {
    if (!toDelete) return;
    setDeleting(true);
    try {
      await client.deleteSession(toDelete.id, deleteError !== null);
      if (selected === toDelete.id) setSelected(null);
      setToDelete(null);
      await refresh();
    } catch (e) {
      setDeleteError(errText(e));
    } finally {
      setDeleting(false);
    }
  };
  const row = (s: SessionSummary) => (
    <SessionRow key={s.id} s={s} selected={s.id === selected} onSelect={() => setSelected(s.id)} onArchive={() => toggleArchive(s)} onDelete={() => askDelete(s)} />
  );

  const controls = <WindowControls sidebarOpen={sidebarOpen} onToggleSidebar={toggleSidebar} onNew={() => setComposer(true)} />;
  // Sidebar hidden: the controls move next to the traffic lights in the main header.
  const leading = sidebarOpen ? undefined : <div className={cn("mr-2 shrink-0", trafficLights && "pl-[68px]")}>{controls}</div>;

  return (
    <div className="flex h-full">
      {sidebarOpen && (
        <aside className="relative flex shrink-0 flex-col border-r bg-muted/30" style={{ width: sidebar.width }}>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            title="Drag to resize, double-click to reset"
            className="absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:transition-colors hover:after:bg-ring"
            onPointerDown={sidebar.onPointerDown}
            onDoubleClick={sidebar.reset}
          />
          <div data-tauri-drag-region className={cn("flex h-13 shrink-0 items-center gap-1 pr-2", trafficLights ? "pl-[76px]" : "pl-3")}>
            <div data-tauri-drag-region className="h-full flex-1" />
            {controls}
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <ul className="flex flex-col gap-px px-2 py-1">
              {sessions.length === 0 && <li className="p-3 text-xs text-muted-foreground">No Sessions yet.</li>}
              {active.map(row)}
            </ul>
            {archived.length > 0 && (
              <div className="p-2 pt-1">
                <button
                  className="flex w-full items-center gap-1 px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
                  aria-expanded={archivedOpen}
                  onClick={() => setArchivedOpen(!archivedOpen)}
                >
                  <ChevronRight className={cn("size-3 transition-transform", archivedOpen && "rotate-90")} />
                  Archived ({archived.length})
                </button>
                {archivedOpen && <ul className="flex flex-col gap-px">{archived.map(row)}</ul>}
              </div>
            )}
            {menuError && <p role="alert" className="px-4 pb-2 text-xs text-destructive">{menuError}</p>}
          </ScrollArea>
          <Separator />
          <div className="p-2">
            <Button size="sm" variant="ghost" className="w-full justify-start text-muted-foreground hover:text-foreground" onClick={() => setSettingsSection("appearance")}>
              <Settings /> Settings
            </Button>
          </div>
        </aside>
      )}
      <main className="flex min-w-0 flex-1 flex-col">
        {current ? (
          <>
            <SessionHeader
              session={current}
              branch={branch}
              leading={leading}
              toolbarRef={setToolbar}
              onOpenWindow={() => openViewWindow(current.id, current.title).catch((e) => report("Could not open window", e))}
            />
            <div className="min-h-0 flex-1">
              <ViewHost transport={transport} sessionId={current.id} frontendId={current.frontend_id} toolbar={toolbar} />
            </div>
          </>
        ) : (
          <>
            {leading && <div data-tauri-drag-region className="flex h-13 shrink-0 items-center pl-5">{leading}</div>}
            <div className="grid flex-1 place-items-center text-sm text-muted-foreground">Select or create a Session.</div>
          </>
        )}
      </main>
      <Dialog open={toDelete !== null} onOpenChange={(o) => !o && setToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Session?</DialogTitle>
            <DialogDescription>
              "{toDelete?.title}" and its log will be deleted{toDelete?.workspace.worktree_branch ? ", along with its Worktree and branch" : ""}. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {deleteError && <p role="alert" className="text-sm text-destructive">{deleteError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setToDelete(null)}>Cancel</Button>
            <Button variant="destructive" disabled={deleting} onClick={() => void confirmDelete()}>
              {deleteError ? "Delete anyway" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <SettingsDialog
        client={client}
        open={settingsSection !== null}
        onOpenChange={(o) => !o && setSettingsSection(null)}
        section={settingsSection ?? "appearance"}
        onSectionChange={setSettingsSection}
        sessionId={selected}
        agentsVersion={agentsVersion}
        onAgentsChanged={() => setAgentsVersion((v) => v + 1)}
        onMcpChanged={() => setMcpVersion((v) => v + 1)}
      />
      <ComposerDialog client={client} open={composer} onOpenChange={setComposer} agentsVersion={agentsVersion} mcpVersion={mcpVersion} onManageAgents={() => { setComposer(false); setSettingsSection("agents"); }} onCreated={(id) => { setSelected(id); refresh().catch((e) => report("Could not load sessions", e)); }} />
    </div>
  );
}
