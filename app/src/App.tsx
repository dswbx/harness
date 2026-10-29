import { useCallback, useEffect, useMemo, useState } from "react";
import { AppWindow, Archive, ArchiveRestore, ChevronRight, GitBranch, MoreHorizontal, Plus, Settings, Trash2 } from "lucide-react";
import type { HarnessClient, SessionStatus, SessionSummary, Transport } from "@harness/api";
import { HarnessClient as Client } from "@harness/api";
import {
  Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, ScrollArea, Separator, cn,
} from "@harness/ui";
import { ComposerDialog } from "./ComposerDialog";
import { SettingsDialog, type SettingsSection } from "./SettingsDialog";
import { ViewHost } from "./ViewHost";
import { openViewWindow } from "./openWindow";
import { makeTransport } from "./transport";
import { ToastProvider, errText, useReportError } from "./toast";

const params = new URLSearchParams(window.location.search);

const statusBadge: Record<SessionStatus, { label: string; variant: "secondary" | "success" | "warning" }> = {
  idle: { label: "idle", variant: "secondary" },
  working: { label: "working", variant: "success" },
  needs_attention: { label: "needs attention", variant: "warning" },
};

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
  return (
    <div className="h-full">
      <ViewHost transport={transport} sessionId={session.id} frontendId={session.frontend_id} />
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
      <button
        onClick={onSelect}
        className={cn("flex w-full flex-col gap-1 rounded-md border-l-2 border-transparent px-3 py-2 pr-8 text-left hover:bg-accent", s.status === "needs_attention" && "border-amber-500 bg-amber-500/10", selected && "bg-accent", s.archived && "opacity-70")}
      >
        <span className="flex items-center gap-1.5">
          {s.status === "needs_attention" && <span aria-hidden className="size-2 shrink-0 rounded-full bg-amber-500" />}
          <span className={cn("truncate text-sm", s.status === "needs_attention" && "font-medium")}>{s.title}</span>
        </span>
        {s.workspace.worktree_branch && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground" title={`Worktree branch (base ${s.workspace.base_branch ?? "?"})`}>
            <GitBranch className="size-3 shrink-0" />
            <span className="truncate">{s.workspace.worktree_branch}</span>
          </span>
        )}
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <Badge variant={statusBadge[s.status].variant}>{statusBadge[s.status].label}</Badge>
          <span>{s.frontend_id}</span>
          <span className="truncate">{s.folder.split("/").pop()}</span>
        </span>
      </button>
      <button
        aria-label="Session menu"
        title="Session menu"
        className="absolute right-1 top-1.5 rounded p-1 text-muted-foreground opacity-0 hover:bg-background group-hover:opacity-100 focus-visible:opacity-100"
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

  return (
    <div className="flex h-full">
      <aside className="flex w-64 shrink-0 flex-col border-r bg-muted/30">
        <div className="flex items-center justify-between p-3">
          <span className="flex items-center gap-2 font-semibold">
            Harness
            {attention > 0 && (
              <Badge variant="warning" title={`${attention} ${attention === 1 ? "Session needs" : "Sessions need"} attention`}>
                {attention}
              </Badge>
            )}
          </span>
          <Button size="sm" onClick={() => setComposer(true)}>
            <Plus /> New Session
          </Button>
        </div>
        <Separator />
        <ScrollArea className="min-h-0 flex-1">
          <ul className="p-2">
            {sessions.length === 0 && <li className="p-3 text-xs text-muted-foreground">No Sessions yet.</li>}
            {active.map(row)}
          </ul>
          {archived.length > 0 && (
            <div className="p-2 pt-0">
              <button
                className="flex w-full items-center gap-1 px-3 py-1 text-xs text-muted-foreground hover:text-foreground"
                aria-expanded={archivedOpen}
                onClick={() => setArchivedOpen(!archivedOpen)}
              >
                <ChevronRight className={cn("size-3 transition-transform", archivedOpen && "rotate-90")} />
                Archived ({archived.length})
              </button>
              {archivedOpen && <ul>{archived.map(row)}</ul>}
            </div>
          )}
          {menuError && <p role="alert" className="px-4 pb-2 text-xs text-destructive">{menuError}</p>}
        </ScrollArea>
        <Separator />
        <div className="p-2">
          <Button size="sm" variant="ghost" onClick={() => setSettingsSection("appearance")}>
            <Settings /> Settings
          </Button>
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        {current ? (
          <>
            <div className="flex items-center gap-2 border-b px-3 py-1.5 text-xs text-muted-foreground">
              <span className="truncate" title={current.folder}>{current.folder}</span>
              <span>· {current.agent_id}</span>
              <div className="flex-1" />
              <Button size="sm" variant="ghost" onClick={() => openViewWindow(current.id, current.title).catch((e) => report("Could not open window", e))}>
                <AppWindow /> Open in new window
              </Button>
            </div>
            <div className="min-h-0 flex-1">
              <ViewHost transport={transport} sessionId={current.id} frontendId={current.frontend_id} />
            </div>
          </>
        ) : (
          <div className="grid flex-1 place-items-center text-sm text-muted-foreground">Select or create a Session.</div>
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
