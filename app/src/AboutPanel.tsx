import { Button } from "@harness/ui";
import { SectionHeader } from "./SectionHeader";
import { restartToUpdate, useAppVersion, useUpdate, useUpdateCheck } from "./updates";

/** Version, and a manual update check (release builds also check on their own). */
export function AboutPanel() {
  const version = useAppVersion();
  const ready = useUpdate();
  const { checking, result, check } = useUpdateCheck();
  const pending = ready ?? (result?.kind === "ready" ? result.version : null);

  return (
    <div className="grid gap-6">
      <SectionHeader title="About" description="Harness checks for updates on launch and every few hours, and installs them in the background." />
      <div className="grid gap-3 text-sm">
        <p>
          Version <span className="font-mono">{version ?? "…"}</span>
        </p>
        <div className="flex items-center gap-3">
          {pending ? (
            <Button size="sm" onClick={() => void restartToUpdate()}>Restart to update to {pending}</Button>
          ) : (
            <Button size="sm" variant="outline" disabled={checking} onClick={() => void check()}>
              {checking ? "Checking…" : "Check for updates"}
            </Button>
          )}
          {!pending && result?.kind === "latest" && <span className="text-muted-foreground">You're up to date.</span>}
          {result?.kind === "error" && <span role="alert" className="text-destructive">{result.message}</span>}
        </div>
      </div>
    </div>
  );
}
