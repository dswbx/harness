import { useCallback, useEffect, useState } from "react";
import { ArrowDown, ArrowUp, GitCommitHorizontal, RefreshCw, X } from "lucide-react";
import type { Diff, FileChange, GitStatus, SessionApi, WorkspaceInfo } from "@harness/api";
import { Button, Input, cn } from "@harness/ui";
import { parsePatch } from "./diff";

/** Diff range; `null` bounds mean "where the Session's changes start" / "the working tree now". */
export type DiffScope = { from: string | null; to: string | null; label: string };
export const ALL_CHANGES: DiffScope = { from: null, to: null, label: "All changes" };

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);

export function FileStat({ f }: { f: FileChange }) {
  return (
    <span className="flex min-w-0 items-center gap-2 font-mono text-xs">
      <span className="w-3 shrink-0 text-center text-muted-foreground" title={`status ${f.status}`}>{f.status}</span>
      <span className="min-w-0 flex-1 truncate">{f.path}</span>
      {f.additions != null && <span className="text-emerald-600">+{f.additions}</span>}
      {f.deletions != null && <span className="text-red-600">-{f.deletions}</span>}
    </span>
  );
}

function Patch({ patch }: { patch: string }) {
  const files = parsePatch(patch);
  if (files.length === 0) return <p className="p-3 text-xs text-muted-foreground">No changes.</p>;
  return (
    <div className="space-y-3 p-3">
      {files.map((f, i) => (
        <div key={i} className="overflow-hidden rounded border font-mono text-xs">
          <div className="border-b bg-muted px-2 py-1 text-muted-foreground">{f.path}</div>
          <pre className="overflow-x-auto">
            {f.lines.filter((l) => l.kind !== "meta").map((l, j) => (
              <div
                key={j}
                className={cn(
                  "whitespace-pre px-2",
                  l.kind === "add" && "bg-emerald-500/15",
                  l.kind === "del" && "bg-red-500/15",
                  l.kind === "hunk" && "bg-muted/60 text-muted-foreground",
                )}
              >
                {l.text || " "}
              </div>
            ))}
          </pre>
        </div>
      ))}
    </div>
  );
}

export function DiffPanel({
  api, scope, onScope, onClose, refreshKey,
}: {
  api: SessionApi;
  scope: DiffScope;
  onScope: (s: DiffScope) => void;
  onClose: () => void;
  /** Changes whenever the Session log says the Workspace may have changed. */
  refreshKey: string;
}) {
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null | undefined>(undefined);
  const [diff, setDiff] = useState<Diff | null>(null);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let off = false;
    api.workspace().then((w) => !off && setWorkspace(w)).catch(() => !off && setWorkspace(null));
    return () => { off = true; };
  }, [api]);

  const noRepo = workspace !== undefined && !workspace?.repo_root;

  const load = useCallback(async () => {
    setError(null);
    try {
      const [d, s] = await Promise.all([api.gitDiff(scope.from, scope.to), api.gitStatus()]);
      setDiff(d);
      setStatus(s);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [api, scope.from, scope.to]);

  useEffect(() => {
    if (workspace?.repo_root) void load();
  }, [workspace, load, refreshKey]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const commit = () =>
    act(async () => {
      await api.gitCommit(message.trim());
      setMessage("");
    });

  return (
    <aside className="flex h-full w-[420px] shrink-0 flex-col border-l bg-background" aria-label="Diff panel">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span className="text-sm font-medium">{scope.label}</span>
        {scope !== ALL_CHANGES && (
          <Button size="sm" variant="ghost" onClick={() => onScope(ALL_CHANGES)}>Show all</Button>
        )}
        <div className="flex-1" />
        <Button size="icon" variant="ghost" className="size-7" aria-label="Refresh diff" title="Refresh" disabled={noRepo || busy} onClick={() => void load()}>
          <RefreshCw />
        </Button>
        <Button size="icon" variant="ghost" className="size-7" aria-label="Close diff panel" onClick={onClose}>
          <X />
        </Button>
      </div>
      {noRepo ? (
        <p className="p-4 text-sm text-muted-foreground">This Session's folder is not a git repository, so there is nothing to diff, commit or push.</p>
      ) : (
        <>
          {error && <p role="alert" className="border-b px-3 py-2 text-xs text-destructive">{error}</p>}
          <div className="min-h-0 flex-1 overflow-auto">
            {diff && diff.files.length > 0 && (
              <ul className="space-y-1 border-b p-3">
                {diff.files.map((f) => (
                  <li key={f.path}><FileStat f={f} /></li>
                ))}
              </ul>
            )}
            {diff ? <Patch patch={diff.patch} /> : !error && <p className="p-3 text-xs text-muted-foreground">Loading...</p>}
          </div>
          <div className="space-y-2 border-t p-3">
            {scope === ALL_CHANGES && (
            <div className="flex gap-2">
              <Input
                value={message}
                placeholder="Commit message"
                aria-label="Commit message"
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && message.trim() && !busy) void commit(); }}
              />
              <Button disabled={busy || !message.trim()} onClick={() => void commit()}>
                <GitCommitHorizontal /> Commit
              </Button>
            </div>
            )}
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="min-w-0 flex-1 truncate">{status?.branch ?? "detached HEAD"}</span>
              <span className="flex items-center" title="ahead"><ArrowUp className="size-3" />{status?.ahead ?? 0}</span>
              <span className="flex items-center" title="behind"><ArrowDown className="size-3" />{status?.behind ?? 0}</span>
              <Button size="sm" variant="outline" disabled={busy || !status || (!!status.upstream && status.ahead === 0)}
                title={status && !status.upstream ? "Publish branch to origin" : undefined}
                onClick={() => void act(() => api.gitPush())}>
                Push
              </Button>
            </div>
          </div>
        </>
      )}
    </aside>
  );
}
