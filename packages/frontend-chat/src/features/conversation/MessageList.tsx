import type { SessionApi } from "@harness/api";
import { VirtualList, type VirtualListHandle } from "@harness/ui";
import { type Ref, useMemo, useRef } from "react";
import type { ChatState, Item } from "../../state/reducer";
import type { DiffScope } from "../changes/DiffPanel";
import { PlanContext, type PlanCtx } from "../plan/PlanNote";
import { PendingRow } from "../prompt/pending/PendingRow";
import { hasArrived, usePendingMessages } from "../prompt/pendingMessages";
import type { UiEnv } from "../renderUi/RenderUi";
import type { splitRenderUi } from "../renderUi/slots";
import { composerKey } from "../review/reviewComments";
import type { ChatSubagent } from "../toolDisplay";
import { WaitingForUser } from "../toolDisplay/waiting";
import { chatRowsOf, renderUiOf, stabilizeRows } from "./chatRows";
import { Row } from "./Row";
import { Working } from "./Working";

/** A Thread's items split into rows: render_ui calls moved to slots, resolved permissions and subagent calls folded away. */
export function useRows(items: Item[], sharedAttached?: ChatState["sharedAttached"]) {
   const ui = useMemo(() => renderUiOf(items, sharedAttached), [items, sharedAttached]);
   // Resolved permission cards render nothing; keep them out of the virtual list. So do render_ui
   // calls that moved to a slot or were replaced by a later call with their id.
   // Subagent tool calls go inside their Task call's card.
   // Kept apart from the shared result: what did not change keeps its identity, so rows can bail out.
   const last = useRef<ReturnType<typeof chatRowsOf> | null>(null);
   const { rows, subagents } = useMemo(
      () => (last.current = stabilizeRows(last.current, chatRowsOf(items, ui))),
      [items, ui],
   );
   return { ui, rows, subagents };
}

/** The message list of one Thread (the Main Thread's, or a Side Thread's in the panel). */
export function MessageList({
   handle,
   api,
   state,
   threadId,
   side,
   env,
   ui,
   rows,
   subagents,
   onOpenDiff,
   onOpenPlan,
   empty,
   inset = 0,
}: {
   api: SessionApi;
   state: ChatState;
   threadId: string;
   side: boolean;
   env: UiEnv;
   ui: ReturnType<typeof splitRenderUi>;
   rows: ReturnType<typeof useRows>["rows"];
   subagents: Map<string, ChatSubagent>;
   onOpenDiff: (s: DiffScope) => void;
   /** Opens the Plan panel at a plan version. Without it, plans show inline (no panel). */
   onOpenPlan?: (requestId: string) => void;
   empty: string;
   handle?: Ref<VirtualListHandle>;
   /** Height of the bar over the list's bottom (`ScrollUnder`), kept free at the end. */
   inset?: number;
}) {
   const running = state.turnId !== null;
   // A permission (or plan) waits for the user: the Turn is open but the Agent is not working.
   const waiting = useMemo(
      () => running && state.items.some((i) => i.type === "permission" && !i.resolved && !i.auto),
      [running, state.items],
   );
   const composer = composerKey(api.sessionId, side ? threadId : null);
   const userCount = useMemo(
      () => state.items.filter((i) => i.type === "user").length,
      [state.items],
   );
   // Filtered here, not after the fact, so a message never shows twice for a frame.
   const pending = usePendingMessages(composer).filter((p) => !hasArrived(p, userCount));
   const plans = useMemo<PlanCtx>(
      () => ({
         plans: state.plans,
         configOptions: state.configOptions,
         modeNames: state.modeNames,
         open: onOpenPlan,
      }),
      [state.plans, state.configOptions, state.modeNames, onOpenPlan],
   );
   return (
      <PlanContext value={plans}>
         <WaitingForUser value={waiting}>
            <VirtualList
               handle={handle}
               count={rows.length}
               getKey={(i) => rows[i]!.id}
               estimateSize={72}
               gap={24}
               className="@container"
               scrollbarClassName="z-10 [&>*]:bg-[color-mix(in_oklch,var(--border),var(--foreground)_6%)]"
               innerClassName="mx-auto max-w-3xl px-10 pb-3 pt-4"
               empty={
                  pending.length === 0 && (
                     <p className="py-16 text-center text-sm text-muted-foreground">{empty}</p>
                  )
               }
               renderRow={(i) => (
                  <Row
                     item={rows[i]!}
                     api={api}
                     env={env}
                     view={ui.inline.get(rows[i]!.id)}
                     onOpenDiff={onOpenDiff}
                     subagents={subagents}
                     active={running}
                     streaming={running && i === rows.length - 1}
                     threadId={threadId}
                     side={side}
                  />
               )}
               footer={
                  <>
                     {/* With no rows yet, the list's top padding is not there. */}
                     {rows.length === 0 && pending.length > 0 && <div className="h-4" />}
                     {pending.map((p) => (
                        <PendingRow key={p.id} item={p} state={state} composer={composer} />
                     ))}
                     <Working since={state.turnStartedAt} waiting={waiting} />
                     <div style={{ height: inset }} />
                  </>
               }
            />
         </WaitingForUser>
      </PlanContext>
   );
}
