import { cn, Spinner } from "@harness/ui";
import { CheckCircle2, ChevronDown, ChevronUp, CircleDashed } from "lucide-react";
import { useState } from "react";
import type { ChatState } from "../../state/reducer";

type Entry = ChatState["taskList"][number];

function StatusIcon({ status }: { status: Entry["status"] }) {
   if (status === "completed")
      return <CheckCircle2 className="size-3.5 shrink-0 text-emerald-500" />;
   if (status === "in_progress") return <Spinner className="size-3.5 shrink-0" />;
   return <CircleDashed className="size-3.5 shrink-0 text-muted-foreground" />;
}

/**
 * The Agent's task list, inline at the end of the chat. Folds to one line when every task is done;
 * the user can fold or open it, a choice kept until the list's length or done state changes.
 */
export function TaskListCard({ entries, className }: { entries: Entry[]; className?: string }) {
   const done = entries.filter((e) => e.status === "completed").length;
   const allDone = done === entries.length;
   const key = `${entries.length}:${allDone}`;
   const [choice, setChoice] = useState<{ key: string; open: boolean } | null>(null);
   const open = choice?.key === key ? choice.open : !allDone;
   const toggle = () => setChoice({ key, open: !open });
   if (entries.length === 0) return null;
   const card = "rounded-xl border bg-card text-sm";
   if (!open) {
      const current =
         entries.find((e) => e.status === "in_progress") ??
         entries.find((e) => e.status !== "completed");
      return (
         <section aria-label="Task list" className={cn(card, "p-1", className)}>
            <button
               type="button"
               aria-expanded={false}
               onClick={toggle}
               className="flex h-8 w-full items-center gap-2 rounded-lg px-3 text-left text-muted-foreground hover:bg-accent/50"
            >
               {current && !allDone ? (
                  <>
                     <StatusIcon status={current.status} />
                     <span className="truncate font-medium text-foreground">{current.content}</span>
                     <span className="shrink-0 tabular-nums">
                        · {done} of {entries.length}
                     </span>
                  </>
               ) : (
                  <>
                     <StatusIcon status="completed" />
                     <span className="tabular-nums">
                        {done} of {entries.length} tasks done
                     </span>
                  </>
               )}
               <ChevronDown className="ml-auto size-3.5 shrink-0" />
            </button>
         </section>
      );
   }
   return (
      <section aria-label="Task list" className={cn(card, "relative py-3 pl-4 pr-10", className)}>
         <button
            type="button"
            aria-expanded
            aria-label="Collapse task list"
            onClick={toggle}
            className="absolute right-2 top-2 flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground"
         >
            <ChevronUp className="size-3.5" />
         </button>
         <ul className="space-y-1">
            {entries.map((t, i) => (
               <li
                  key={i}
                  className={cn(
                     "flex items-center gap-2",
                     t.status === "completed" && "text-muted-foreground",
                  )}
               >
                  <StatusIcon status={t.status} />
                  {t.content}
               </li>
            ))}
         </ul>
      </section>
   );
}
