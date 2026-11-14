import { Link2 } from "lucide-react";
import { definePanel, type PanelBodyProps } from "../../panels/contract";
import { ReferencesPanel, type ResolvedReferences, useReferences } from "./ReferencesPanel";

/**
 * The Session's PRs, code and links. Lookups start the first time the panel opens (`self.opened`, or open
 * right now), so until then the icon has no count. Needs the PR and file ref providers above the host.
 */
export const referencesPanel = definePanel<ResolvedReferences>({
   id: "references",
   label: "References",
   icon: Link2,
   placement: { edge: "left", end: true },
   useModel: (ctx, self) => useReferences(ctx.state.items, self.opened || self.open),
   status: (r) => ({ presence: "ready", badge: r.count }),
   Body: ({ model, ctx }: PanelBodyProps<ResolvedReferences>) => (
      <ReferencesPanel
         resolved={model}
         onJump={(rowId) => ctx.chat?.toRow(rowId, (row) => row.firstElementChild)}
      />
   ),
});
