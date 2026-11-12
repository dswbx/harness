import type { SessionApi } from "@harness/api";
import { cn, Trace, TraceDetail, TraceIcon, TraceLine, TraceTitle, TraceVerb } from "@harness/ui";
import { ClipboardCheck, ClipboardList } from "lucide-react";
import { createContext, useContext, useMemo } from "react";
import { continuesIn } from "./ApproveButton";
import { Markdown } from "./Markdown";
import { PlanActions } from "./PlanActions";
import { clockTime, planStats } from "./plans";
import type { ConfigOption, Item, PlanEntry } from "./reducer";

type Perm = Extract<Item, { type: "permission" }>;

/** What plan rows need from their Thread: its plans, its mode names, and how to open the Plan panel (Main only). */
export type PlanCtx = {
   plans: PlanEntry[];
   configOptions: ConfigOption[];
   open?: (requestId: string) => void;
};
export const PlanContext = createContext<PlanCtx>({ plans: [], configOptions: [] });

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** "Approved · v2 · Auto · 14:05 · context cleared" */
export function approvedMeta(
   entry: PlanEntry,
   item: Perm | undefined,
   configOptions: ConfigOption[],
) {
   const option = item?.options.find((o) => o.option_id === entry.optionId);
   const mode = continuesIn(option, entry, configOptions);
   return [
      "Approved",
      `v${entry.version}`,
      mode,
      entry.resolvedAt ? clockTime(entry.resolvedAt) : null,
      entry.clearsContext ? "context cleared" : null,
   ]
      .filter(Boolean)
      .join(" · ");
}

/**
 * A plan in the chat: one row that opens it in the Plan panel. Pending: "Needs approval". Approved: green, with
 * the mode it continued in. A version replaced by a later one: one Trace line.
 */
export function PlanNote({ item, api }: { item: Perm; api: SessionApi }) {
   const { plans, configOptions, open } = useContext(PlanContext);
   const entry = plans.find((p) => p.requestId === item.requestId);
   const prev = entry?.prev ? plans.find((p) => p.requestId === entry.prev) : undefined;
   const next = entry ? plans.find((p) => p.prev === entry.requestId) : undefined;
   const stats = useMemo(
      () => (entry && prev ? planStats(prev.markdown, entry.markdown) : null),
      [entry, prev],
   );
   if (!entry) return null;
   const onOpen = open ? () => open(entry.requestId) : undefined;

   if (next && entry.status !== "approved") {
      const line = (
         <TraceLine>
            <TraceIcon>
               <ClipboardList />
            </TraceIcon>
            <TraceTitle>
               <TraceVerb>Presented plan</TraceVerb>
               <TraceDetail>
                  v{entry.version} · replaced by v{next.version}
               </TraceDetail>
            </TraceTitle>
         </TraceLine>
      );
      return (
         <Trace className="text-ui-step">
            {onOpen ? (
               <button type="button" className="w-fit text-left" onClick={onOpen}>
                  {line}
               </button>
            ) : (
               line
            )}
         </Trace>
      );
   }

   const approved = entry.status === "approved";
   const pending = entry.status === "pending" && !item.resolved;
   const meta = approved ? (
      approvedMeta(entry, item, configOptions)
   ) : (
      <>
         {prev ? `Plan updated to v${entry.version}` : `Plan · v${entry.version}`}
         {!prev && entry.steps !== null && ` · ${plural(entry.steps, "step")}`}
         {stats && (
            <>
               {" · "}
               <span className="font-mono">
                  <span className="text-emerald-500">+{stats.add}</span>{" "}
                  <span className="text-red-400">−{stats.del}</span>
               </span>
            </>
         )}
         {entry.commentsSent > 0 && ` · ${plural(entry.commentsSent, "comment")} sent`}
      </>
   );
   const state = pending ? (
      <span className="shrink-0 text-xs font-medium text-amber-500">Needs approval</span>
   ) : entry.status === "dismissed" ? (
      <span className="shrink-0 text-xs text-muted-foreground">Dismissed</span>
   ) : entry.status === "revised" ? (
      <span className="shrink-0 text-xs text-muted-foreground">Revising</span>
   ) : null;
   const Icon = approved ? ClipboardCheck : ClipboardList;
   const body = (
      <>
         <span
            className={cn(
               "flex size-8 shrink-0 items-center justify-center rounded-md",
               approved ? "bg-emerald-500/15 text-emerald-500" : "bg-muted text-muted-foreground",
            )}
         >
            <Icon className="size-4" />
         </span>
         <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-medium">{entry.title ?? "Plan"}</span>
            <span className="truncate text-xs text-muted-foreground">{meta}</span>
         </span>
         {state}
      </>
   );
   const row = "flex w-full items-center gap-3 rounded-lg bg-card px-3 py-2.5 text-left";
   return (
      <div className={cn("flex flex-col gap-2", entry.status === "dismissed" && "opacity-70")}>
         {onOpen ? (
            <button
               type="button"
               className={cn(row, "transition-colors hover:bg-accent/60")}
               onClick={onOpen}
            >
               {body}
            </button>
         ) : (
            <div className={row}>{body}</div>
         )}
         {/* No Plan panel here (a Side Thread, the Quick overlay): the plan and its answers show inline. */}
         {!onOpen && pending && (
            <div className="flex flex-col gap-3 rounded-lg bg-card p-3">
               <Markdown className="max-h-96 overflow-auto">{entry.markdown}</Markdown>
               <PlanActions api={api} item={item} entry={entry} configOptions={configOptions} />
            </div>
         )}
      </div>
   );
}
