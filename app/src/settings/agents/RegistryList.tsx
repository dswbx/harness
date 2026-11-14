import type { RegistryAgent } from "@harness/api";
import { Badge, Button, cn, Tooltip } from "@harness/ui";
import { ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { openExternal } from "../../platform/openExternal";
import { AgentIcon } from "./AgentIcon";
import { heading } from "./heading";

/** The ACP Registry: what can be installed. */
export function RegistryList({
   registry,
   installing,
   errors,
   refreshing,
   refresh,
   install,
}: {
   registry: RegistryAgent[];
   installing: Set<string>;
   errors: Record<string, string>;
   refreshing: boolean;
   refresh: () => Promise<void>;
   install: (id: string, allowUnverified?: boolean) => Promise<void>;
}) {
   return (
      <section className="grid gap-2">
         <div className="flex items-center gap-2">
            <h3 className={heading}>ACP Registry</h3>
            <div className="flex-1" />
            <Tooltip content="Refresh registry">
               <Button
                  size="sm"
                  variant="ghost"
                  aria-label="Refresh registry"
                  disabled={refreshing}
                  onClick={() => void refresh()}
               >
                  <RefreshCw className={cn(refreshing && "animate-spin")} />
               </Button>
            </Tooltip>
         </div>
         <ul className="divide-y rounded-md border">
            {registry.length === 0 && (
               <li className="p-3 text-xs text-muted-foreground">No Agents in the registry.</li>
            )}
            {registry.map((r) => {
               const unavailable = !r.install_method;
               const busy = installing.has(r.id);
               return (
                  <li
                     key={r.id}
                     className={cn(
                        "flex items-center gap-3 px-3 py-2",
                        unavailable && "opacity-50",
                     )}
                  >
                     <AgentIcon icon={r.icon} name={r.name} />
                     <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                           <span className="truncate font-medium">{r.name}</span>
                           <span className="text-xs text-muted-foreground">v{r.version}</span>
                           {r.website && (
                              <a
                                 href={r.website}
                                 target="_blank"
                                 rel="noreferrer"
                                 onClick={(e) => openExternal(e, r.website!)}
                                 aria-label={`${r.name} website`}
                                 className="text-muted-foreground hover:text-foreground"
                              >
                                 <ExternalLink className="size-3.5" />
                              </a>
                           )}
                        </div>
                        <p className="line-clamp-2 text-xs text-muted-foreground">
                           {r.description}
                        </p>
                        {unavailable && <p className="text-xs">Not available on this Mac</p>}
                        {errors[r.id] && (
                           <p role="alert" className="text-xs text-destructive">
                              {errors[r.id]}
                           </p>
                        )}
                        {busy && (
                           <p className="text-xs text-muted-foreground">
                              Installing, this can take a minute on first use...
                           </p>
                        )}
                     </div>
                     {r.installed_version ? (
                        <Badge variant="success">Installed</Badge>
                     ) : (
                        <Button
                           size="sm"
                           disabled={unavailable || busy}
                           onClick={() => void install(r.id)}
                        >
                           {busy && <Loader2 className="animate-spin" />} Install
                        </Button>
                     )}
                  </li>
               );
            })}
         </ul>
      </section>
   );
}
