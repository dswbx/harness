import { listSubagents, type SubagentRow } from "@harness/api";
import { Bot } from "lucide-react";
import { useMemo } from "react";
import { definePanel, type PanelBodyProps } from "../../panels/contract";
import { chatRowsOf, renderUiOf } from "../conversation/chatRows";
import { SubagentsPanel } from "./SubagentsPanel";

type Model = { rows: SubagentRow[]; running: number };
const NONE: Model = { rows: [], running: 0 };

/** The Session's subagents. Without any, it has no icon. */
export const subagentsPanel = definePanel<Model>({
   id: "subagents",
   label: "Subagents",
   icon: Bot,
   placement: { edge: "left", end: true },
   useModel: ({ state }) => {
      const turnRunning = state.turnId !== null;
      const waitingForUser = useMemo(
         () =>
            turnRunning &&
            state.items.some((i) => i.type === "permission" && !i.resolved && !i.auto),
         [turnRunning, state.items],
      );
      return useMemo(() => {
         const { subagents } = chatRowsOf(
            state.items,
            renderUiOf(state.items, state.sharedAttached),
         );
         // Most Sessions have none: no walk over the items then.
         if (subagents.size === 0) return NONE;
         const rows = listSubagents(
            state.items.flatMap((i) => (i.type === "tool" ? [i] : [])),
            subagents,
            turnRunning && !waitingForUser,
         );
         return { rows, running: rows.filter((r) => r.state === "running").length };
      }, [state.items, state.sharedAttached, turnRunning, waitingForUser]);
   },
   status: (m) => ({
      presence: m.rows.length > 0 ? "ready" : "absent",
      badge: m.running || undefined,
   }),
   Body: ({ model, ctx }: PanelBodyProps<Model>) => (
      <SubagentsPanel rows={model.rows} onJump={(id) => ctx.chat?.toStep(id)} />
   ),
});
