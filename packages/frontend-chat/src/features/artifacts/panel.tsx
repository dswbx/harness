import { Layers } from "lucide-react";
import { useMemo } from "react";
import { flash } from "../../lib/flash";
import { definePanel, type PanelBodyProps, type PanelRef } from "../../panels/contract";
import { useEnv } from "../renderUi/runtime";
import { ArtifactsPanel, type SharedActions } from "./ArtifactsPanel";
import { type Artifact, blockMarkdown, collectArtifacts } from "./artifacts";

export type ArtifactsModel = {
   artifacts: Artifact[];
   shared: SharedActions;
   /** The artifact to open next (its key), kept by the shell until panels take typed targets. */
   target?: { key: string } | null;
   onTargetShown?: () => void;
};

/** A render_ui panel the Agent placed (ids are `slot:<id>`). */
const slotRef = (id: string): PanelRef => ({ id: `slot:${id}` });

const NO_METAS: NonNullable<SharedActions["metas"]> = new Map();

/** The Session's diagrams, tables and render_ui items, and the Shared Artifacts attached to it. */
export const artifactsPanel = definePanel<ArtifactsModel>({
   id: "artifacts",
   label: "Artifacts",
   icon: Layers,
   placement: { edge: "left" },
   useModel: ({ api, state, host }) => {
      // One pass over the items per batch (as the View did before).
      const artifacts = useMemo(() => collectArtifacts(state.items), [state.items]);
      const metas = host.sharedMetas ?? NO_METAS;
      // Message blocks this Session shared, by their artifact key: the copy stands in for them.
      const copies = useMemo(() => {
         const m = new Map<string, string>();
         for (const { id } of state.sharedAttached) {
            const by = metas.get(id)?.created_by;
            if (by?.origin && by.session_id === api.sessionId) m.set(by.origin, id);
         }
         return m;
      }, [state.sharedAttached, metas, api.sessionId]);
      const { showShared, openShared } = host;
      const shared = useMemo<SharedActions>(
         () => ({
            attached: state.sharedAttached,
            metas,
            copies,
            search: (q) => api.listShared(q),
            share: (a) =>
               a.kind === "ui"
                  ? api.shareArtifact(a.slotId!)
                  : api.shareMarkdown(blockMarkdown(a), a.title, a.key),
            attach: (id) => api.attachShared(id),
            detach: (id) => api.detachShared(id),
            open: (id) => showShared?.(id),
            openOutside: openShared,
         }),
         [api, state.sharedAttached, metas, copies, showShared, openShared],
      );
      return useMemo(() => ({ artifacts, shared }), [artifacts, shared]);
   },
   status: (m) => ({ presence: "ready", badge: m.artifacts.length }),
   Body: ({ model, ctx }: PanelBodyProps<ArtifactsModel>) => {
      const env = useEnv();
      // A click on an artifact: its panel (`slot:<id>`) when it has one, else the message block, flashed.
      const jump = (a: Artifact) => {
         if (a.placement === "right" || a.placement === "left") {
            if (a.slotId) ctx.open(slotRef(a.slotId));
            return;
         }
         if (!a.rowId) {
            const el = document.querySelector(`[data-slot="${CSS.escape(a.slotId ?? "")}"]`);
            if (el) flash(el);
            return;
         }
         // The diagram or table inside the row.
         ctx.chat?.toRow(a.rowId, (row) =>
            a.index !== null
               ? row.querySelectorAll(`[data-artifact="${a.kind}"]`)[a.index]
               : row.firstElementChild,
         );
      };
      return (
         <ArtifactsPanel
            artifacts={model.artifacts}
            env={env}
            onJump={jump}
            shared={model.shared}
            target={model.target}
            onTargetShown={model.onTargetShown}
         />
      );
   },
});
