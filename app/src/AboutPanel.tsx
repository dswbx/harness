import { ArrowUpRight } from "lucide-react";
import { Button } from "@harness/ui";
import { SectionHeader } from "./SectionHeader";
import { openExternal } from "./openExternal";
import { releaseUrl, useAppVersion, useUpdate, useUpdateCheck } from "./updates";

/** Version, and the same opt-in update flow as the sidebar footer. */
export function AboutPanel() {
  const version = useAppVersion();
  const { state, restarting, install, restart } = useUpdate();
  const { checking, result, check } = useUpdateCheck();

  return (
    <div className="grid gap-6">
      <SectionHeader title="About" description="Harness looks for updates on launch and every few hours. Nothing downloads until you choose Update." />
      <div className="grid gap-3 text-sm">
        <p>
          Version <span className="font-mono">{version ?? "…"}</span>
        </p>
        <div className="flex flex-wrap items-center gap-3">
          {state.kind === "idle" && (
            <>
              <Button size="sm" variant="outline" disabled={checking} onClick={() => void check()}>
                {checking ? "Checking…" : "Check for updates"}
              </Button>
              {result?.kind === "latest" && <span className="text-muted-foreground">You're up to date.</span>}
              {result?.kind === "error" && <span role="alert" className="text-destructive">{result.message}</span>}
            </>
          )}
          {(state.kind === "available" || state.kind === "failed") && (
            <>
              <Button size="sm" onClick={install}>{state.kind === "failed" ? "Retry update to" : "Update to"} {state.version}</Button>
              <a href={releaseUrl(state.version)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground" onClick={(e) => openExternal(e, releaseUrl(state.version))}>
                Changes <ArrowUpRight className="size-3.5" />
              </a>
              {state.kind === "failed" && <span role="alert" className="w-full text-destructive">{state.error}</span>}
            </>
          )}
          {state.kind === "downloading" && (
            <div className="grid w-full max-w-sm gap-2">
              <div className="flex justify-between text-muted-foreground">
                <span>Downloading {state.version}</span>
                {state.percent != null && <span className="tabular-nums">{state.percent}%</span>}
              </div>
              <div className="h-1 overflow-hidden rounded-full bg-muted">
                <div className="h-full bg-blue-400 transition-[width]" style={{ width: `${state.percent ?? 0}%` }} />
              </div>
            </div>
          )}
          {state.kind === "ready" && (
            <>
              <Button size="sm" disabled={restarting} onClick={restart}>{restarting ? "Restarting…" : `Restart to finish (${state.version})`}</Button>
              <span className="text-muted-foreground">Installed, applies on restart.</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
