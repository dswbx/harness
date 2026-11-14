import type { Event, PermissionOption } from "@harness/api";
import { parseReviewComments } from "../../features/review/reviewComments";
import { type Ctx, permIndex } from "../draft";
import { planSteps, planTitle } from "../planText";

/** Task list and plan entries: the Agent's own list, and the plans it asked to approve (Plan Mode). */
export function plansSlice(c: Ctx, e: Event) {
   const k = e.kind;
   if (k.type === "TaskListUpdated") c.d.taskList = k.entries;
}

/** A new plan version. Counts the plan comments sent since the version it revises. */
export function addPlan(c: Ctx, requestId: string, markdown: string, ts: number) {
   const d = c.d;
   const last = d.plans.at(-1);
   const prev = last && last.status !== "approved" ? last : null;
   let commentsSent = 0;
   if (prev) {
      const from = permIndex(c).get(prev.requestId) ?? d.items.length;
      for (let n = from + 1; n < d.items.length; n++) {
         const it = d.items[n]!;
         if (it.type !== "user") continue;
         commentsSent += parseReviewComments(it.text).comments.filter(
            (x) => x.kind === "quote" && x.source === "plan",
         ).length;
      }
   }
   d.plans = [
      ...d.plans,
      {
         requestId,
         version: d.plans.length + 1,
         markdown,
         title: planTitle(markdown),
         steps: planSteps(markdown),
         prev: prev?.requestId ?? null,
         status: "pending",
         optionId: null,
         modeBefore: d.lastMode,
         clearsContext: false,
         requestedAt: ts,
         resolvedAt: null,
         commentsSent,
      },
   ];
}

/** The plan with this request was answered with `optionId` (null: dismissed). */
export function resolvePlan(
   c: Ctx,
   requestId: string,
   optionId: string | null,
   option: PermissionOption | undefined,
   ts: number,
) {
   const kind = option?.kind ?? "";
   c.d.plans = c.d.plans.map((p) =>
      p.requestId === requestId
         ? {
              ...p,
              status:
                 optionId === null
                    ? "dismissed"
                    : kind.startsWith("reject")
                      ? "revised"
                      : kind.startsWith("allow")
                        ? "approved"
                        : "dismissed",
              optionId,
              clearsContext: !!option?.clears_context,
              resolvedAt: ts,
           }
         : p,
   );
}
