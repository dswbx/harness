import type { SharedArtifactMeta } from "@harness/api";
import { formatAgeAgo, formatDateTime } from "@harness/api";
import { DropdownMenuItem, DropdownMenuSeparator, ScrollArea, Tooltip } from "@harness/ui";
import { Copy, ExternalLink, Layers, Share2, Unlink } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatRelativeTime, useNow } from "../../lib/time";
import { definePanelFamily } from "../../panels/contract";
import { PanelHeader } from "../../panels/PanelHeader";
import { sessionCount } from "../artifacts/ArtifactsPanel";
import { artifactsPanel } from "../artifacts/panel";
import { renderUiOf } from "../conversation/chatRows";
import { quotableAttrs } from "../review/SelectionComment";
import { RenderUi, type UiEnv } from "./RenderUi";
import { useEnv } from "./runtime";
import { lastSlot, nextSeen, type Slot, slotDot, slotRef, slotToAutoOpen } from "./slots";
import { useSourceStamps } from "./source";
import { sharedNodeId, sharedRef } from "./tools";
import { FillFrame } from "./UiHtml";
import { uiIcons } from "./uiIcons";

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
function SlotPanel({
   slot,
   env,
   updated,
   shared,
   onShare,
   onShowInArtifacts,
}: {
   slot: Slot;
   env: UiEnv;
   updated: number;
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
   return (
      <>
         <PanelHeader
            title={slot.title ?? slot.id}
            menu={
               <>
                  <DropdownMenuItem onSelect={onShowInArtifacts}>
                     <Layers /> Show in Artifacts
                  </DropdownMenuItem>
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
                              <Unlink /> Detach
                           </DropdownMenuItem>
                        </>
                     )
                  )}
               </>
            }
         >
            {shared && <SharedBadge meta={shared.meta} />}
            {updated > 0 && <UpdatedAgo ts={updated} />}
         </PanelHeader>
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
      const { left, right } = renderUiOf(state.items, state.sharedAttached).slots;
      const metas = host.sharedMetas ?? NO_METAS;
      const placed = useMemo(() => {
         const titled = (slot: Slot) => {
            const id = sharedRef(slot.source);
            const title = id ? metas.get(id)?.title : undefined;
            return title && title !== slot.title ? { ...slot, title } : slot;
         };
         return [
            ...left.map((slot): Placed => ({ slot: titled(slot), side: "left" })),
            ...right.map((slot): Placed => ({ slot: titled(slot), side: "right" })),
         ];
      }, [left, right, metas]);

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
      const newest = useMemo(() => lastSlot(placed.map((p) => p.slot)), [placed]);
      useEffect(() => {
         const slot = slotToAutoOpen(newest, openedAt);
         if (slot) open(slotRef(slot.id));
      }, [newest?.id, newest?.ts, openedAt, open]);

      // The dots depend on which panel is open now (read here, in the render).
      const dotIds = placed
         .filter((p) => slotDot(p.slot, isOpen(slotRef(p.slot.id)), seen, stamps))
         .map((p) => p.slot.id)
         .join("\n");
      const dots = useMemo(() => new Set(dotIds ? dotIds.split("\n") : []), [dotIds]);
      return useMemo(
         () => ({ placed, byId: new Map(placed.map((p) => [p.slot.id, p.slot])), dots, updatedAt }),
         [placed, dots, updatedAt],
      );
   },
   instances: (m) =>
      m.placed.map(({ slot, side }) => ({
         key: slot.id,
         label: slot.title ?? slot.id,
         icon: uiIcons[slot.icon as keyof typeof uiIcons],
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
      return (
         <SlotPanel
            slot={slot}
            env={env}
            updated={model.updatedAt(slot)}
            onShowInArtifacts={() =>
               ctx.open(artifactsPanel, sharedId ? `shared:${sharedId}` : `ui:${slot.id}`)
            }
            onShare={
               sharedId
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
