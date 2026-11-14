import { ClipboardList } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { definePanel, type PanelBodyProps } from "../../panels/contract";
import { PlanPanel } from "./PlanPanel";
import { planToAutoOpen } from "./plans";

export type PlanModel = {
   /** The version shown (its `requestId`); null: the latest. */
   selected: string | null;
   select: (requestId: string) => void;
   hasPlans: boolean;
};

/**
 * The Agent's plans. The icon appears with the first plan; a new pending plan opens the panel, once per request
 * (not in the Quick overlay).
 */
export const planPanel = definePanel<PlanModel>({
   id: "plan",
   label: "Plan",
   icon: ClipboardList,
   placement: { edge: "right" },
   useModel: ({ state, variant }, self) => {
      const [selected, select] = useState<string | null>(null);
      const lastPlan = state.plans.at(-1);
      const pendingPlan = lastPlan?.status === "pending" ? lastPlan.requestId : null;
      const opened = useRef(new Set<string>());
      const show = self.show;
      useEffect(() => {
         const id = planToAutoOpen(variant === "overlay", pendingPlan, opened.current);
         if (!id) return;
         opened.current.add(id);
         select(id);
         show();
      }, [variant, pendingPlan, show]);
      const hasPlans = state.plans.length > 0;
      return useMemo(() => ({ selected, select, hasPlans }), [selected, hasPlans]);
   },
   status: (m) => ({ presence: m.hasPlans ? "ready" : "absent" }),
   Body: ({ model, ctx }: PanelBodyProps<PlanModel>) => (
      <PlanPanel
         api={ctx.api}
         state={ctx.state}
         selected={model.selected}
         onSelect={model.select}
      />
   ),
});
