import {
   type HarnessClient,
   revealPath,
   type SharedArtifactMeta,
   type StatePatchOp,
} from "@harness/api";
import {
   Button,
   Dialog,
   DialogContent,
   DialogDescription,
   DialogFooter,
   DialogHeader,
   DialogTitle,
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuTrigger,
   Input,
   ScrollArea,
} from "@harness/ui";
import {
   ChevronRight,
   FolderOpen,
   MoreHorizontal,
   Pencil,
   Plus,
   Share2,
   Trash2,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { sessionCount } from "./ArtifactsPanel";
import { RenderUi, type UiEnv } from "./RenderUi";
import { useSharedArtifact } from "./renderUi/sharedSource";
import { formatRelativeTime, useNow } from "./time";
import { sharedNode } from "./tools";

const KIND: Record<SharedArtifactMeta["kind"], string> = { md: "Markdown", html: "HTML", ui: "UI" };

const noSession = () => Promise.reject(new Error("This view has no Session."));

/**
 * A Shared Artifact without a Session (ADR 0024), for the app's main pane: a header with its actions,
 * the artifact (same renderer and sandbox as its Panel; inputs write the artifact's state), and a
 * column with the Sessions it is attached in and its activity (from its meta).
 */
export function SharedArtifactView({
   client,
   id,
   sessions,
   onOpenSession,
   onAttach,
   onNewSession,
   onRenamed,
   onDeleted,
   onOpenInEditor,
   leading,
}: {
   client: HarnessClient;
   id: string;
   /** For Session titles in "Attached in"; Sessions not listed show as "Session". */
   sessions: readonly { id: string; title: string }[];
   onOpenSession: (sessionId: string) => void;
   /** "Attach to Session…": the host asks which Session. */
   onAttach: () => void;
   /** "New Session with it": the host creates a Session, then attaches the artifact. */
   onNewSession: () => void;
   onRenamed?: (meta: SharedArtifactMeta) => void;
   onDeleted?: (id: string) => void;
   /** Opens the artifact's folder in the user's editor; default: shows it in the file manager. */
   onOpenInEditor?: (dir: string) => void;
   /** Before the title in the header, e.g. the host's window controls when its sidebar is hidden. */
   leading?: ReactNode;
}) {
   const env = useMemo<UiEnv>(
      () => ({
         state: {},
         patch: noSession,
         send: noSession,
         files: {},
         readShared: (x) => client.readSharedArtifact(x),
         watchShared: (f) => client.sharedChanged(f),
         patchShared: (x, ops: StatePatchOp[]) => client.patchArtifactState(x, ops),
      }),
      [client],
   );
   const shown = useSharedArtifact(id, env.readShared, env.watchShared);
   const data = shown && "data" in shown ? shown.data : null;
   const meta = data?.meta;
   const now = useNow();
   const [dialog, setDialog] = useState<"rename" | "delete" | null>(null);
   const [error, setError] = useState<string | null>(null);
   const act = (f: () => Promise<unknown>) => {
      setError(null);
      f().catch((e) => setError(e instanceof Error ? e.message : String(e)));
   };
   const titleOf = (sid: string) => sessions.find((s) => s.id === sid)?.title ?? "Session";
   const root = useMemo(() => sharedNode(id), [id]);

   if (shown && "missing" in shown)
      return (
         <div className="grid h-full place-items-center bg-background text-sm text-muted-foreground">
            This shared artifact does not exist anymore.
         </div>
      );
   return (
      <div className="flex h-full min-h-0 flex-col bg-background">
         <header
            data-tauri-drag-region
            className="flex h-13 shrink-0 items-center gap-2 border-b px-4"
         >
            {leading}
            <Share2 className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate text-sm font-medium">{meta?.title ?? id}</span>
            {meta && (
               <>
                  <span className="shrink-0 rounded border px-1 text-[10px] font-medium text-muted-foreground">
                     {KIND[meta.kind]}
                  </span>
                  <span className="hidden shrink-0 text-xs whitespace-nowrap text-muted-foreground sm:inline">
                     Edited {formatRelativeTime(meta.updated_ms, now)}
                  </span>
               </>
            )}
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
               <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                     <Button
                        size="icon"
                        variant="ghost"
                        className="size-8 data-[state=open]:bg-accent"
                        aria-label="Artifact options"
                        disabled={!meta}
                     >
                        <MoreHorizontal />
                     </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-44">
                     <DropdownMenuItem onSelect={() => setDialog("rename")}>
                        <Pencil /> Rename
                     </DropdownMenuItem>
                     <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onSelect={() => setDialog("delete")}
                     >
                        <Trash2 /> Delete
                     </DropdownMenuItem>
                  </DropdownMenuContent>
               </DropdownMenu>
               <Button
                  size="sm"
                  variant="outline"
                  disabled={!data}
                  onClick={() =>
                     data &&
                     (onOpenInEditor ? onOpenInEditor(data.dir) : act(() => revealPath(data.dir)))
                  }
               >
                  <FolderOpen /> Open in editor
               </Button>
               <Button size="sm" variant="outline" onClick={onAttach}>
                  Attach to Session…
               </Button>
               <Button size="sm" onClick={onNewSession}>
                  <Plus /> New Session with it
               </Button>
            </div>
         </header>
         {error && <p className="px-4 pt-2 text-xs text-destructive">{error}</p>}
         <div className="flex min-h-0 flex-1">
            <ScrollArea className="min-h-0 min-w-0 flex-1">
               <div className="mx-auto max-w-3xl p-6">
                  <RenderUi root={root} env={env} />
               </div>
            </ScrollArea>
            <aside className="hidden w-[320px] shrink-0 border-l md:block">
               <ScrollArea className="h-full">
                  <div className="p-4">
                     <Section title="Attached in">
                        {meta && (meta.attached ?? []).length === 0 && (
                           <p className="px-2 py-1.5 text-xs text-muted-foreground">
                              Not attached to any Session.
                           </p>
                        )}
                        {(meta?.attached ?? []).map((sid) => (
                           <button
                              key={sid}
                              type="button"
                              onClick={() => onOpenSession(sid)}
                              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-accent"
                           >
                              <span className="min-w-0 flex-1 truncate">{titleOf(sid)}</span>
                              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                           </button>
                        ))}
                        {meta && (
                           <p className="px-2 pt-1 text-[11px] text-muted-foreground">
                              {sessionCount(meta)}
                           </p>
                        )}
                     </Section>
                     {meta && (
                        <Section title="Activity">
                           <Activity
                              text={`Created in ${meta.created_by.session_title || "a Session"}`}
                              ts={meta.created_ms}
                              now={now}
                           />
                           {meta.updated_ms > meta.created_ms && (
                              <Activity text="Updated" ts={meta.updated_ms} now={now} />
                           )}
                           {(meta.attached ?? []).map((sid) => (
                              <Activity key={sid} text={`Attached to ${titleOf(sid)}`} now={now} />
                           ))}
                        </Section>
                     )}
                  </div>
               </ScrollArea>
            </aside>
         </div>
         {meta && (
            <RenameDialog
               open={dialog === "rename"}
               title={meta.title}
               onClose={() => setDialog(null)}
               onRename={async (title) => {
                  const m = await client.renameSharedArtifact(id, title);
                  onRenamed?.(m);
               }}
            />
         )}
         <Dialog open={dialog === "delete"} onOpenChange={(o) => !o && setDialog(null)}>
            <DialogContent>
               <DialogHeader>
                  <DialogTitle>Delete shared artifact?</DialogTitle>
                  <DialogDescription>
                     "{meta?.title ?? id}" and its folder will be deleted. Sessions that attached it
                     show it as missing. This cannot be undone.
                  </DialogDescription>
               </DialogHeader>
               <DialogFooter>
                  <Button variant="outline" onClick={() => setDialog(null)}>
                     Cancel
                  </Button>
                  <Button
                     variant="destructive"
                     onClick={() => {
                        setDialog(null);
                        act(async () => {
                           await client.deleteSharedArtifact(id);
                           onDeleted?.(id);
                        });
                     }}
                  >
                     Delete
                  </Button>
               </DialogFooter>
            </DialogContent>
         </Dialog>
      </div>
   );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
   return (
      <section className="mb-5">
         <h3 className="px-2 pb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            {title}
         </h3>
         {children}
      </section>
   );
}

function Activity({ text, ts, now }: { text: string; ts?: number; now: number }) {
   return (
      <div className="flex items-baseline gap-2 px-2 py-1 text-[13px]">
         <span className="min-w-0 flex-1 truncate">{text}</span>
         {ts !== undefined && (
            <time
               dateTime={new Date(ts).toISOString()}
               className="shrink-0 text-xs text-muted-foreground"
            >
               {formatRelativeTime(ts, now)}
            </time>
         )}
      </div>
   );
}

function RenameDialog({
   open,
   title,
   onClose,
   onRename,
}: {
   open: boolean;
   title: string;
   onClose: () => void;
   onRename: (title: string) => Promise<void>;
}) {
   const [value, setValue] = useState(title);
   const [error, setError] = useState<string | null>(null);
   useEffect(() => {
      if (open) {
         setValue(title);
         setError(null);
      }
   }, [open, title]);
   const save = () => {
      const t = value.trim();
      if (!t) return;
      onRename(t).then(onClose, (e) => setError(e instanceof Error ? e.message : String(e)));
   };
   return (
      <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
         <DialogContent>
            <DialogHeader>
               <DialogTitle>Rename shared artifact</DialogTitle>
               <DialogDescription>The id and folder stay the same.</DialogDescription>
            </DialogHeader>
            <Input
               autoFocus
               value={value}
               onChange={(e) => setValue(e.target.value)}
               onKeyDown={(e) => e.key === "Enter" && save()}
               aria-label="Title"
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
               <Button variant="outline" onClick={onClose}>
                  Cancel
               </Button>
               <Button disabled={!value.trim()} onClick={save}>
                  Rename
               </Button>
            </DialogFooter>
         </DialogContent>
      </Dialog>
   );
}
