import { groupSubagents } from "@harness/api";
import type { Item } from "../../state/reducer";
import { isStepApproval } from "../interaction/Permission";
import type { splitRenderUi } from "../renderUi/slots";
import { groupTools } from "../toolDisplay/group";

/**
 * A Thread's items split into chat rows. Hidden: resolved permission cards (a plan stays: its row
 * records how it was answered), the policy's auto answers on a step, a pending step approval's
 * tool (the approval stands in for it), and render_ui calls that moved to a slot or were replaced.
 * Subagent calls go inside their Task call's card.
 */
export function chatRows(items: Item[], ui: ReturnType<typeof splitRenderUi>) {
   const hidden = new Set(
      items.flatMap((i) =>
         i.type === "permission" && !i.resolved && i.stepId && isStepApproval(i) ? i.stepId : [],
      ),
   );
   const g = groupSubagents(
      items.filter((i) => {
         // A plan stays: its row records how it was answered.
         if (i.type === "permission" && !i.auto && i.resolved && !i.plan) return false;
         // A Harness tool's approval shows on its step: the policy's answer is the step's own
         // note, and a pending git approval stands in for the step until it is answered.
         if (i.type === "permission" && i.auto && i.stepId) return false;
         if (i.type === "tool" && hidden.has(i.id)) return false;
         return ui.inline.get(i.id) !== null;
      }),
      (i) => (i.type === "tool" ? i : null),
      (i) => (i.type === "thought" || i.type === "agent" ? i.parent : null),
   );
   return { rows: groupTools(g.rows), subagents: g.subagents };
}
