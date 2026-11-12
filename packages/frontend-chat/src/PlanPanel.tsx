import { inTauri, revealPath, type SessionApi } from "@harness/api";
import {
   cn,
   DropdownMenuItem,
   ScrollArea,
   Select,
   SelectContent,
   SelectItem,
   SelectTrigger,
   SelectValue,
} from "@harness/ui";
import { CheckCircle2, ClipboardList, Copy, FolderOpen, SquarePen } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { diffLines } from "./diff";
import { Markdown } from "./Markdown";
import { PanelHeader } from "./PanelHeader";
import { PlanActions } from "./PlanActions";
import { approvedMeta } from "./PlanNote";
import type { ChatState, PlanEntry } from "./reducer";
import { Segmented } from "./Segmented";
import { quotableAttrs } from "./SelectionComment";

/** Added lines on green, removed lines struck through on red; unchanged lines as they are. */
function PlanChanges({ prev, next }: { prev: string; next: string }) {
   const lines = useMemo(() => diffLines(prev, next), [prev, next]);
   return (
      <div className="font-mono text-xs leading-5">
         {lines.map((l, i) => (
            <div
               // biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity of their own.
               key={i}
               className={cn(
                  "min-h-5 whitespace-pre-wrap break-words px-2",
                  l.op === "+" && "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
                  l.op === "-" && "bg-red-500/10 text-red-400 line-through",
                  l.op === " " && "text-muted-foreground",
               )}
            >
               {l.text}
            </div>
         ))}
      </div>
   );
}

/**
 * The Thread's plans, one version at a time: the plan as Markdown (select text to comment on it), or its
 * changes against the version before. A pending plan has its answers at the bottom.
 */
/**
 * "Open in editor", disabled with a hint until an editor is chosen in Settings. Mounts when the menu opens, so a
 * change in Settings shows the next time.
 */
function OpenInEditorItem({ api, onOpen }: { api: SessionApi; onOpen: () => void }) {
   // undefined: still loading; null: none chosen.
   const [editor, setEditor] = useState<unknown>(undefined);
   useEffect(() => {
      api.getEditor().then(setEditor, () => setEditor(null));
   }, [api]);
   return (
      <DropdownMenuItem disabled={!editor} onSelect={onOpen}>
         <SquarePen />
         <span className="flex flex-col">
            <span>Open in editor</span>
            {editor === null && (
               <span className="text-xs text-muted-foreground">Choose an editor in Settings</span>
            )}
         </span>
      </DropdownMenuItem>
   );
}

export function PlanPanel({
   api,
   state,
   selected,
   onSelect,
}: {
   api: SessionApi;
   state: ChatState;
   /** The version shown (its `requestId`); null: the latest. */
   selected: string | null;
   onSelect: (requestId: string) => void;
}) {
   const plans = state.plans;
   const entry: PlanEntry | undefined = plans.find((p) => p.requestId === selected) ?? plans.at(-1);
   const prev = entry?.prev ? plans.find((p) => p.requestId === entry.prev) : undefined;
   const [view, setView] = useState<"plan" | "changes">("plan");
   const shownView = prev ? view : "plan";
   const root = useRef<HTMLDivElement>(null);
   const item = entry
      ? state.items.find(
           (i): i is Extract<typeof i, { type: "permission" }> =>
              i.type === "permission" && i.requestId === entry.requestId,
        )
      : undefined;
   const [error, setError] = useState<string | null>(null);
   const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
   const exportFile = (open: boolean) =>
      entry ? api.exportPlan(`plan-v${entry.version}`, entry.markdown, open) : Promise.resolve("");
   const menu = entry ? (
      <>
         <DropdownMenuItem
            onSelect={() => {
               setError(null);
               navigator.clipboard.writeText(entry.markdown).catch(fail);
            }}
         >
            <Copy /> Copy as Markdown
         </DropdownMenuItem>
         <OpenInEditorItem
            api={api}
            onOpen={() => {
               setError(null);
               exportFile(true).catch(fail);
            }}
         />
         {inTauri() && (
            <DropdownMenuItem
               onSelect={() => {
                  setError(null);
                  exportFile(false)
                     .then((path) => revealPath(path))
                     .catch(fail);
               }}
            >
               <FolderOpen /> Reveal in Finder
            </DropdownMenuItem>
         )}
      </>
   ) : undefined;
   const pending = entry?.status === "pending" && !!item && !item.resolved;

   return (
      <div ref={root} tabIndex={-1} className="flex h-full min-h-0 flex-col outline-none">
         <PanelHeader title="Plan" menu={menu} />
         {error && (
            <div className="shrink-0 border-b bg-red-500/10 px-3 py-1.5 text-xs text-red-400">
               {error}
            </div>
         )}
         {!entry ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
               <ClipboardList className="size-5" />
               No plan yet. When the Agent presents a plan, it shows here.
            </div>
         ) : (
            <>
               <div className="flex shrink-0 items-center gap-2 border-b px-2.5 py-1.5">
                  <Select value={entry.requestId} onValueChange={onSelect}>
                     <SelectTrigger className="h-[30px] w-auto min-w-0 max-w-56 text-xs">
                        <SelectValue />
                     </SelectTrigger>
                     <SelectContent>
                        {plans.map((p) => (
                           <SelectItem key={p.requestId} value={p.requestId} className="text-xs">
                              v{p.version}
                              {p.title ? ` · ${p.title}` : ""}
                           </SelectItem>
                        ))}
                     </SelectContent>
                  </Select>
                  <Segmented
                     label="Show"
                     className="ml-auto"
                     value={shownView}
                     onChange={setView}
                     items={[
                        { value: "plan", label: "Plan" },
                        { value: "changes", label: "Changes", disabled: !prev },
                     ]}
                  />
               </div>
               {entry.status === "approved" && (
                  <div className="flex shrink-0 items-center gap-2 border-b bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-600 dark:text-emerald-400">
                     <CheckCircle2 className="size-3.5" />
                     {approvedMeta(entry, item, state.configOptions)}
                  </div>
               )}
               {(entry.status === "revised" || entry.status === "dismissed") && (
                  <div className="shrink-0 border-b bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
                     {entry.status === "revised" ? "Sent back to keep planning" : "Dismissed"}
                  </div>
               )}
               <ScrollArea className="min-h-0 flex-1">
                  <div className="p-4">
                     {shownView === "changes" && prev ? (
                        <PlanChanges prev={prev.markdown} next={entry.markdown} />
                     ) : (
                        <div
                           {...quotableAttrs(null, false, {
                              source: "plan",
                              label: `Plan v${entry.version}`,
                           })}
                        >
                           <Markdown title={entry.title ?? `Plan v${entry.version}`}>
                              {entry.markdown}
                           </Markdown>
                        </div>
                     )}
                  </div>
               </ScrollArea>
               {pending && item && (
                  <div className="shrink-0 border-t p-3">
                     <PlanActions
                        key={entry.requestId}
                        api={api}
                        item={item}
                        entry={entry}
                        configOptions={state.configOptions}
                        shortcutRoot={root}
                     />
                  </div>
               )}
            </>
         )}
      </div>
   );
}
