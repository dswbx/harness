import { baseName, type McpServerDef } from "@harness/api";
import { cn, Input } from "@harness/ui";
import { ChevronRight } from "lucide-react";
import type { PickedPr } from "./usePullRequests";

export function MoreOptions({
   more,
   setMore,
   mcpServers,
   mcpIds,
   setMcpIds,
   title,
   setTitle,
   mode,
   pr,
   noFolder,
   folder,
}: {
   more: boolean;
   setMore: (f: (m: boolean) => boolean) => void;
   mcpServers: McpServerDef[];
   mcpIds: string[];
   setMcpIds: (f: (cur: string[]) => string[]) => void;
   title: string;
   setTitle: (t: string) => void;
   mode: "branch" | "pr";
   pr: PickedPr | null;
   noFolder: boolean;
   folder: string;
}) {
   const moreSummary = [
      mcpIds.length
         ? `${mcpIds.length} MCP server${mcpIds.length > 1 ? "s" : ""}`
         : mcpServers.length
           ? "no MCP servers"
           : null,
      title.trim() ? `“${title.trim()}”` : "no title",
   ]
      .filter(Boolean)
      .join(" · ");

   return (
      <div className="grid gap-3">
         <button
            type="button"
            aria-expanded={more}
            onClick={() => setMore((m) => !m)}
            className="flex items-center gap-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
         >
            <ChevronRight className={cn("size-3.5 transition-transform", more && "rotate-90")} />
            More options
            {!more && <span className="truncate text-muted-foreground/70">{moreSummary}</span>}
         </button>
         {more && (
            <div className="grid gap-3 pl-5">
               {mcpServers.length > 0 && (
                  <fieldset className="grid gap-1">
                     <legend className="mb-1 text-xs font-medium text-muted-foreground">
                        MCP servers
                     </legend>
                     {mcpServers.map((s) => (
                        <label key={s.id} className="flex items-center gap-2">
                           <input
                              type="checkbox"
                              checked={mcpIds.includes(s.id!)}
                              onChange={(e) =>
                                 setMcpIds((cur) =>
                                    e.target.checked
                                       ? [...cur, s.id!]
                                       : cur.filter((x) => x !== s.id),
                                 )
                              }
                           />
                           {s.name}
                           <span className="text-xs text-muted-foreground">{s.transport.type}</span>
                        </label>
                     ))}
                  </fieldset>
               )}
               <label className="grid gap-1">
                  <span className="text-xs font-medium text-muted-foreground">Title</span>
                  <Input
                     value={title}
                     onChange={(e) => setTitle(e.target.value)}
                     placeholder={
                        mode === "pr" && pr?.title
                           ? `#${pr.number} ${pr.title}`
                           : noFolder
                             ? "First words of your message"
                             : folder
                               ? baseName(folder)
                               : "Optional"
                     }
                  />
               </label>
            </div>
         )}
      </div>
   );
}
