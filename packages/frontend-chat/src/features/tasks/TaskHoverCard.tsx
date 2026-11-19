import { isOpen, isOverdue, type SessionApi, type TaskSummary } from "@harness/api";
import { cn, Tooltip } from "@harness/ui";
import { type ReactElement, type ReactNode, useEffect, useState } from "react";
import { InlineMarkdown } from "../markdown/InlineMarkdown";
import { dueTone, formatDue } from "./DuePicker";
import { PRIORITY_LABEL, PriorityIcon } from "./PriorityMenu";
import { STATUS_LABEL, StatusIcon } from "./StatusMenu";
import { type Sessions, sessionTitle } from "./sessionTitle";
import { upstreamText } from "./UpstreamField";

/** Wait before the card shows (the app's tooltips wait 1 s). */
const OPEN_DELAY = 500;
/** Lines of the description the card shows. */
const BODY_LINES = 4;
/** Descriptions kept, by task id and change time. */
const CACHE_SIZE = 50;

/** The first lines of task descriptions read for a card, so hovering the same task again reads nothing. */
const bodies = new Map<string, string>();

/** The first non-empty lines of a Markdown body. */
const firstLines = (body: string) =>
   body
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, BODY_LINES)
      .join("\n");

/** The task's description (first lines), read once per change of the task; null while it loads. */
function useBodyPreview(api: SessionApi, task: TaskSummary): string | null {
   const key = `${task.id}@${task.updated_ms}`;
   const [text, setText] = useState(() => bodies.get(key) ?? null);
   useEffect(() => {
      if (!task.has_body || bodies.has(key)) return;
      let off = false;
      api.readTask(task.id).then(
         (t) => {
            const lines = firstLines(t.body);
            bodies.set(key, lines);
            if (bodies.size > CACHE_SIZE) bodies.delete(bodies.keys().next().value as string);
            if (!off) setText(lines);
         },
         () => !off && setText(""),
      );
      return () => {
         off = true;
      };
   }, [api, task.id, task.has_body, key]);
   return text;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
   return (
      <>
         <dt className="text-muted-foreground">{label}</dt>
         <dd className="flex min-w-0 items-center gap-1.5">{children}</dd>
      </>
   );
}

function Summary({
   api,
   task,
   parent,
   progress,
   today,
   sessions,
}: {
   api: SessionApi;
   task: TaskSummary;
   parent: Pick<TaskSummary, "title"> | null;
   progress: { done: number; total: number } | null;
   today: string;
   sessions: Sessions | undefined;
}) {
   const body = useBodyPreview(api, task);
   const open = isOpen(task.status);
   const origin = task.origin_session_id;
   const here = origin !== null && origin === api.sessionId;
   const started = task.sessions.length;
   return (
      <div className="space-y-2">
         <div className="text-[13px] font-medium leading-5">
            <InlineMarkdown variant="quiet">{task.title}</InlineMarkdown>
         </div>
         <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <Fact label="Status">
               <StatusIcon status={task.status} />
               {STATUS_LABEL[task.status]}
            </Fact>
            {task.priority !== "none" && (
               <Fact label="Priority">
                  <PriorityIcon priority={task.priority} />
                  {PRIORITY_LABEL[task.priority]}
               </Fact>
            )}
            {task.due && (
               <Fact label="Due">
                  <span className={cn(dueTone(task.due, today, open))}>
                     {formatDue(task.due, today)}
                     {open && isOverdue(task.due, today) && " · overdue"}
                  </span>
               </Fact>
            )}
            {parent && (
               <Fact label="Sub-task of">
                  <span className="truncate">
                     <InlineMarkdown variant="quiet">{parent.title}</InlineMarkdown>
                  </span>
               </Fact>
            )}
            {progress && progress.total > 0 && (
               <Fact label="Subtasks">
                  {progress.done}/{progress.total} done
               </Fact>
            )}
            {task.upstream && (
               <Fact label="Upstream">
                  <span className="truncate text-sky-600 dark:text-sky-400">
                     {upstreamText(task.upstream)}
                  </span>
               </Fact>
            )}
            {origin && (here || task.origin_title || sessions) && (
               <Fact label="Created in">
                  <span className="truncate">
                     {here
                        ? "This Session"
                        : sessionTitle(origin, task.origin_title, sessions).title}
                  </span>
               </Fact>
            )}
            {started > 0 && <Fact label="Sessions">{started} started from it</Fact>}
         </dl>
         {task.has_body && (
            <p
               className={cn(
                  "line-clamp-4 whitespace-pre-line border-t pt-2",
                  body === null ? "text-muted-foreground/60" : "text-muted-foreground",
               )}
            >
               {body === null ? "Loading description…" : body || "Has a description."}
            </p>
         )}
      </div>
   );
}

/**
 * A summary of `task` beside its row (`side`, by default left: the panel sits on the right edge), shown after a short
 * hover or on keyboard focus inside the row. It takes no focus, and closes on leave, a click in the row and a scroll.
 * The description is read when the card opens (cached per task change); the list holds no bodies.
 */
export function TaskHoverCard({
   api,
   task,
   parent,
   progress,
   today,
   side = "left",
   sessions,
   children,
}: {
   api: SessionApi;
   task: TaskSummary;
   parent: Pick<TaskSummary, "title"> | null;
   progress: { done: number; total: number } | null;
   today: string;
   side?: "left" | "right";
   /** Live Session titles. Absent: the titles cached on the task. */
   sessions?: Sessions;
   /** The row: it must take a ref. */
   children: ReactElement;
}) {
   return (
      <Tooltip
         side={side}
         align="start"
         sideOffset={10}
         delay={OPEN_DELAY}
         className="w-72 max-w-[min(18rem,var(--radix-tooltip-content-available-width))] p-3"
         // Focus that comes back after a menu or a click (not from the keyboard) does not open the card.
         onFocus={(e) => {
            if (!focusVisible(e.target)) e.preventDefault();
         }}
         content={
            <Summary
               api={api}
               task={task}
               parent={parent}
               progress={progress}
               today={today}
               sessions={sessions}
            />
         }
      >
         {children}
      </Tooltip>
   );
}

function focusVisible(el: Element): boolean {
   try {
      return el.matches(":focus-visible");
   } catch {
      return true;
   }
}
