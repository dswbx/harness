import { isOpen, type TaskStatus, type TaskSummary } from "@harness/api";
import { cn } from "@harness/ui";
import { CalendarDays, CornerDownRight, Hourglass } from "lucide-react";
import { InlineMarkdown } from "../markdown/InlineMarkdown";
import { META_CHIP } from "./chips";
import { dueTone, formatDue } from "./DuePicker";
import { PriorityIcon } from "./PriorityMenu";
import { StatusMenu } from "./StatusMenu";
import { type Sessions, sessionTitle } from "./sessionTitle";
import { upstreamText } from "./UpstreamField";

/**
 * One task in a list: the status (a menu), the title, and under it the priority, due date, "waits on N", parent,
 * subtask count, upstream id and the last Session started from it (other than this one). `condensed`: one line, no facts under the
 * title, only a calendar mark when an open task is due today or overdue. A click opens the task; `selected`: it is
 * the one open.
 */
export function TaskRow({
   task,
   parent,
   progress,
   waitsOn = 0,
   today,
   sessionId,
   sessions,
   onOpen,
   onStatus,
   condensed = false,
   selected = false,
   className,
}: {
   task: TaskSummary;
   /** Shown as a chip (null: none, or not shown). */
   parent: Pick<TaskSummary, "title"> | null;
   /** Done and total subtasks (null: none). */
   progress: { done: number; total: number } | null;
   /** Its open blockers (`openBlockers`); shown as "waits on N" when above 0. */
   waitsOn?: number;
   /** `YYYY-MM-DD`, for overdue dates. */
   today: string;
   /** The Session the list is in (null: none). */
   sessionId: string | null;
   /** Live Session titles. Absent: the titles cached on the task. */
   sessions?: Sessions;
   onOpen: () => void;
   onStatus: (status: TaskStatus) => void;
   /** One line: the status and the title. */
   condensed?: boolean;
   selected?: boolean;
   className?: string;
}) {
   const open = isOpen(task.status);
   const dueMark = condensed && task.due ? dueTone(task.due, today, open) : "";
   const link = task.sessions.filter((l) => l.session_id !== sessionId).at(-1);
   const meta = [
      task.priority !== "none" && <PriorityIcon key="p" priority={task.priority} />,
      task.due && (
         <span key="due" className={cn(META_CHIP, dueTone(task.due, today, open))}>
            <CalendarDays className="size-2.5" />
            {formatDue(task.due, today)}
         </span>
      ),
      waitsOn > 0 && <WaitsOnChip key="waits" count={waitsOn} />,
      parent && (
         <span key="parent" className={META_CHIP}>
            <CornerDownRight className="size-2.5" />
            <span className="truncate">
               <InlineMarkdown variant="quiet">{parent.title}</InlineMarkdown>
            </span>
         </span>
      ),
      progress && progress.total > 0 && (
         <span key="sub" className={META_CHIP} title="Subtasks done">
            {progress.done}/{progress.total}
         </span>
      ),
      task.upstream && (
         <span key="up" className={cn(META_CHIP, "text-sky-600 dark:text-sky-400")}>
            {upstreamText(task.upstream)}
         </span>
      ),
      link && (
         <span key="session" className={META_CHIP} title="Started a Session">
            <span className="size-1.5 shrink-0 rounded-full bg-sky-500" />
            <span className="truncate">
               {sessionTitle(link.session_id, link.title, sessions).title}
            </span>
         </span>
      ),
   ].filter(Boolean);
   const picked =
      selected && "bg-sky-500/10 shadow-[inset_3px_0_0_var(--color-sky-400)] hover:bg-sky-500/15";
   if (condensed)
      return (
         <div
            aria-current={selected || undefined}
            className={cn(
               "group/task flex items-center gap-2 rounded-md px-2 py-1 hover:bg-accent/60",
               picked,
               className,
            )}
         >
            <StatusMenu status={task.status} variant="icon" onChange={onStatus} />
            <button
               type="button"
               className="flex min-w-0 flex-1 items-center gap-1.5 text-left outline-none focus-visible:underline"
               onClick={onOpen}
            >
               <span
                  className={cn(
                     "min-w-0 flex-1 truncate text-[13px] leading-5",
                     !open && "text-muted-foreground line-through",
                  )}
               >
                  <InlineMarkdown variant="quiet">{task.title}</InlineMarkdown>
               </span>
               {dueMark && task.due && (
                  <CalendarDays
                     role="img"
                     aria-label={`Due ${formatDue(task.due, today)}`}
                     className={cn("size-3 shrink-0", dueMark)}
                  />
               )}
            </button>
         </div>
      );
   return (
      <div
         aria-current={selected || undefined}
         className={cn(
            "group/task flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-accent/60",
            picked,
            className,
         )}
      >
         <span className="mt-px">
            <StatusMenu status={task.status} variant="icon" onChange={onStatus} />
         </span>
         <button
            type="button"
            className="min-w-0 flex-1 text-left outline-none focus-visible:underline"
            onClick={onOpen}
         >
            <span
               className={cn(
                  "block text-[13px] leading-5",
                  !open && "text-muted-foreground line-through",
               )}
            >
               <InlineMarkdown variant="quiet">{task.title}</InlineMarkdown>
            </span>
            {meta.length > 0 && (
               <span className="mt-1 flex flex-wrap items-center gap-1.5">{meta}</span>
            )}
         </button>
      </div>
   );
}

/**
 * "waits on N": the task has N open blockers (ADR 0029). `narrow`: in a narrow container (`@container` below md),
 * only the mark and N.
 */
export function WaitsOnChip({
   count,
   narrow,
   className,
}: {
   count: number;
   narrow?: boolean;
   className?: string;
}) {
   return (
      <span
         className={cn(META_CHIP, "text-amber-600 dark:text-amber-400", className)}
         title={`Waits on ${count} open ${count === 1 ? "task" : "tasks"}`}
      >
         <Hourglass className="size-2.5" />
         {narrow ? (
            <span>
               <span className="@max-md:hidden">waits on </span>
               {count}
            </span>
         ) : (
            `waits on ${count}`
         )}
      </span>
   );
}
