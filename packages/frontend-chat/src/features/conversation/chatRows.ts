import { groupSubagents } from "@harness/api";
import type { Item } from "../../state/reducer";
import { isStepApproval } from "../interaction/Permission";
import { splitRenderUi } from "../renderUi/slots";
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

type Ui = ReturnType<typeof splitRenderUi>;
type Attached = Parameters<typeof splitRenderUi>[1];

const uiCache = new WeakMap<readonly Item[], { attached: Attached; ui: Ui }>();
const rowsCache = new WeakMap<readonly Item[], { ui: Ui; result: ReturnType<typeof chatRows> }>();

/** `splitRenderUi`, shared: callers with the same `items` array and `attached` get the same object. */
export function renderUiOf(items: Item[], attached?: Attached): Ui {
   const hit = uiCache.get(items);
   if (hit && hit.attached === attached) return hit.ui;
   const ui = splitRenderUi(items, attached);
   uiCache.set(items, { attached, ui });
   return ui;
}

/** `chatRows`, shared: the last result per `items` array, recomputed when `ui` is another object. */
export function chatRowsOf(items: Item[], ui: Ui): ReturnType<typeof chatRows> {
   const hit = rowsCache.get(items);
   if (hit && hit.ui === ui) return hit.result;
   const result = chatRows(items, ui);
   rowsCache.set(items, { ui, result });
   return result;
}
