import type { TaskToolSummary } from "@harness/api";
import { useContext } from "react";
import { InlineMarkdown } from "../../markdown/InlineMarkdown";
import { OpenTask } from "../../tasks/openTask";
import { StatusIcon } from "../../tasks/StatusMenu";
import type { Tool } from "../group";
import { CallBody } from "./CallBody";

const ROW = "flex min-w-0 items-center gap-2 text-ui-sm";

/** A `task_add` or `task_update` call: the tasks it added or changed, each opening in the Tasks panel. */
export function TasksBody({ tool, summary: s }: { tool: Tool; summary: TaskToolSummary }) {
   const open = useContext(OpenTask);
   return (
      <>
         {s.tasks.length > 0 && (
            <ul className="flex flex-col gap-1">
               {s.tasks.map((t, i) => {
                  const label = (
                     <>
                        <StatusIcon status={t.status ?? "todo"} />
                        <span className="truncate">
                           <InlineMarkdown variant="quiet">{t.title}</InlineMarkdown>
                        </span>
                     </>
                  );
                  const id = t.id;
                  return (
                     <li key={id ?? i}>
                        {open && id ? (
                           <button
                              type="button"
                              onClick={() => open(id)}
                              title={`Open ${id} in the Tasks panel`}
                              className={`${ROW} max-w-full text-left hover:underline`}
                           >
                              {label}
                           </button>
                        ) : (
                           <div className={ROW}>{label}</div>
                        )}
                     </li>
                  );
               })}
            </ul>
         )}
         {s.error && <CallBody tool={tool} />}
      </>
   );
}
