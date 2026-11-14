import type { AgentInfo } from "@harness/api";
import { Button, cn } from "@harness/ui";
import { Check, Plus } from "lucide-react";
import { AgentIcon } from "../settings/AgentsPanel";
import { matches } from "./composer";
import { FieldButton, Picker, type PickItem } from "./Picker";
import { Label } from "./parts";

export function AgentField({
   agents,
   agentId,
   setAgentId,
   agentOpen,
   setAgentOpen,
   agentQuery,
   setAgentQuery,
   onManageAgents,
}: {
   agents: AgentInfo[];
   agentId: string;
   setAgentId: (id: string) => void;
   agentOpen: boolean;
   setAgentOpen: (o: boolean) => void;
   agentQuery: string;
   setAgentQuery: (q: string) => void;
   onManageAgents?: () => void;
}) {
   // ---- Agent list
   const agent = agents.find((a) => a.id === agentId);
   const agentItems: PickItem[] = [
      ...agents
         .filter((a) => matches(agentQuery, a.name, a.id))
         .map(
            (a): PickItem => ({
               key: a.id,
               selected: a.id === agentId,
               onSelect: () => {
                  setAgentId(a.id);
                  setAgentOpen(false);
                  setAgentQuery("");
               },
               content: (
                  <>
                     <AgentIcon icon={a.icon} name={a.name} className="size-5 text-xs" />
                     <span className="min-w-0 flex-1 truncate">{a.name}</span>
                     {a.version && (
                        <span className="shrink-0 text-xs text-muted-foreground">v{a.version}</span>
                     )}
                     <Check
                        className={cn(
                           "size-4 shrink-0 text-primary",
                           a.id !== agentId && "invisible",
                        )}
                     />
                  </>
               ),
            }),
         ),
      ...(onManageAgents
         ? [
              {
                 key: "manage",
                 separated: true,
                 onSelect: () => {
                    setAgentOpen(false);
                    setAgentQuery("");
                    onManageAgents();
                 },
                 content: (
                    <>
                       <Plus className="size-4 shrink-0 text-muted-foreground" />
                       <span>Install or manage Agents…</span>
                    </>
                 ),
              },
           ]
         : []),
   ];

   return (
      <div className="grid gap-2">
         <Label>Agent</Label>
         {agents.length === 0 ? (
            <div className="flex h-9 items-center gap-2 rounded-md border pl-3 pr-1">
               <span className="flex-1 text-muted-foreground">No Agents installed yet</span>
               <Button size="sm" variant="ghost" className="h-7" onClick={onManageAgents}>
                  Open Agents
               </Button>
            </div>
         ) : (
            <Picker
               label="Agents"
               open={agentOpen}
               onOpenChange={(o) => {
                  setAgentOpen(o);
                  if (!o) setAgentQuery("");
               }}
               search={
                  agents.length > 6
                     ? {
                          value: agentQuery,
                          onChange: setAgentQuery,
                          placeholder: "Filter Agents",
                       }
                     : undefined
               }
               items={agentItems}
               trigger={
                  <FieldButton
                     icon={
                        agent ? (
                           <AgentIcon
                              icon={agent.icon}
                              name={agent.name}
                              className="size-4 text-[10px]"
                           />
                        ) : null
                     }
                     title={agent?.name}
                     subtitle={agent?.version ? `v${agent.version}` : undefined}
                     placeholder="Pick an Agent"
                  />
               }
            />
         )}
      </div>
   );
}
