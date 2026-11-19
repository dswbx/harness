import { groupSubagents } from "@harness/api";
import type { Item } from "../../state/reducer";
import { isStepApproval } from "../interaction/Permission";
import { splitRenderUi } from "../renderUi/slots";
import { type ChatSubagent, groupTools } from "../toolDisplay/group";

/**
 * A Thread's items split into chat rows. Hidden: resolved permission cards (a plan stays: its row
 * records how it was answered), the policy's auto answers on a step, a pending step approval's
 * tool (the approval stands in for it), and render_ui calls that moved to a slot or were replaced.
 * Subagent calls go inside their Task call's card.
 */
export function chatRows(items: Item[], ui: ReturnType<typeof splitRenderUi>) {
   // Pending step approvals by their step's id: the step is hidden, the approval row shows it.
   const pending = new Set(
      items.flatMap((i) =>
         i.type === "permission" && !i.resolved && !i.auto && isStepApproval(i) ? i.stepId : [],
      ),
   );
   const hidden = new Map<string, Extract<Item, { type: "tool" }>>();
   for (const i of items) if (i.type === "tool" && pending.has(i.id)) hidden.set(i.id, i);
   const g = groupSubagents(
      items
         .filter((i) => {
            // A plan stays: its row records how it was answered.
            if (i.type === "permission" && !i.auto && i.resolved && !i.plan) return false;
            // A Harness tool's approval shows on its step: the policy's answer is the step's own
            // note, and a pending git approval stands in for the step until it is answered.
            if (i.type === "permission" && i.auto && i.stepId) return false;
            if (i.type === "tool" && hidden.has(i.id)) return false;
            return ui.inline.get(i.id) !== null;
         })
         .map((i) => {
            const step = i.type === "permission" && i.stepId ? hidden.get(i.stepId) : undefined;
            return step && i.type === "permission" && !i.resolved ? { ...i, step } : i;
         }),
      (i) => (i.type === "tool" ? i : null),
      (i) => (i.type === "thought" || i.type === "agent" ? i.parent : null),
   );
   return { rows: groupTools(g.rows), subagents: g.subagents };
}

type Ui = ReturnType<typeof splitRenderUi>;
type Attached = Parameters<typeof splitRenderUi>[1];

type Edits = Parameters<typeof splitRenderUi>[2];

const uiCache = new WeakMap<readonly Item[], { attached: Attached; edits: Edits; ui: Ui }>();
const rowsCache = new WeakMap<readonly Item[], { ui: Ui; result: ReturnType<typeof chatRows> }>();

/** `splitRenderUi`, shared: callers with the same `items` array, `attached` and `edits` get the same object. */
export function renderUiOf(items: Item[], attached?: Attached, edits?: Edits): Ui {
   const hit = uiCache.get(items);
   if (hit && hit.attached === attached && hit.edits === edits) return hit.ui;
   const ui = splitRenderUi(items, attached, edits);
   uiCache.set(items, { attached, edits, ui });
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

type Rows = ReturnType<typeof chatRows>;

const sameItems = (a: readonly unknown[], b: readonly unknown[]) =>
   a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * `next` with the identity of what did not change since `prev` (a Thread's previous result): tool groups
 * with the same steps, subagents with the same calls, steps, report and end, and the rows array and
 * `subagents` map when nothing in them changed. Rows are memoized by identity, so a streamed chunk
 * re-renders only the row it landed in.
 */
export function stabilizeRows(prev: Rows | null, next: Rows): Rows {
   if (!prev) return next;
   // Rows mostly stay where they were: look at the same place first, by id only when that missed.
   let byId: Map<string, Rows["rows"][number]> | null = null;
   let rows = next.rows.map((r, i) => {
      let p: Rows["rows"][number] | undefined = prev.rows[i];
      if (p?.id !== r.id) {
         byId ??= new Map(prev.rows.map((x) => [x.id, x]));
         p = byId.get(r.id);
      }
      if (
         p &&
         p !== r &&
         p.type === "tools" &&
         r.type === "tools" &&
         sameItems(p.steps, r.steps) &&
         sameItems(p.approvals, r.approvals)
      )
         return p;
      return r;
   });
   if (sameItems(rows, prev.rows)) rows = prev.rows;
   let kept = prev.subagents.size === next.subagents.size;
   const subagents = new Map<string, ChatSubagent>();
   for (const [id, s] of next.subagents) {
      const p = prev.subagents.get(id);
      const same =
         p &&
         p.report === s.report &&
         p.endedAt === s.endedAt &&
         sameItems(p.calls, s.calls) &&
         sameItems(p.steps, s.steps);
      if (!same) kept = false;
      subagents.set(id, same ? p : s);
   }
   return { rows, subagents: kept ? prev.subagents : subagents };
}
