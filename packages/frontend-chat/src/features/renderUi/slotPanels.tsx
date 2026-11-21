import type { SharedArtifactMeta } from "@harness/api";
import { formatAgeAgo, formatDateTime } from "@harness/api";
import { DropdownMenuItem, DropdownMenuSeparator, ScrollArea, Tooltip } from "@harness/ui";
import { Copy, ExternalLink, Layers, Pencil, Share2, Trash2, Unlink, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatRelativeTime, useNow } from "../../lib/time";
import { definePanelFamily } from "../../panels/contract";
import { PanelHeader } from "../../panels/PanelHeader";
import { sessionCount } from "../artifacts/ArtifactsPanel";
import { blockMarkdown, collectArtifacts } from "../artifacts/artifacts";
import { artifactsPanel } from "../artifacts/panel";
import { renderUiOf } from "../conversation/chatRows";
import { quotableAttrs } from "../review/SelectionComment";
import { DeletePanelDialog } from "./DeletePanelDialog";
import { addedPanelId, closePanel, isClosed, useDockedPanels } from "./dockedPanels";
import { EditPanelPopover } from "./EditPanelPopover";
import { iconFor } from "./panelIcon";
import { RenderUi, type UiEnv } from "./RenderUi";
import { useEnv } from "./runtime";
import { lastSlot, nextSeen, type Slot, slotDot, slotRef, slotToAutoOpen } from "./slots";
import { useSourceStamps } from "./source";
import { sharedNode, sharedNodeId, sharedRef } from "./tools";
import { FillFrame } from "./UiHtml";

/**
 * "5m ago" at the right of a panel header. It takes only the room the title leaves and hides when
 * that room is too small, so the title always wins.
 */
function UpdatedAgo({ ts }: { ts: number }) {
   const now = useNow();
   return (
      <div className="@container min-w-0 flex-1 basis-0">
         <Tooltip content={formatDateTime(ts)}>
            <time
               dateTime={new Date(ts).toISOString()}
               className="hidden text-right text-[11px] whitespace-nowrap text-muted-foreground @min-[3.5rem]:block"
            >
               {formatAgeAgo(ts, now)}
            </time>
         </Tooltip>
      </div>
   );
}

/** Share icon in a shared Panel's header; hover shows that it is shared, its Session count and last update. */
function SharedBadge({ meta }: { meta: SharedArtifactMeta | undefined }) {
   const now = useNow();
   return (
      <Tooltip
         content={
            <div className="flex flex-col gap-0.5">
               <span className="font-medium">Shared artifact</span>
               {meta && (
                  <>
                     <span>Attached in {sessionCount(meta)}</span>
                     <span>Updated {formatRelativeTime(meta.updated_ms, now)}</span>
                  </>
               )}
            </div>
         }
      >
         <span
            role="img"
            aria-label="Shared artifact"
            tabIndex={0}
            className="flex shrink-0 items-center text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
         >
            <Share2 className="size-3.5" />
         </span>
      </Tooltip>
   );
}

/** Copies the absolute path of a panel source file (read through the core, which knows panels_dir). */
async function copySourcePath(env: UiEnv, name: string) {
   try {
      const r = await env.readSource!(name);
      await navigator.clipboard.writeText(r.path ?? name);
   } catch (e) {
      console.error("copy path failed", e);
   }
}

/**
 * `updated`: when it last changed (its latest call, or a later write of its source file). `shared`:
 * the Shared Artifact it shows (ADR 0024): a share icon with its details on hover, and its menu.
 */
export function SlotPanel({
   slot,
   env,
   updated,
   shared,
   onShare,
   onShowInArtifacts,
   onEdit,
   onDelete,
   onClose,
}: {
   slot: Slot;
   env: UiEnv;
   updated: number;
   /**
    * Saves the panel's title and icon (the Agent's own value as `null`): `EditPanel`, or for a shared one
    * `RenameSharedArtifact`. Absent for a panel the user made from a diagram or table (no render_ui id).
    */
   onEdit?: (title: string | null, icon: string | null) => Promise<void>;
   /** Takes the panel out of the dock; the artifact stays in the Artifacts panel. */
   onClose?: () => void;
   /** Deletes the panel (`DeletePanel`); not for a shared one (it detaches). */
   onDelete?: () => Promise<void>;
   /** Opens the Artifacts panel on this panel's detail page. */
   onShowInArtifacts: () => void;
   /** Offers "Make shared" (ADR 0024); only for a panel that is not shared yet. */
   onShare?: () => void;
   shared?: {
      meta: SharedArtifactMeta | undefined;
      onDetach: () => void;
      onOpenOutside?: () => void;
   };
}) {
   // One Html node, or a shared HTML artifact (its `Shared` node loads the HTML later): the frame
   // fills the panel and scrolls itself, no padding.
   const fill =
      slot.root.type === "Html" || (!!sharedNodeId(slot.root) && shared?.meta?.kind === "html");
   // A file in this Session's panels_dir (not a Shared Artifact's).
   const localSource = slot.source && !sharedRef(slot.source) ? slot.source : null;
   const [dialog, setDialog] = useState<"edit" | "delete" | null>(null);
   const label = slot.title ?? slot.id;
   return (
      <>
         <PanelHeader
            title={
               !onEdit ? (
                  label
               ) : (
                  <EditPanelPopover
                     id={slot.id}
                     open={dialog === "edit"}
                     onOpenChange={(o) => setDialog(o ? "edit" : null)}
                     title={label}
                     icon={slot.icon}
                     agent={slot.agent}
                     shared={!!shared}
                     onSave={onEdit}
                  >
                     {label}
                  </EditPanelPopover>
               )
            }
            menu={
               <>
                  {onEdit && (
                     <DropdownMenuItem onSelect={() => setDialog("edit")}>
                        <Pencil /> Rename and icon…
                     </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onSelect={onShowInArtifacts}>
                     <Layers /> Show in Artifacts
                  </DropdownMenuItem>
                  {onClose && (
                     <DropdownMenuItem onSelect={onClose}>
                        <X /> Close panel
                     </DropdownMenuItem>
                  )}
                  {localSource && env.readSource && (
                     <DropdownMenuItem onSelect={() => void copySourcePath(env, localSource)}>
                        <Copy /> Copy file path
                     </DropdownMenuItem>
                  )}
                  {(onShare || shared) && <DropdownMenuSeparator />}
                  {onShare ? (
                     <DropdownMenuItem onSelect={onShare}>
                        <Share2 /> Make shared
                     </DropdownMenuItem>
                  ) : (
                     shared && (
                        <>
                           {shared.onOpenOutside && (
                              <DropdownMenuItem onSelect={shared.onOpenOutside}>
                                 <ExternalLink /> Open outside Session
                              </DropdownMenuItem>
                           )}
                           <DropdownMenuItem onSelect={shared.onDetach}>
                              <Unlink /> Detach from Session
                           </DropdownMenuItem>
                        </>
                     )
                  )}
                  {onDelete && !shared && (
                     <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                           className="text-destructive focus:text-destructive"
                           onSelect={() => setDialog("delete")}
                        >
                           <Trash2 /> Delete panel…
                        </DropdownMenuItem>
                     </>
                  )}
               </>
            }
         >
            {shared && <SharedBadge meta={shared.meta} />}
            {updated > 0 && <UpdatedAgo ts={updated} />}
         </PanelHeader>
         {onDelete && (
            <DeletePanelDialog
               open={dialog === "delete"}
               title={label}
               file={localSource}
               onClose={() => setDialog(null)}
               onDelete={onDelete}
            />
         )}
         {fill ? (
            <div
               className="relative min-h-0 flex-1"
               {...quotableAttrs(null, false, { source: "artifact", label: slot.title ?? slot.id })}
            >
               <FillFrame.Provider value>
                  <RenderUi root={slot.root} env={{ ...env, files: slot.files, item: slot.id }} />
               </FillFrame.Provider>
            </div>
         ) : (
            <ScrollArea className="min-h-0 flex-1">
               <div
                  className="p-4"
                  {...quotableAttrs(null, false, {
                     source: "artifact",
                     label: slot.title ?? slot.id,
                  })}
               >
                  <RenderUi root={slot.root} env={{ ...env, files: slot.files, item: slot.id }} />
               </div>
            </ScrollArea>
         )}
      </>
   );
}

type Placed = { slot: Slot; side: "left" | "right" };

export type SlotsModel = {
   /** The render_ui items placed left or right, in first-seen order: left ones, then right ones. */
   placed: Placed[];
   byId: ReadonlyMap<string, Slot>;
   /** Ids of the panels with a change dot (changed while closed). */
   dots: ReadonlySet<string>;
   updatedAt: (slot: Slot) => number;
   /** Takes panel `id`, last called at `ts`, out of the dock (`dockedPanels`). */
   close: (id: string, ts: number) => void;
};

const NO_METAS: ReadonlyMap<string, SharedArtifactMeta> = new Map();
const isShared = (source: string | null) => !!sharedRef(source);

/**
 * render_ui items placed left or right are panels (`slot:<id>`, ADR 0019). Their default place follows the
 * placement. A panel showing a Shared Artifact takes the artifact's title (it can be renamed). A dot on the
 * icon marks changes made while it was closed (its first sight counts as seen), including writes of a source
 * file. The newest item the Agent adds or changes while the Session is open shows at once (not replayed ones).
 * Shown in the Quick Overlay (it has no other panels, ADR 0022 Phase 2).
 */
export const slotPanels = definePanelFamily<SlotsModel>({
   prefix: "slot",
   useModel: ({ api, state, host, open, isOpen }) => {
      const { left, right } = renderUiOf(state.items, state.sharedAttached, state.panelEdits).slots;
      const metas = host.sharedMetas ?? NO_METAS;
      const docked = useDockedPanels(api.sessionId);
      const { added: addedKeys } = docked.value;
      const dockedNow = docked.value;
      // Artifacts the user made into panels (only read when there are any).
      const added = useMemo(() => {
         if (addedKeys.length === 0) return [];
         const all = collectArtifacts(state.items, state.panelEdits);
         const out: Slot[] = [];
         for (const key of addedKeys) {
            const sharedId = key.startsWith("shared:") ? key.slice(7) : null;
            if (sharedId) {
               if (!state.sharedAttached.some((x) => x.id === sharedId)) continue;
               out.push({
                  id: addedPanelId(key),
                  title: null,
                  icon: null,
                  root: sharedNode(sharedId),
                  files: {},
                  ts: 0,
                  source: key,
                  agent: null,
               });
               continue;
            }
            const a = all.find((x) => x.key === key);
            if (!a) continue;
            out.push({
               id: addedPanelId(key),
               title: a.title,
               icon: a.icon ?? null,
               root: a.ui?.root ?? { type: "Markdown", props: { text: blockMarkdown(a) } },
               files: a.ui?.files ?? {},
               ts: a.ts,
               source: a.file ?? null,
               agent: null,
            });
         }
         return out;
      }, [addedKeys, state.items, state.panelEdits, state.sharedAttached]);
      const placed = useMemo(() => {
         const titled = (slot: Slot) => {
            const id = sharedRef(slot.source);
            const meta = id ? metas.get(id) : undefined;
            const title = meta?.title;
            const icon = meta?.icon ?? slot.icon;
            return (title && title !== slot.title) || icon !== slot.icon
               ? { ...slot, title: title || slot.title, icon }
               : slot;
         };
         const shown = (slot: Slot) => !isClosed(dockedNow, slot.id, slot.ts);
         const ids = new Set([...left, ...right].map((x) => x.id));
         return [
            ...left.filter(shown).map((slot): Placed => ({ slot: titled(slot), side: "left" })),
            ...right.filter(shown).map((slot): Placed => ({ slot: titled(slot), side: "right" })),
            // An added one the Agent has since placed is already there.
            ...added
               .filter((slot) => !ids.has(slot.id))
               .map((slot): Placed => ({ slot: titled(slot), side: "right" })),
         ];
      }, [left, right, added, dockedNow, metas]);

      // File-backed panels (ADR 0023): their files' hashes and write times.
      const sourceNames = useMemo(
         () =>
            [
               ...new Set(
                  placed.flatMap(({ slot }) =>
                     slot.source && !sharedRef(slot.source) ? [slot.source] : [],
                  ),
               ),
            ].sort(),
         [placed],
      );
      const stamps = useSourceStamps(api.panelSourceRead, api.panelSourceChanged, sourceNames);
      const updatedAt = useMemo(
         () => (x: Slot) => {
            const id = sharedRef(x.source);
            if (id) return metas.get(id)?.updated_ms ?? 0;
            return Math.max(x.ts, x.source ? (stamps[x.source]?.mtime ?? 0) : 0);
         },
         [metas, stamps],
      );

      const [seen, setSeen] = useState<Record<string, string>>({});
      useEffect(() => {
         setSeen((prev) =>
            nextSeen(
               prev,
               placed.map((p) => p.slot),
               stamps,
               isShared,
               (slot) => isOpen(slotRef(slot.id)),
            ),
         );
      });

      const [openedAt] = useState(() => Date.now());
      // Read in the effect only: closing or reopening a panel is no reason to show the newest.
      const dockedRef = useRef(dockedNow);
      dockedRef.current = dockedNow;
      // From the Agent's panels, closed ones too: closing the newest must not open the one before it. Panels the
      // user made are left out (opened by hand; closing one drops it, which would make an older one the newest).
      const newest = useMemo(() => lastSlot([...left, ...right]), [left, right]);
      useEffect(() => {
         const slot = slotToAutoOpen(newest, openedAt);
         if (slot && !isClosed(dockedRef.current, slot.id, slot.ts)) open(slotRef(slot.id));
      }, [newest?.id, newest?.ts, openedAt, open]);

      // The dots depend on which panel is open now (read here, in the render).
      const dotIds = placed
         .filter((p) => slotDot(p.slot, isOpen(slotRef(p.slot.id)), seen, stamps))
         .map((p) => p.slot.id)
         .join("\n");
      const dots = useMemo(() => new Set(dotIds ? dotIds.split("\n") : []), [dotIds]);
      const { update } = docked;
      const close = useCallback(
         (id: string, ts: number) => update((d) => closePanel(d, id, ts)),
         [update],
      );
      return useMemo(
         () => ({
            placed,
            byId: new Map(placed.map((p) => [p.slot.id, p.slot])),
            dots,
            updatedAt,
            close,
         }),
         [placed, dots, updatedAt, close],
      );
   },
   instances: (m) =>
      m.placed.map(({ slot, side }) => ({
         key: slot.id,
         label: slot.title ?? slot.id,
         icon: iconFor(slot.icon),
         placement: { edge: side },
         overlay: true,
         status: { presence: "ready", dot: m.dots.has(slot.id) || undefined },
      })),
   Body: ({ model, ctx, instance }) => {
      const env: UiEnv = useEnv();
      const slot = model.byId.get(instance);
      if (!slot) return null;
      const { api, host } = ctx;
      const sharedId = sharedRef(slot.source);
      // Made by the user from a diagram, a table or a render_ui item without an id: nothing in the core to edit.
      const madeHere = slot.id.startsWith("a:") && !sharedId;
      return (
         <SlotPanel
            slot={slot}
            env={env}
            updated={model.updatedAt(slot)}
            onShowInArtifacts={() =>
               ctx.open(
                  artifactsPanel,
                  sharedId ? `shared:${sharedId}` : madeHere ? slot.id.slice(2) : `ui:${slot.id}`,
               )
            }
            onEdit={
               madeHere
                  ? undefined
                  : (title, icon) =>
                       sharedId
                          ? api
                               .renameShared(sharedId, title ?? slot.title ?? slot.id, icon)
                               .then(() => {})
                          : api.editPanel(slot.id, title, icon)
            }
            onDelete={sharedId || madeHere ? undefined : () => api.deletePanel(slot.id)}
            onClose={() => {
               ctx.hide(slotRef(slot.id));
               model.close(slot.id, slot.ts);
            }}
            onShare={
               sharedId || madeHere
                  ? undefined
                  : () =>
                       void api
                          .shareArtifact(slot.id)
                          .catch((e) => console.error("share failed", e))
            }
            shared={
               sharedId
                  ? {
                       meta: host.sharedMetas?.get(sharedId),
                       onDetach: () =>
                          void api
                             .detachShared(sharedId)
                             .catch((e) => console.error("detach failed", e)),
                       onOpenOutside: host.openShared && (() => host.openShared!(sharedId)),
                    }
                  : undefined
            }
         />
      );
   },
});
