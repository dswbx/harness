import { Layers } from "lucide-react";
import { useMemo } from "react";
import { flash } from "../../lib/flash";
import { definePanel, type PanelBodyProps } from "../../panels/contract";
import { usePanelTargetState } from "../../panels/usePanelTarget";
import { useEnv } from "../renderUi/runtime";
import { slotRef } from "../renderUi/slots";
import { ArtifactsPanel, type SharedActions } from "./ArtifactsPanel";
import { type Artifact, blockMarkdown, collectArtifacts } from "./artifacts";

export type ArtifactsModel = {
   artifacts: Artifact[];
   shared: SharedActions;
};

const NO_METAS: NonNullable<SharedActions["metas"]> = new Map();

/** The Session's diagrams, tables and render_ui items, and the Shared Artifacts attached to it. Opened at an artifact key, it shows that artifact. */
export const artifactsPanel = definePanel<ArtifactsModel, string>({
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
   Body: ({ model, ctx, self }: PanelBodyProps<ArtifactsModel, string>) => {
      const env = useEnv();
      // The artifact to open (its key), as a new object each time.
      const target = usePanelTargetState(self, (key) => ({ key }));
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
            target={target}
         />
      );
   },
});
