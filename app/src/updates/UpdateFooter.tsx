import { openExternalLink } from "@harness/api";
import { Button, cn, Spinner, Tooltip } from "@harness/ui";
import { ArrowUpRight, Check, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { BUSY_HINT, releaseUrl, type useUpdate } from "./updates";

const link =
   "inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground [&_svg]:size-3";

/** While `busy`, explains why the wrapped (disabled) button is off. A span: a disabled button gets no hover. */
export function BusyTip({
   busy,
   className,
   children,
}: {
   busy: boolean;
   className?: string;
   children: ReactNode;
}) {
   if (!busy) return children;
   return (
      <Tooltip content={BUSY_HINT}>
         <span className={cn("inline-flex", className)}>{children}</span>
      </Tooltip>
   );
}

/** Sidebar footer for an opt-in update; renders nothing while there is none. Update and restart
 * are off while `busy` (an Agent is working). */
export function UpdateFooter({
   update: { state, restarting, install, restart },
   busy,
}: {
   update: ReturnType<typeof useUpdate>;
   busy: boolean;
}) {
   if (state.kind === "idle") return null;
   const changes = (
      <a
         href={releaseUrl(state.version)}
         target="_blank"
         rel="noreferrer"
         className={link}
         onClick={(e) => openExternalLink(e, releaseUrl(state.version))}
      >
         Changes <ArrowUpRight />
      </a>
   );
   return (
      <div className="flex shrink-0 flex-col gap-2 border-t px-3 pb-3 pt-2.5 text-xs">
         {state.kind === "available" && (
            <>
               <div className="flex items-center gap-2">
                  <span className="size-2 rounded-full bg-blue-400" />
                  <span className="flex-1">Update available</span>
                  <span className="tabular-nums text-muted-foreground">{state.version}</span>
               </div>
               <div className="flex items-center gap-2.5">
                  <BusyTip busy={busy} className="flex-1 [&>button]:flex-1">
                     <Button size="sm" className="h-7 flex-1" disabled={busy} onClick={install}>
                        Update
                     </Button>
                  </BusyTip>
                  {changes}
               </div>
            </>
         )}
         {state.kind === "downloading" && (
            <>
               <div className="flex items-center gap-2 text-muted-foreground">
                  <span className="flex-1">Downloading {state.version}</span>
                  {state.percent != null && <span className="tabular-nums">{state.percent}%</span>}
               </div>
               <div className="flex h-7 items-center">
                  <div
                     className="h-1 w-full overflow-hidden rounded-full bg-muted"
                     role="progressbar"
                     aria-label="Downloading update"
                     aria-valuenow={state.percent ?? undefined}
                  >
                     <div
                        className="h-full bg-blue-400 transition-[width]"
                        style={{ width: `${state.percent ?? 0}%` }}
                     />
                  </div>
               </div>
            </>
         )}
         {state.kind === "ready" && (
            <>
               <div className="flex items-center gap-2">
                  {restarting ? (
                     <Spinner className="size-3.5 text-muted-foreground" />
                  ) : (
                     <Check className="size-3.5 text-green-400" />
                  )}
                  <span className="flex-1">
                     {restarting ? "Restarting…" : `${state.version} installed`}
                  </span>
               </div>
               <BusyTip busy={busy} className="flex-1 [&>button]:flex-1">
                  <Button size="sm" className="h-7" disabled={restarting || busy} onClick={restart}>
                     <RefreshCw /> Restart to finish
                  </Button>
               </BusyTip>
            </>
         )}
         {state.kind === "failed" && (
            <>
               <div className="flex items-center gap-2">
                  <span className="size-2 rounded-full bg-destructive" />
                  <Tooltip content={state.error}>
                     <span className="flex-1">Update failed</span>
                  </Tooltip>
               </div>
               <div className="flex items-center gap-2.5">
                  <BusyTip busy={busy} className="flex-1 [&>button]:flex-1">
                     <Button
                        size="sm"
                        variant="outline"
                        className="h-7 flex-1"
                        disabled={busy}
                        onClick={install}
                     >
                        Retry
                     </Button>
                  </BusyTip>
                  {changes}
               </div>
            </>
         )}
      </div>
   );
}
