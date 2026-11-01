import { ArrowUpRight, Check, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@harness/ui";
import { openExternal } from "./openExternal";
import { releaseUrl, type useUpdate } from "./updates";

const link = "inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground [&_svg]:size-3";

/** Sidebar footer for an opt-in update; renders nothing while there is none. */
export function UpdateFooter({ update: { state, restarting, install, restart } }: { update: ReturnType<typeof useUpdate> }) {
  if (state.kind === "idle") return null;
  const changes = (
    <a href={releaseUrl(state.version)} target="_blank" rel="noreferrer" className={link} onClick={(e) => openExternal(e, releaseUrl(state.version))}>
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
            <Button size="sm" className="h-7 flex-1" onClick={install}>Update</Button>
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
            <div className="h-1 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="Downloading update" aria-valuenow={state.percent ?? undefined}>
              <div className="h-full bg-blue-400 transition-[width]" style={{ width: `${state.percent ?? 0}%` }} />
            </div>
          </div>
        </>
      )}
      {state.kind === "ready" && (
        <>
          <div className="flex items-center gap-2">
            {restarting ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : <Check className="size-3.5 text-green-400" />}
            <span className="flex-1">{restarting ? "Restarting…" : `${state.version} installed`}</span>
          </div>
          <Button size="sm" className="h-7" disabled={restarting} onClick={restart}>
            <RefreshCw /> Restart to finish
          </Button>
        </>
      )}
      {state.kind === "failed" && (
        <>
          <div className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-destructive" />
            <span className="flex-1" title={state.error}>Update failed</span>
          </div>
          <div className="flex items-center gap-2.5">
            <Button size="sm" variant="outline" className="h-7 flex-1" onClick={install}>Retry</Button>
            {changes}
          </div>
        </>
      )}
    </div>
  );
}
