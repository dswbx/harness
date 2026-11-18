import { isOpen, type TaskStatus, type TaskSummary } from "@harness/api";
import { cn } from "@harness/ui";
import { CalendarDays, CornerDownRight } from "lucide-react";
import { InlineMarkdown } from "../markdown/InlineMarkdown";
import { META_CHIP } from "./chips";
import { dueTone, formatDue } from "./DuePicker";
import { PriorityIcon } from "./PriorityMenu";
import { StatusMenu } from "./StatusMenu";
import { upstreamText } from "./UpstreamField";

/**
 * One task in a list: the status (a menu), the title, and under it the priority, due date, parent, subtask count,
 * upstream id and the last Session started from it (other than this one). A click opens the task.
 */
export function TaskRow({
   task,
   parent,
   progress,
   today,
   sessionId,
   onOpen,
   onStatus,
   className,
}: {
   task: TaskSummary;
   /** Shown as a chip (null: none, or not shown). */
   parent: Pick<TaskSummary, "title"> | null;
   /** Done and total subtasks (null: none). */
   progress: { done: number; total: number } | null;
   /** `YYYY-MM-DD`, for overdue dates. */
   today: string;
   /** The Session the list is in (null: none). */
   sessionId: string | null;
   onOpen: () => void;
   onStatus: (status: TaskStatus) => void;
   className?: string;
}) {
   const open = isOpen(task.status);
   const link = task.sessions.filter((l) => l.session_id !== sessionId).at(-1);
   const meta = [
      task.priority !== "none" && <PriorityIcon key="p" priority={task.priority} />,
      task.due && (
         <span key="due" className={cn(META_CHIP, dueTone(task.due, today, open))}>
            <CalendarDays className="size-2.5" />
            {formatDue(task.due, today)}
         </span>
      ),
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
            <span className="truncate">{link.title}</span>
         </span>
      ),
   ].filter(Boolean);
   return (
      <div
         className={cn(
            "group/task flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-accent/60",
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
