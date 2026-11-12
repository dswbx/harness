import type {
   GitStatus,
   HarnessClient,
   PrInfo,
   RepoId,
   SessionSummary,
   Transport,
} from "@harness/api";
import { HarnessClient as Client, errText, useSharedArtifacts } from "@harness/api";
import { SharedArtifactView } from "@harness/frontend-chat";
import {
   Badge,
   Button,
   cn,
   Dialog,
   DialogContent,
   DialogDescription,
   DialogFooter,
   DialogHeader,
   DialogTitle,
   ResizeHandle,
   Tooltip,
   useResizableWidth,
} from "@harness/ui";
import { PanelLeft, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AttachDialog } from "./AttachDialog";
import { syncAppearance } from "./appearance/appearance";
import { ComposerDialog } from "./ComposerDialog";
import { QUICK_TITLE, quickAgent } from "./composer";
import { FrontendRequests } from "./FrontendRequests";
import { Overlay } from "./Overlay";
import { openViewWindow } from "./openWindow";
import { listenHost } from "./overlayHost";
import { type GitRef, SessionHeader, trafficLights } from "./SessionHeader";
import { SessionList } from "./SessionList";
import { SettingsDialog, type SettingsSection } from "./SettingsDialog";
import { SharedArtifactsSection } from "./SharedArtifactsSection";
import { hideUnusedQuick } from "./sessionGroups";
import { ToastProvider, useReportError } from "./toast";
import { makeTransport } from "./transport";
import { UpdateFooter } from "./UpdateFooter";
import { useUpdate } from "./updates";
import { ViewHost } from "./ViewHost";

const params = new URLSearchParams(window.location.search);

function useTransport() {
   const [t, setT] = useState<Transport | null>(null);
   useEffect(() => {
      void makeTransport().then((t) => {
         // Appearance and imported themes live in the core; the local copy painted the first frame.
         void syncAppearance(new Client(t)).catch(() => {});
         setT(t);
      });
   }, []);
   return t;
}

export function App() {
   const transport = useTransport();
   if (!transport) return null;
   const solo = params.get("solo") === "1" && params.get("session");
   if (params.get("overlay") === "1")
      return (
         <ToastProvider>
            <Overlay transport={transport} />
         </ToastProvider>
      );
   return (
      <ToastProvider>
         {solo ? (
            <Solo transport={transport} sessionId={params.get("session")!} />
         ) : (
            <Shell transport={transport} />
         )}
         {!params.get("pane") && <FrontendRequests transport={transport} />}
      </ToastProvider>
   );
}

/** A window showing only one Session's View. */
function Solo({ transport, sessionId }: { transport: Transport; sessionId: string }) {
   const [session, setSession] = useState<SessionSummary | null | undefined>(undefined);
   const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null);
   const [status, setStatus] = useState<HTMLDivElement | null>(null);
   const [indicator, setIndicator] = useState<HTMLSpanElement | null>(null);
   const [menu, setMenu] = useState<HTMLDivElement | null>(null);
   const report = useReportError();
   useEffect(() => {
      new Client(transport)
         .listSessions()
         .then((l) => setSession(l.find((s) => s.id === sessionId) ?? null))
         .catch((e) => {
            report("Could not load session", e);
            setSession(null);
         });
   }, [transport, sessionId, report]);
   useEffect(() => {
      if (session) document.title = session.title;
   }, [session]);
   if (session === undefined) return null;
   if (session === null)
      return <div className="p-6 text-sm text-destructive">Session not found.</div>;
   // A Frontend's own window (`pane=...`, e.g. a pop-out diff) brings its own chrome.
   if (params.get("pane")) {
      return (
         <div className="h-full">
            <ViewHost
               transport={transport}
               sessionId={session.id}
               frontendId={session.frontend_id}
            />
         </div>
      );
   }
   return (
      <div className="flex h-full flex-col">
         <SessionHeader
            client={new Client(transport)}
            session={session}
            toolbarRef={setToolbar}
            statusRef={setStatus}
            indicatorRef={setIndicator}
            menuRef={setMenu}
            leading={trafficLights && <div className="w-12 shrink-0" />}
         />
         <div className="min-h-0 flex-1">
            <ViewHost
               transport={transport}
               sessionId={session.id}
               frontendId={session.frontend_id}
               toolbar={toolbar}
               status={status}
               indicator={indicator}
               menu={menu}
            />
         </div>
      </div>
   );
}

/** Marks a window served by the Vite dev server, to tell it from the installed app. */
const DevBadge = () =>
   import.meta.env.DEV ? (
      <Badge variant="warning" className="pointer-events-none px-1.5 text-[10px] uppercase">
         Dev
      </Badge>
   ) : null;

/** Sidebar toggle and New Session, next to the traffic lights. */
function WindowControls({
   sidebarOpen,
   onToggleSidebar,
   onNew,
}: {
   sidebarOpen: boolean;
   onToggleSidebar: () => void;
   onNew: () => void;
}) {
   const btn = "size-7 text-muted-foreground hover:text-foreground";
   return (
      <div className="flex items-center gap-0.5">
         <Tooltip content={sidebarOpen ? "Hide sidebar" : "Show sidebar"} side="bottom">
            <Button
               size="icon"
               variant="ghost"
               className={btn}
               aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
               onClick={onToggleSidebar}
            >
               <PanelLeft />
            </Button>
         </Tooltip>
         <Tooltip content="New Session" side="bottom">
            <Button
               size="icon"
               variant="ghost"
               className={btn}
               aria-label="New Session"
               onClick={onNew}
            >
               <Plus />
            </Button>
         </Tooltip>
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
         } catch {
            /* per-window convenience only */
         }
         return !o;
      });
   }, []);
   return [open, toggle] as const;
}

/** Sidebar width, dragged from its right edge (double-click resets). */
const useSidebarWidth = () =>
   useResizableWidth({
      storageKey: "harness.sidebarWidth",
      initial: 256,
      min: 200,
      max: 480,
      edge: "right",
   });

/** Checks are running or may be about to start: an open PR with pending checks, or none yet and just updated. */
const watchingChecks = (pr: PrInfo | null) =>
   !!pr &&
   (pr.state === "open" || pr.state === "draft") &&
   (pr.checks === "pending" ||
      (pr.checks_total === 0 && Date.now() - Date.parse(pr.updated_at) < 5 * 60_000));

/**
 * The Session's git ref for the header: branch with ahead/behind, its GitHub repo and PR. Reloaded as the
 * Session's status changes, every minute (20s while checks are watched) while the window is visible, and
 * when it comes back (focus or visible again, at most once a second), which also bypasses the cached PR
 * without dimming. `refresh` bypasses it too, with `refreshing` until it loaded.
 */
function useGitRef(client: HarnessClient, s: SessionSummary | null): GitRef {
   const [status, setStatus] = useState<GitStatus | null>(null);
   const none = { repo: null, pr: null, base: null };
   const [gh, setGh] = useState<{ repo: RepoId | null; pr: PrInfo | null; base: string | null }>(
      none,
   );
   const [version, setVersion] = useState(0);
   const [refreshing, setRefreshing] = useState(false);
   const fresh = useRef(false);
   const watching = watchingChecks(gh.pr);
   const id = s?.workspace.repo_root ? s.id : null;
   const sessionStatus = s?.status;
   useEffect(() => {
      if (!id) {
         setStatus(null);
         setGh(none);
         setRefreshing(false);
         return;
      }
      let off = false;
      const load = (bypass = false) => {
         if (document.hidden) return;
         const wasFresh = fresh.current;
         fresh.current = false;
         if (wasFresh) setRefreshing(true);
         const api = client.sessionApi(id);
         Promise.allSettled([
            api.gitStatus().then(
               (g) => !off && setStatus(g),
               () => !off && setStatus(null),
            ),
            api.branchPr(wasFresh || watching || bypass).then(
               (r) => !off && setGh(r),
               () => !off && setGh(none),
            ),
         ]).then(() => !off && setRefreshing(false));
      };
      let lastBack = 0;
      const onBack = () => {
         if (document.hidden || Date.now() - lastBack < 1000) return;
         lastBack = Date.now();
         load(true);
      };
      load();
      const timer = setInterval(() => load(), watching ? 20_000 : 60_000);
      window.addEventListener("focus", onBack);
      document.addEventListener("visibilitychange", onBack);
      return () => {
         off = true;
         clearInterval(timer);
         window.removeEventListener("focus", onBack);
         document.removeEventListener("visibilitychange", onBack);
      };
   }, [client, id, sessionStatus, version, watching]);
   const refresh = useCallback(() => {
      fresh.current = true;
      setVersion((v) => v + 1);
   }, []);
   return { status, repo: gh.repo, pr: gh.pr, base: gh.base, refresh, refreshing };
}

/** What the main pane shows: a Session, or a Shared Artifact without a Session (ADR 0024). */
type Selection = { session: string } | { shared: string } | null;

function Shell({ transport }: { transport: Transport }) {
   const [client] = useState<HarnessClient>(() => new Client(transport));
   const [sessions, setSessions] = useState<SessionSummary[]>([]);
   const [selection, setSelection] = useState<Selection>(null);
   const selected = selection && "session" in selection ? selection.session : null;
   const sharedId = selection && "shared" in selection ? selection.shared : null;
   const setSelected = useCallback(
      (id: string | null) => setSelection(id ? { session: id } : null),
      [],
   );
   const openShared = useCallback((id: string) => setSelection({ shared: id }), []);
   const [attachOpen, setAttachOpen] = useState(false);
   /** "New Session with it": the Shared Artifact to attach once the Composer created the Session. */
   const attachOnCreate = useRef<string | null>(null);
   const sharedSource = useMemo(
      () => ({
         list: () => client.listSharedArtifacts(),
         // Content changes move `updated_ms` (the change dot), so they reload the list too.
         onListChanged: async (f: () => void) => {
            const offs = await Promise.all([client.sharedListChanged(f), client.sharedChanged(f)]);
            return () => {
               for (const off of offs) off();
            };
         },
      }),
      [client],
   );
   const sharedList = useSharedArtifacts(sharedSource);
   const [composer, setComposerOpen] = useState(false);
   /** Opens the Composer; `attach`: a Shared Artifact to attach to the new Session. */
   const setComposer = useCallback((o: boolean, attach: string | null = null) => {
      if (o) attachOnCreate.current = attach;
      setComposerOpen(o);
   }, []);
   /** Folder the Composer opens with (the + on a sidebar folder group); null: its own default. */
   const [composerFolder, setComposerFolder] = useState<string | null>(null);
   const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null);
   const [agentsVersion, setAgentsVersion] = useState(0);
   const [mcpVersion, setMcpVersion] = useState(0);
   const [toDelete, setToDelete] = useState<SessionSummary | null>(null);
   const [deleteError, setDeleteError] = useState<string | null>(null);
   const [deleting, setDeleting] = useState(false);
   const [menuError, setMenuError] = useState<string | null>(null);
   const [sidebarOpen, toggleSidebar] = useSidebarOpen();
   const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null);
   const [status, setStatus] = useState<HTMLDivElement | null>(null);
   const [indicator, setIndicator] = useState<HTMLSpanElement | null>(null);
   const [menu, setMenu] = useState<HTMLDivElement | null>(null);

   const report = useReportError();
   const update = useUpdate();

   // Cmd+, opens Settings (macOS convention). Capture phase, so the terminal or an editor never eats it.
   useEffect(() => {
      const onKey = (e: KeyboardEvent) => {
         if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key === ",") {
            e.preventDefault();
            e.stopPropagation();
            setSettingsSection((s) => s ?? "appearance");
         }
      };
      window.addEventListener("keydown", onKey, true);
      return () => window.removeEventListener("keydown", onKey, true);
   }, []);

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
                  // Also counts as activity, so "Recent activity" order updates live.
                  return l.map((s, n) =>
                     n === i
                        ? { ...s, status: e.status, title: e.title, updated_ms: Date.now() }
                        : s,
                  );
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

   // The Quick overlay's "Open in main window" (ADR 0022).
   useEffect(
      () =>
         listenHost("select-session", (id) => {
            if (typeof id !== "string") return;
            setSelected(id);
            client.listSessions().then(setSessions, (e) => report("Could not load sessions", e));
         }),
      [client, report, setSelected],
   );
   // The overlay's draft (a Quick Session nobody wrote in yet) is not listed until it is used.
   const listed = useMemo(() => hideUnusedQuick(sessions, selected), [sessions, selected]);

   const current = sessions.find((s) => s.id === selected) ?? null;
   const git = useGitRef(client, current);
   const sidebar = useSidebarWidth();
   const attention = sessions.filter((s) => !s.archived && s.status === "needs_attention").length;
   const refresh = useCallback(() => client.listSessions().then(setSessions), [client]);

   useEffect(() => {
      document.title = attention > 0 ? `(${attention}) Harness` : "Harness";
   }, [attention]);

   const toggleArchive = (s: SessionSummary) => {
      setMenuError(null);
      (s.archived ? client.unarchiveSession(s.id) : client.archiveSession(s.id))
         .then(refresh)
         .catch((e) => setMenuError(errText(e)));
   };
   /** The Quick group's +: no dialog. Stays on a Quick Session that is still unused. */
   const startQuick = async () => {
      const current = sessions.find((s) => s.id === selected);
      if (current?.quick && current.title === QUICK_TITLE) return;
      try {
         const [agents, frontends] = await Promise.all([
            client.listAgents(),
            client.listFrontends(),
         ]);
         const agent = quickAgent(sessions, agents);
         const frontend = frontends.find((f) => f.id === "chat") ?? frontends[0];
         // No Agent yet: the Composer offers to open the Agents settings.
         if (!agent || !frontend) return setComposer(true);
         const id = await client.createQuickSession({ agentId: agent.id, frontendId: frontend.id });
         setSelected(id);
         await refresh();
      } catch (e) {
         report("Could not start a Quick Session", e);
      }
   };
   // Leaving a Quick Session: the core removes it if it is still unused.
   const leaving = useRef(selected);
   useEffect(() => {
      const prev = leaving.current;
      leaving.current = selected;
      if (!prev || prev === selected) return;
      if (!sessions.find((s) => s.id === prev)?.quick) return;
      client
         .discardEmptySession(prev)
         .then(refresh)
         .catch((e) => report("Could not remove the empty Quick Session", e));
   }, [selected]);
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
   const controls = (
      <WindowControls
         sidebarOpen={sidebarOpen}
         onToggleSidebar={toggleSidebar}
         onNew={() => setComposer(true)}
      />
   );
   // Sidebar hidden: the controls move next to the traffic lights in the main header.
   const leading = sidebarOpen ? undefined : (
      <div className={cn("mr-2 flex shrink-0 items-center gap-1.5", trafficLights && "pl-[68px]")}>
         <DevBadge />
         {controls}
      </div>
   );

   return (
      <div className="flex h-full">
         {sidebarOpen && (
            <aside
               className="relative flex shrink-0 flex-col border-r bg-card"
               style={{ width: sidebar.width }}
            >
               <ResizeHandle label="Resize sidebar" {...sidebar.handle} />
               <div
                  data-tauri-drag-region
                  className={cn(
                     "flex h-13 shrink-0 items-center gap-1 pr-2",
                     trafficLights ? "pl-[76px]" : "pl-3",
                  )}
               >
                  <DevBadge />
                  <div data-tauri-drag-region className="h-full flex-1" />
                  {controls}
               </div>
               <SessionList
                  sessions={listed}
                  selected={selected}
                  onSelect={setSelected}
                  onArchive={toggleArchive}
                  onDelete={askDelete}
                  onNewQuick={() => void startQuick()}
                  onNewInFolder={(folder) => {
                     setComposerFolder(folder);
                     setComposer(true);
                  }}
               >
                  {menuError && (
                     <p role="alert" className="px-4 pb-2 text-xs text-destructive">
                        {menuError}
                     </p>
                  )}
               </SessionList>
               <SharedArtifactsSection
                  list={sharedList}
                  selected={sharedId}
                  onSelect={openShared}
               />
               <UpdateFooter update={update} />
            </aside>
         )}
         <main className="flex min-w-0 flex-1 flex-col">
            {sharedId ? (
               <SharedArtifactView
                  key={sharedId}
                  client={client}
                  id={sharedId}
                  sessions={sessions}
                  leading={leading}
                  onOpenSession={setSelected}
                  onAttach={() => setAttachOpen(true)}
                  onNewSession={() => setComposer(true, sharedId)}
                  onDeleted={() => setSelection(null)}
                  onOpenInEditor={() =>
                     client.openSharedInEditor(sharedId).catch((e) => {
                        if (errText(e).includes("choose an editor")) setSettingsSection("editor");
                        else report("Could not open in editor", e);
                     })
                  }
               />
            ) : current ? (
               <>
                  <SessionHeader
                     client={client}
                     session={current}
                     git={git}
                     leading={leading}
                     toolbarRef={setToolbar}
                     statusRef={setStatus}
                     indicatorRef={setIndicator}
                     menuRef={setMenu}
                     onOpenSettings={() => setSettingsSection("appearance")}
                     onOpenWindow={() =>
                        openViewWindow(current.id, current.title).catch((e) =>
                           report("Could not open window", e),
                        )
                     }
                     onChooseEditor={() => setSettingsSection("editor")}
                  />
                  <div className="min-h-0 flex-1">
                     <ViewHost
                        transport={transport}
                        sessionId={current.id}
                        frontendId={current.frontend_id}
                        toolbar={toolbar}
                        status={status}
                        indicator={indicator}
                        menu={menu}
                        onGitRefresh={git.refresh}
                        onOpenShared={openShared}
                     />
                  </div>
               </>
            ) : (
               <div className="relative grid flex-1 place-items-center text-sm text-muted-foreground">
                  {/* Overlay header: drag handle without pushing the message down. */}
                  <div
                     data-tauri-drag-region
                     className="absolute inset-x-0 top-0 flex h-13 items-center pl-5"
                  >
                     {leading}
                  </div>
                  Select or create a Session.
               </div>
            )}
         </main>
         <Dialog open={toDelete !== null} onOpenChange={(o) => !o && setToDelete(null)}>
            <DialogContent>
               <DialogHeader>
                  <DialogTitle>Delete Session?</DialogTitle>
                  <DialogDescription>
                     "{toDelete?.title}" and its log will be deleted
                     {toDelete?.quick
                        ? ", along with its folder and the files in it"
                        : toDelete?.workspace.worktree_branch
                          ? ", along with its Worktree and branch"
                          : ""}
                     . This cannot be undone.
                  </DialogDescription>
               </DialogHeader>
               {deleteError && (
                  <p role="alert" className="text-sm text-destructive">
                     {deleteError}
                  </p>
               )}
               <DialogFooter>
                  <Button variant="outline" onClick={() => setToDelete(null)}>
                     Cancel
                  </Button>
                  <Button
                     variant="destructive"
                     disabled={deleting}
                     onClick={() => void confirmDelete()}
                  >
                     {deleteError ? "Delete anyway" : "Delete"}
                  </Button>
               </DialogFooter>
            </DialogContent>
         </Dialog>
         {sharedId && (
            <AttachDialog
               open={attachOpen}
               onOpenChange={setAttachOpen}
               sessions={listed.filter((s) => !s.archived)}
               attached={sharedList?.find((e) => e.meta.id === sharedId)?.meta.attached ?? []}
               onPick={(sessionId) =>
                  client.attachSharedArtifact(sessionId, sharedId).then(() => {
                     setAttachOpen(false);
                     setSelected(sessionId);
                  })
               }
            />
         )}
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
         <ComposerDialog
            client={client}
            open={composer}
            onOpenChange={(o) => {
               setComposer(o);
               if (!o) setComposerFolder(null);
            }}
            folder={composerFolder}
            agentsVersion={agentsVersion}
            mcpVersion={mcpVersion}
            onManageAgents={() => {
               setComposer(false);
               setSettingsSection("agents");
            }}
            onCreated={(id) => {
               const shared = attachOnCreate.current;
               attachOnCreate.current = null;
               setSelected(id);
               refresh().catch((e) => report("Could not load sessions", e));
               if (shared)
                  client
                     .attachSharedArtifact(id, shared)
                     .catch((e) => report("Could not attach the shared artifact", e));
            }}
         />
      </div>
   );
}
