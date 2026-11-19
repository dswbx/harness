import type { HarnessClient, InstructionsScope, SessionSummary, Transport } from "@harness/api";
import {
   HarnessClient as Client,
   errText,
   forgetSession,
   useSharedArtifacts,
   useTasks,
} from "@harness/api";
import { cn, ResizeHandle } from "@harness/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ComposerDialog } from "../composer/ComposerDialog";
import { useStartFromTask } from "../composer/useStartFromTask";
import { listenHost } from "../overlay/overlayHost";
import { sharedView, tasksView } from "../platform/frontends";
import { openViewWindow } from "../platform/openWindow";
import { useReportError } from "../platform/toast";
import { ViewHost } from "../platform/ViewHost";
import { useQuickLifecycle } from "../quick/useQuickLifecycle";
import { SessionHeader, trafficLights } from "../session-header/SessionHeader";
import { useGitRef } from "../session-header/useGitRef";
import { DeleteSessionDialog } from "../sessions/DeleteSessionDialog";
import { forgetGone, withSubSessions } from "../sessions/forgetGone";
import { SessionList } from "../sessions/SessionList";
import { SessionRenameDialog } from "../sessions/SessionRenameDialog";
import { hideUnusedQuick } from "../sessions/sessionGroups";
import { useMarkSeen } from "../sessions/useMarkSeen";
import { useSessions } from "../sessions/useSessions";
import { useTurnNotices } from "../sessions/useTurnNotices";
import { SettingsDialog, type SettingsSection } from "../settings/SettingsDialog";
import { sectionStore } from "../settings/settingsStore";
import { AttachDialog } from "../shared-artifacts/AttachDialog";
import { SharedArtifactsSection } from "../shared-artifacts/SharedArtifactsSection";
import { TasksEntry } from "../tasks/TasksEntry";
import { UpdateFooter } from "../updates/UpdateFooter";
import { useUpdate } from "../updates/updates";
import { needsEditor } from "./editorError";
import { useNavHistory } from "./useNavHistory";
import { useSidebarOpen, useSidebarWidth } from "./useSidebar";
import { DevBadge, WindowControls } from "./WindowControls";

/**
 * What the main pane shows: a Session, a Shared Artifact without a Session (ADR 0024), or All tasks with the
 * task in its preview (null: none; ADR 0028).
 */
type Selection = { session: string } | { shared: string } | { tasks: string | null } | null;
const selectionKey = (s: Selection) =>
   !s
      ? ""
      : "session" in s
        ? `session:${s.session}`
        : "shared" in s
          ? `shared:${s.shared}`
          : `tasks:${s.tasks ?? ""}`;

export function Shell({ transport }: { transport: Transport }) {
   const client = useMemo<HarnessClient>(() => new Client(transport), [transport]);
   const [agentsVersion, setAgentsVersion] = useState(0);
   const bumpAgents = useCallback(() => setAgentsVersion((v) => v + 1), []);
   const { sessions, setSessions } = useSessions(client, bumpAgents);
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
   // Back/forward skip what was deleted since (the shared list still loading: keep it).
   const canShow = useCallback(
      (s: Selection) =>
         !!s &&
         ("session" in s
            ? sessions.some((x) => x.id === s.session)
            : "shared" in s
              ? !sharedList || sharedList.some((e) => e.meta.id === s.shared)
              : true),
      [sessions, sharedList],
   );
   const nav = useNavHistory<Selection>(null, selectionKey, canShow);
   const selection = nav.current;
   const setSelection = nav.go;
   const selected = selection && "session" in selection ? selection.session : null;
   const sharedId = selection && "shared" in selection ? selection.shared : null;
   const setSelected = useCallback(
      (id: string | null) => setSelection(id ? { session: id } : null),
      [setSelection],
   );
   const openShared = useCallback((id: string) => setSelection({ shared: id }), [setSelection]);
   const inTasks = selection !== null && "tasks" in selection;
   const taskId = selection && "tasks" in selection ? selection.tasks : null;
   const openTasks = useCallback(
      (id?: string | null) => setSelection({ tasks: id ?? null }),
      [setSelection],
   );
   const [attachOpen, setAttachOpen] = useState(false);
   /** "New Session with it": the Shared Artifact to attach once the Composer created the Session. */
   const attachOnCreate = useRef<string | null>(null);
   const tasks = useTasks(client);
   const fromTask = useStartFromTask({
      client,
      onCreated: (id) => {
         setSelected(id);
         client.listSessions().then(setSessions, (e) => report("Could not load sessions", e));
      },
      agentsVersion,
   });
   const [composer, setComposerOpen] = useState(false);
   /** Opens the Composer; `attach`: a Shared Artifact to attach to the new Session. */
   const setComposer = useCallback((o: boolean, attach: string | null = null) => {
      if (o) attachOnCreate.current = attach;
      setComposerOpen(o);
   }, []);
   /** Folder the Composer opens with (the + on a sidebar folder group); null: its own default. */
   const [composerFolder, setComposerFolder] = useState<string | null>(null);
   const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null);
   // Settings > Instructions opened from a Session's Harness context: that scope first.
   const [instructionsScope, setInstructionsScope] = useState<InstructionsScope | null>(null);
   // The next open lands on the last section shown, also after a restart.
   useEffect(() => {
      if (settingsSection) sectionStore.set(settingsSection);
   }, [settingsSection]);
   const [mcpVersion, setMcpVersion] = useState(0);
   const [toDelete, setToDelete] = useState<SessionSummary | null>(null);
   const [renaming, setRenaming] = useState<SessionSummary | null>(null);
   const [deleteError, setDeleteError] = useState<string | null>(null);
   const [deleting, setDeleting] = useState(false);
   const subSessionCount = toDelete
      ? sessions.filter((s) => s.parent?.session_id === toDelete.id).length
      : 0;
   const [menuError, setMenuError] = useState<string | null>(null);
   const [sidebarOpen, toggleSidebar] = useSidebarOpen();
   const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null);
   const [status, setStatus] = useState<HTMLDivElement | null>(null);
   const [indicator, setIndicator] = useState<HTMLSpanElement | null>(null);
   const [menu, setMenu] = useState<HTMLDivElement | null>(null);

   const report = useReportError();
   const SharedView = sharedView();
   const TasksView = tasksView();
   const update = useUpdate();

   // Cmd+, opens Settings (macOS convention). Capture phase, so the terminal or an editor never eats it.
   useEffect(() => {
      const onKey = (e: KeyboardEvent) => {
         if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key === ",") {
            e.preventDefault();
            e.stopPropagation();
            setSettingsSection((s) => s ?? sectionStore.get());
         }
      };
      window.addEventListener("keydown", onKey, true);
      return () => window.removeEventListener("keydown", onKey, true);
   }, []);

   const { back, forward } = nav;
   // Back/forward from the app menu (View > Back / Forward, Opt+Cmd+Left / Right).
   useEffect(
      () =>
         listenHost("nav", (dir) => {
            if (dir === "back") back();
            else if (dir === "forward") forward();
         }),
      [back, forward],
   );
   // Back/forward: Cmd+[ / Cmd+] (not while typing) and the mouse's back/forward buttons.
   useEffect(() => {
      const typing = (t: EventTarget | null) =>
         t instanceof HTMLElement &&
         (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA");
      const onKey = (e: KeyboardEvent) => {
         if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || typing(e.target)) return;
         if (e.key === "[") back();
         else if (e.key === "]") forward();
         else return;
         e.preventDefault();
      };
      const onMouse = (e: MouseEvent) => {
         if (e.button === 3) back();
         else if (e.button === 4) forward();
      };
      window.addEventListener("keydown", onKey);
      window.addEventListener("mouseup", onMouse);
      return () => {
         window.removeEventListener("keydown", onKey);
         window.removeEventListener("mouseup", onMouse);
      };
   }, [back, forward]);

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
   useMarkSeen(client, current);
   useTurnNotices(client, sessions, selected, setSelected);
   const currentParent = current?.parent
      ? sessions.find((s) => s.id === current.parent?.session_id)
      : undefined;
   const git = useGitRef(client, current);
   const sidebar = useSidebarWidth();
   const attention = sessions.filter((s) => !s.archived && s.status === "needs_attention").length;
   // A Turn is in flight somewhere: a restart to update would cut it off.
   const busy = sessions.some((s) => s.status !== "idle");
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
   const { startQuick, agentSwitch } = useQuickLifecycle({
      client,
      sessions,
      selected,
      setSelected,
      setComposer,
      refresh,
      report,
      agentsVersion,
   });
   const resetTitle = (s: SessionSummary) =>
      client.resetSessionTitle(s.id).catch((e) => report("Could not reset the title", e));
   const askDelete = (s: SessionSummary) => {
      setToDelete(s);
      setDeleteError(null);
   };
   /** First attempt is safe; once the core refused, the same button becomes "Delete anyway". */
   const confirmDelete = async () => {
      if (!toDelete) return;
      setDeleting(true);
      try {
         const ids = withSubSessions(sessions, toDelete.id);
         try {
            await client.deleteSession(toDelete.id, deleteError !== null);
            for (const id of ids) forgetSession(id);
         } catch (e) {
            // Failed partway: the Sessions the core did remove lose their local state too.
            await forgetGone(client, ids);
            throw e;
         }
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
         onBack={nav.canBack ? nav.back : undefined}
         onForward={nav.canForward ? nav.forward : undefined}
         onNew={() => setComposer(true)}
      />
   );
   // Sidebar hidden: the controls move next to the traffic lights in the main header.
   const leading = sidebarOpen ? undefined : (
      <div className={cn("mr-2 flex shrink-0 items-center gap-1.5", trafficLights && "pl-[68px]")}>
         {controls}
         <DevBadge />
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
                  <div data-tauri-drag-region className="h-full flex-1" />
                  <DevBadge />
                  {controls}
               </div>
               <SessionList
                  sessions={listed}
                  selected={selected}
                  onSelect={setSelected}
                  onArchive={toggleArchive}
                  onDelete={askDelete}
                  onRename={setRenaming}
                  onResetTitle={resetTitle}
                  onOpenWindow={(s) =>
                     openViewWindow(s.id, s.title).catch((e) => report("Could not open window", e))
                  }
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
               {TasksView && (
                  <TasksEntry tasks={tasks} selected={inTasks} onOpen={() => openTasks(null)} />
               )}
               <SharedArtifactsSection
                  list={sharedList}
                  selected={sharedId}
                  onSelect={openShared}
               />
               <UpdateFooter update={update} busy={busy} />
            </aside>
         )}
         <main className="flex min-w-0 flex-1 flex-col">
            {inTasks && TasksView ? (
               <TasksView
                  client={client}
                  selected={taskId}
                  onSelect={openTasks}
                  sessions={sessions}
                  onOpenSession={setSelected}
                  onStartFromTask={fromTask.start}
                  leading={leading}
               />
            ) : sharedId ? (
               SharedView && (
                  <SharedView
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
                           if (needsEditor(e)) setSettingsSection("editor");
                           else report("Could not open in editor", e);
                        })
                     }
                  />
               )
            ) : current ? (
               <>
                  <SessionHeader
                     client={client}
                     session={current}
                     parent={currentParent}
                     onRename={() => setRenaming(current)}
                     onOpenParent={() => currentParent && setSelected(currentParent.id)}
                     git={git}
                     leading={leading}
                     toolbarRef={setToolbar}
                     statusRef={setStatus}
                     indicatorRef={setIndicator}
                     menuRef={setMenu}
                     onOpenSettings={() => setSettingsSection(sectionStore.get())}
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
                        agentSwitch={agentSwitch}
                        onOpenShared={openShared}
                        onOpenSession={setSelected}
                        onOpenTasks={TasksView ? openTasks : undefined}
                        onOpenInstructions={(scope) => {
                           setInstructionsScope(scope);
                           setSettingsSection("instructions");
                        }}
                        onStartFromTask={fromTask.start}
                        sessions={sessions}
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
         <SessionRenameDialog
            client={client}
            session={renaming}
            onClose={() => setRenaming(null)}
         />
         <DeleteSessionDialog
            toDelete={toDelete}
            subSessionCount={subSessionCount}
            deleteError={deleteError}
            deleting={deleting}
            onCancel={() => setToDelete(null)}
            onConfirm={() => void confirmDelete()}
         />
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
         {fromTask.dialog}
         <SettingsDialog
            client={client}
            open={settingsSection !== null}
            onOpenChange={(o) => {
               if (o) return;
               setSettingsSection(null);
               setInstructionsScope(null);
            }}
            section={settingsSection ?? "appearance"}
            onSectionChange={setSettingsSection}
            instructionsScope={instructionsScope}
            sessionId={selected}
            busy={busy}
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
            sessions={sessions}
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
