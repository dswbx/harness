import type { AgentInfo, HarnessClient, RegistryAgent } from "@harness/api";
import { Badge, Button, cn, Spinner } from "@harness/ui";
import { checkLine } from "../agents";
import { AgentIcon } from "./AgentIcon";
import { heading } from "./heading";

/** The Installed Agents: update, roll back, hold, remove. */
export function InstalledList({
   client,
   agents,
   registry,
   installing,
   errors,
   act,
   install,
   onRemove,
}: {
   client: HarnessClient;
   agents: AgentInfo[];
   registry: RegistryAgent[];
   installing: Set<string>;
   errors: Record<string, string>;
   act: (regId: string, run: () => Promise<unknown>) => Promise<void>;
   install: (id: string, allowUnverified?: boolean) => Promise<void>;
   /** Asks to remove this Agent. */
   onRemove: (a: AgentInfo) => void;
}) {
   const registryVersion = (a: AgentInfo) =>
      a.source?.type === "registry"
         ? registry.find((r) => r.id === (a.source as { registry_id: string }).registry_id)
         : undefined;

   return (
      <section className="grid gap-2">
         <h3 className={heading}>Installed</h3>
         <ul className="divide-y rounded-md border">
            {agents.length === 0 && (
               <li className="p-3 text-xs text-muted-foreground">No Agents installed yet.</li>
            )}
            {agents.map((a) => {
               const reg = registryVersion(a);
               const canUpdate =
                  !!reg && !!a.version && reg.version !== a.version && !!reg.install_method;
               const id = reg?.id ?? "";
               const line = checkLine(a);
               const held = !!a.install?.held;
               const previous = a.install?.previous;
               return (
                  <li key={a.id} className="flex items-center gap-3 px-3 py-2">
                     <AgentIcon icon={a.icon} name={a.name} />
                     <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                           <span className="truncate font-medium">{a.name}</span>
                           <Badge variant="secondary">
                              {a.source?.type === "registry" ? "registry" : "custom"}
                           </Badge>
                           {a.version && (
                              <span className="text-xs text-muted-foreground">v{a.version}</span>
                           )}
                        </div>
                        {(held || a.install?.unverified) && (
                           <div className="mt-1 flex gap-1">
                              {held && <Badge variant="outline">held</Badge>}
                              {a.install?.unverified && (
                                 <Badge variant="warning">unverified download</Badge>
                              )}
                           </div>
                        )}
                        {line && (
                           <p
                              className={cn(
                                 "line-clamp-2 text-xs",
                                 line.ok ? "text-muted-foreground" : "text-destructive",
                              )}
                           >
                              {line.text}
                           </p>
                        )}
                        {previous && (
                           <p className="text-xs text-muted-foreground">
                              Previous: v{previous.version}
                           </p>
                        )}
                        {id && errors[id] && (
                           <p role="alert" className="text-xs text-destructive">
                              {errors[id]}
                           </p>
                        )}
                     </div>
                     {previous && (
                        <Button
                           size="sm"
                           variant="outline"
                           onClick={() => void act(id || a.id, () => client.rollbackAgent(a.id))}
                        >
                           Roll back to v{previous.version}
                        </Button>
                     )}
                     {a.source?.type === "registry" && (
                        <Button
                           size="sm"
                           variant={held ? "secondary" : "ghost"}
                           aria-pressed={held}
                           onClick={() =>
                              void act(id || a.id, () => client.holdAgentVersion(a.id, !held))
                           }
                        >
                           {held ? "Release hold" : "Hold"}
                        </Button>
                     )}
                     {canUpdate && !held && (
                        <Button
                           size="sm"
                           variant="outline"
                           disabled={installing.has(id)}
                           onClick={() => void install(id)}
                        >
                           {installing.has(id) && <Spinner />} Update to v{reg!.version}
                        </Button>
                     )}
                     <Button size="sm" variant="ghost" onClick={() => onRemove(a)}>
                        Remove
                     </Button>
                  </li>
               );
            })}
         </ul>
      </section>
   );
}
