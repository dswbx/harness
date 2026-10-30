import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Check, ChevronRight, Folder, FolderPlus, GitBranch, GitPullRequest, Info, List, MessageSquare, Plus, Puzzle } from "lucide-react";
import {
  inTauri, type AgentInfo, type BranchInfo, type Branches, type FrontendManifest, type HarnessClient, type McpServerDef, type PrFilter,
  type PullRequest,
} from "@harness/api";
import {
  Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Tooltip, cn,
} from "@harness/ui";
import { AgentIcon } from "./AgentsPanel";
import { FieldButton, Picker, type PickItem } from "./Picker";
import {
  baseName, loadRecent, matches, mergeRecent, parsePrRef, relTime, rememberFolder, sessionFolders, tildify, type RecentFolder,
} from "./composer";

/** What the Session starts from in a repository. */
type Target =
  | { kind: "local"; name: string }
  | { kind: "remote"; name: string }
  | { kind: "new"; name: string };

/** A PR picked from the list, or typed by number (title unknown). */
type PickedPr = Pick<PullRequest, "number"> & Partial<PullRequest>;

const PR_FILTERS: [PrFilter, string][] = [["open", "Open"], ["mine", "Mine"], ["review_requested", "Review requested"]];

/** Known Frontends get an icon and a line of text; others show their version. */
const FRONTEND_INFO: Record<string, { icon: typeof MessageSquare; text: string }> = {
  chat: { icon: MessageSquare, text: "Messages and tools" },
  inspector: { icon: List, text: "Raw Session Log" },
};

function Label({ children, extra }: { children: React.ReactNode; extra?: React.ReactNode }) {
  return (
    <div className="flex min-h-6 items-center gap-1">
      <span className="text-xs font-medium text-muted-foreground">{children}</span>
      {extra}
    </div>
  );
}

function PrIcon({ pr, className }: { pr?: PickedPr | null; className?: string }) {
  const color = !pr?.checks
    ? "text-muted-foreground"
    : pr.draft
      ? "text-muted-foreground/60"
      : { passing: "text-emerald-500", failing: "text-red-500", pending: "text-amber-500", none: "text-muted-foreground" }[pr.checks];
  const state = pr?.draft ? "Draft" : pr?.checks ? `Checks ${pr.checks}` : undefined;
  return <GitPullRequest className={cn("size-4 shrink-0", color, className)} aria-label={state} aria-hidden={!state} />;
}

function AheadBehind({ b }: { b?: BranchInfo }) {
  if (!b || (!b.ahead && !b.behind)) return null;
  return <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{b.ahead ? `↑${b.ahead}` : ""}{b.ahead && b.behind ? " " : ""}{b.behind ? `↓${b.behind}` : ""}</span>;
}

function Pill({ children }: { children: React.ReactNode }) {
  return <span className="shrink-0 rounded-full border px-1.5 text-[11px] leading-4 text-muted-foreground">{children}</span>;
}

/** The Composer: sets up a new Session (Workspace, start point, Agent, Frontend) before work starts. */
export function ComposerDialog({
  client, open: isOpen, onOpenChange, onCreated, agentsVersion = 0, mcpVersion = 0, onManageAgents,
}: {
  /** Bump to reload the Agent list (after installs/removals). */
  agentsVersion?: number;
  /** Bump to reload the MCP Library. */
  mcpVersion?: number;
  onManageAgents?: () => void;
  client: HarnessClient;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (sessionId: string) => void;
}) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [frontends, setFrontends] = useState<FrontendManifest[]>([]);
  const [agentId, setAgentId] = useState("");
  const [frontendId, setFrontendId] = useState("");
  const [title, setTitle] = useState("");
  const [mcpServers, setMcpServers] = useState<McpServerDef[]>([]);
  const [mcpIds, setMcpIds] = useState<string[]>([]);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Workspace folder
  const [recent, setRecent] = useState<RecentFolder[]>([]);
  const [folder, setFolder] = useState("");
  const [folderOpen, setFolderOpen] = useState(false);
  const [folderQuery, setFolderQuery] = useState("");
  /** Current branch per recent folder (`null`: not a repository), loaded when the list opens. */
  const [recentBranch, setRecentBranch] = useState<Record<string, string | null>>({});

  // Start point
  const [branches, setBranches] = useState<Branches | null>(null);
  const [mode, setMode] = useState<"branch" | "pr">("branch");
  const [target, setTarget] = useState<Target | null>(null);
  const [worktree, setWorktree] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const [branchQuery, setBranchQuery] = useState("");
  const [prs, setPrs] = useState<PullRequest[] | null>(null);
  /** `false` when `gh` can't list PRs here: the Pull request tab is hidden. */
  const [prAvailable, setPrAvailable] = useState(false);
  const [prFilter, setPrFilter] = useState<PrFilter>("open");
  const [prQuery, setPrQuery] = useState("");
  const [prOpen, setPrOpen] = useState(false);
  const [pr, setPr] = useState<PickedPr | null>(null);

  const [agentOpen, setAgentOpen] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    void Promise.all([client.listAgents(), client.listFrontends()]).then(([a, f]) => {
      setAgents(a);
      setFrontends(f);
      setAgentId((cur) => (a.some((x) => x.id === cur) ? cur : a[0]?.id || ""));
      setFrontendId((cur) => cur || (f.find((x) => x.id === "chat") ?? f[0])?.id || "");
    }).catch((e) => setError(String(e)));
  }, [isOpen, client, agentsVersion]);

  useEffect(() => {
    if (!isOpen) return;
    void client.listMcpServers().then((l) => {
      setMcpServers(l);
      setMcpIds((cur) => cur.filter((id) => l.some((s) => s.id === id)));
    }).catch((e) => { setMcpServers([]); setError(`Could not load MCP servers: ${e instanceof Error ? e.message : String(e)}`); });
  }, [isOpen, client, mcpVersion]);

  // Recent folders: picked here before, plus folders of existing Sessions. Preselect the newest.
  useEffect(() => {
    if (!isOpen) return;
    let off = false;
    void client.listSessions().catch(() => []).then((sessions) => {
      if (off) return;
      const r = mergeRecent(loadRecent(), sessionFolders(sessions));
      setRecent(r);
      setFolder((cur) => cur || r[0]?.path || "");
    });
    return () => { off = true; };
  }, [isOpen, client]);

  useEffect(() => {
    if (!folderOpen) return;
    for (const { path } of recent.slice(0, 12)) {
      if (path in recentBranch) continue;
      client.listBranches(path)
        .then((b) => setRecentBranch((m) => ({ ...m, [path]: b.repo_root ? (b.current ?? "detached") : null })))
        .catch(() => setRecentBranch((m) => ({ ...m, [path]: null })));
    }
  }, [folderOpen, recent, recentBranch, client]);

  // Branches (and whether PRs are available) once a folder is chosen; debounced, it can be typed.
  useEffect(() => {
    setBranches(null);
    setPrs(null);
    setPrAvailable(false);
    setPr(null);
    setMode("branch");
    if (!isOpen || !folder.trim()) return;
    let off = false;
    const h = setTimeout(() => {
      client.listBranches(folder.trim()).then((b) => {
        if (off) return;
        setBranches(b);
        const first = b.current ?? b.branches[0]?.name;
        setTarget(first ? { kind: "local", name: first } : null);
        setWorktree(false);
      }).catch((e) => !off && setError(String(e)));
    }, 250);
    return () => { off = true; clearTimeout(h); };
  }, [folder, isOpen, client]);

  const isRepo = branches?.repo_root != null;

  useEffect(() => {
    if (!isRepo || !folder.trim()) return;
    let off = false;
    setPrs(null);
    client.listPullRequests(folder.trim(), prFilter).then((l) => {
      if (off) return;
      setPrs(l);
      setPrAvailable(true);
    }).catch(() => {
      if (off) return;
      setPrAvailable(false);
      setMode("branch");
    });
    return () => { off = true; };
  }, [isRepo, folder, prFilter, client]);

  const local = useMemo(() => new Map(branches?.branches.map((b) => [b.name, b])), [branches]);
  const targetInfo = target?.kind === "local" ? local.get(target.name) : target?.kind === "remote" ? branches?.remote.find((b) => b.name === target.name) : undefined;
  /** Another branch than the folder's, checked out elsewhere, or remote-only: needs a Worktree. */
  const mustWorktree = target?.kind === "remote" || (target?.kind === "local" && !!targetInfo?.worktree);

  const pickTarget = (t: Target) => {
    setTarget(t);
    setBranchOpen(false);
    setBranchQuery("");
    const info = t.kind === "local" ? local.get(t.name) : undefined;
    // Switching the folder to another branch would need a clean tree; a Worktree avoids that.
    setWorktree(t.kind === "remote" || (t.kind === "local" && (t.name !== branches?.current || !!info?.worktree)) || (t.kind === "new" && worktree));
  };

  const pickFolder = (p: string) => {
    setFolder(p);
    setFolderOpen(false);
    setFolderQuery("");
  };

  const browse = async () => {
    setFolderOpen(false);
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string") pickFolder(picked);
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const repoArgs = !isRepo
        ? {}
        : mode === "pr" && pr
          ? { pr: pr.number }
          : target?.kind === "new"
            ? { newBranch: target.name, worktree }
            : target?.kind === "remote"
              ? { branch: target.name, worktree: true }
              : { branch: target && target.name !== branches?.current ? target.name : null, worktree };
      const id = await client.createSession({
        folder: folder.trim(),
        agentId,
        frontendId,
        title: title.trim() || null,
        mcpServers: mcpIds,
        ...repoArgs,
      });
      rememberFolder(folder.trim());
      setTitle("");
      setMcpIds([]);
      setPr(null);
      onOpenChange(false);
      onCreated(id);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const canCreate = !busy && !!folder.trim() && !!agentId && !!frontendId &&
    (!isRepo || (mode === "pr" ? !!pr : !!target?.name.trim()));

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    if (e.key === "Enter" && canCreate) {
      e.preventDefault();
      void create();
    } else if (e.key.toLowerCase() === "o" && inTauri()) {
      e.preventDefault();
      void browse();
    }
  };

  // ---- Folder list
  const fq = folderQuery.trim();
  const folderItems: PickItem[] = [
    ...(fq.startsWith("/") && !recent.some((r) => r.path === fq.replace(/\/+$/, ""))
      ? [{ key: "typed", onSelect: () => pickFolder(fq), content: <><Folder className="size-4 shrink-0 text-muted-foreground" /><span className="truncate">Use <span className="font-mono text-[13px]">{fq}</span></span></> }]
      : []),
    ...recent.filter((r) => matches(fq, baseName(r.path), r.path)).map((r): PickItem => {
      const b = recentBranch[r.path];
      return {
        key: r.path,
        section: "Recent",
        selected: r.path === folder,
        onSelect: () => pickFolder(r.path),
        content: (
          <>
            <Folder className={cn("size-4 shrink-0", r.path === folder ? "text-primary" : "text-muted-foreground")} />
            <span className="flex min-w-0 flex-1 items-baseline gap-2">
              <span className="shrink-0">{baseName(r.path)}</span>
              <span className="min-w-0 truncate text-xs text-muted-foreground">{tildify(r.path)}</span>
            </span>
            {b === null ? <span className="shrink-0 text-xs text-muted-foreground">no git</span> : b && <span className="max-w-32 shrink-0 truncate font-mono text-[11px] text-muted-foreground">{b}</span>}
            <span className="w-14 shrink-0 text-right text-xs text-muted-foreground">{relTime(r.at)}</span>
          </>
        ),
      };
    }),
    ...(inTauri()
      ? [{
          key: "browse", separated: true, onSelect: () => void browse(),
          content: <><FolderPlus className="size-4 shrink-0 text-muted-foreground" /><span className="flex-1">Choose another folder…</span><kbd className="rounded border px-1 font-sans text-[11px] text-muted-foreground">⌘O</kbd></>,
        }]
      : []),
  ];

  // ---- Branch list
  const bq = branchQuery.trim();
  const branchExists = (n: string) => local.has(n) || !!branches?.remote.some((b) => b.name === n || b.name.split("/").slice(1).join("/") === n);
  const branchRow = (b: BranchInfo, remote: boolean) => (
    <>
      <GitBranch className="size-4 shrink-0 text-muted-foreground" />
      <span className="truncate font-mono text-[13px]">{b.name}</span>
      {b.name === branches?.current && <Pill>current</Pill>}
      {b.worktree && <Pill>worktree</Pill>}
      <span className="flex-1" />
      {!remote && <AheadBehind b={b} />}
      <span className="w-14 shrink-0 text-right text-xs text-muted-foreground">{b.time ? relTime(b.time * 1000) : ""}</span>
    </>
  );
  const branchItems: PickItem[] = [
    ...(bq && !branchExists(bq)
      ? [{
          key: "new", onSelect: () => pickTarget({ kind: "new", name: bq }),
          content: <><Plus className="size-4 shrink-0 text-muted-foreground" /><span className="truncate">Create branch <span className="font-mono text-[13px] font-medium">{bq}</span></span><span className="flex-1" /><span className="shrink-0 text-xs text-muted-foreground">from {branches?.current ?? "HEAD"}</span></>,
        }]
      : []),
    ...(branches?.branches ?? []).filter((b) => matches(bq, b.name)).map((b): PickItem => ({
      key: `l:${b.name}`, section: "Local", selected: target?.kind === "local" && target.name === b.name,
      onSelect: () => pickTarget({ kind: "local", name: b.name }), content: branchRow(b, false),
    })),
    ...(branches?.remote ?? []).filter((b) => matches(bq, b.name)).map((b): PickItem => ({
      key: `r:${b.name}`, section: "Remote only", selected: target?.kind === "remote" && target.name === b.name,
      onSelect: () => pickTarget({ kind: "remote", name: b.name }), content: branchRow(b, true),
    })),
  ];

  // ---- PR list
  const pq = prQuery.trim();
  const typedPr = parsePrRef(pq);
  const pickPr = (p: PickedPr) => {
    setPr(p);
    setPrOpen(false);
    setPrQuery("");
  };
  const prItems: PickItem[] = [
    ...(typedPr && !prs?.some((p) => p.number === typedPr)
      ? [{ key: "typed", onSelect: () => pickPr({ number: typedPr }), content: <><PrIcon /><span>Open PR <span className="font-medium">#{typedPr}</span></span></> }]
      : []),
    ...(prs ?? []).filter((p) => typedPr === p.number || matches(pq, p.title, `#${p.number}`, p.head, p.author)).map((p): PickItem => ({
      key: String(p.number),
      selected: pr?.number === p.number,
      onSelect: () => pickPr(p),
      content: (
        <>
          <PrIcon pr={p} className="self-start mt-0.5" />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate">{p.title}</span>
            <span className="truncate text-xs text-muted-foreground">
              #{p.number} · {p.draft ? "draft · " : ""}{p.author} · <span className="font-mono">{p.fork ? `fork:${p.head}` : p.head}</span> · {relTime(Date.parse(p.updated_at))}
            </span>
          </span>
        </>
      ),
    })),
  ];

  // ---- Agent list
  const agent = agents.find((a) => a.id === agentId);
  const agentItems: PickItem[] = [
    ...agents.map((a): PickItem => ({
      key: a.id,
      selected: a.id === agentId,
      onSelect: () => { setAgentId(a.id); setAgentOpen(false); },
      content: (
        <>
          <AgentIcon icon={a.icon} name={a.name} className="size-5 text-xs" />
          <span className="min-w-0 flex-1 truncate">{a.name}</span>
          {a.version && <span className="shrink-0 text-xs text-muted-foreground">v{a.version}</span>}
          <Check className={cn("size-4 shrink-0 text-primary", a.id !== agentId && "invisible")} />
        </>
      ),
    })),
    ...(onManageAgents
      ? [{ key: "manage", separated: true, onSelect: () => { setAgentOpen(false); onManageAgents(); }, content: <><Plus className="size-4 shrink-0 text-muted-foreground" /><span>Install or manage Agents…</span></> }]
      : []),
  ];

  const moreSummary = [
    mcpIds.length ? `${mcpIds.length} MCP server${mcpIds.length > 1 ? "s" : ""}` : mcpServers.length ? "no MCP servers" : null,
    title.trim() ? `“${title.trim()}”` : "no title",
  ].filter(Boolean).join(" · ");

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[32rem] gap-4 p-0" onKeyDown={onKeyDown}>
        <DialogHeader className="px-5 pt-5">
          <DialogTitle>New Session</DialogTitle>
          <DialogDescription className="sr-only">Pick the Workspace folder, where to start, the Agent and the Frontend.</DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 px-5 text-sm">
          <div className="grid gap-2">
            <Label>Workspace</Label>
            <Picker
              label="Recent folders"
              open={folderOpen}
              onOpenChange={(o) => { setFolderOpen(o); if (!o) setFolderQuery(""); }}
              search={{ value: folderQuery, onChange: setFolderQuery, placeholder: "Filter recent folders or type a path" }}
              items={folderItems}
              empty={recent.length ? "No folder matches" : "No recent folders yet"}
              trigger={
                <FieldButton
                  icon={<Folder />}
                  title={folder ? baseName(folder) : undefined}
                  subtitle={folder ? tildify(folder) : undefined}
                  placeholder="Choose a folder"
                />
              }
            />
          </div>

          {isRepo && (
            <div className="grid gap-2">
              <Label
                extra={prAvailable && (
                  <div role="tablist" aria-label="Start from" className="ml-auto flex rounded-md bg-muted p-0.5 text-xs">
                    {(["branch", "pr"] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        role="tab"
                        aria-selected={mode === m}
                        onClick={() => setMode(m)}
                        className={cn("h-6 rounded px-2.5", mode === m ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground")}
                      >
                        {m === "branch" ? "Branch" : "Pull request"}
                      </button>
                    ))}
                  </div>
                )}
              >
                Start from
              </Label>
              {mode === "branch" ? (
                <>
                  <Picker
                    label="Branches"
                    open={branchOpen}
                    onOpenChange={(o) => { setBranchOpen(o); if (!o) setBranchQuery(""); }}
                    search={{ value: branchQuery, onChange: setBranchQuery, placeholder: "Find or create a branch", mono: true }}
                    items={branchItems}
                    hint="Another branch than the folder's opens in a new worktree."
                    trigger={
                      <FieldButton
                        icon={<GitBranch />}
                        placeholder="Pick a branch"
                        title={target && (
                          <span className="flex items-center gap-2">
                            <span className="truncate font-mono text-[13px] font-normal">{target.name}</span>
                            {target.kind === "local" && target.name === branches?.current && <Pill>current</Pill>}
                            {target.kind === "new" && <Pill>new from {branches?.current ?? "HEAD"}</Pill>}
                            {target.kind === "remote" && <Pill>remote</Pill>}
                            <span className="flex-1" />
                            <AheadBehind b={targetInfo} />
                          </span>
                        )}
                      />
                    }
                  />
                  <label className={cn("flex items-center gap-2", mustWorktree && "opacity-60")}>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={worktree || mustWorktree}
                      disabled={mustWorktree}
                      onClick={() => setWorktree((w) => !w)}
                      className={cn("relative h-4 w-7 shrink-0 rounded-full transition-colors", worktree || mustWorktree ? "bg-primary" : "bg-muted-foreground/30")}
                    >
                      <span className={cn("absolute top-0.5 size-3 rounded-full bg-background transition-all", worktree || mustWorktree ? "left-3.5" : "left-0.5")} />
                    </button>
                    <span>Work in a new worktree</span>
                    <span className="text-xs text-muted-foreground">
                      {mustWorktree ? (target?.kind === "remote" ? "needed for a remote branch" : "the branch is checked out elsewhere") : "keeps this folder untouched"}
                    </span>
                  </label>
                </>
              ) : (
                <Picker
                  label="Pull requests"
                  open={prOpen}
                  onOpenChange={(o) => { setPrOpen(o); if (!o) setPrQuery(""); }}
                  search={{ value: prQuery, onChange: setPrQuery, placeholder: "Search PRs, or paste a number or URL" }}
                  header={
                    <div className="flex gap-1.5 px-2 pt-2">
                      {PR_FILTERS.map(([f, name]) => (
                        <button
                          key={f}
                          type="button"
                          onClick={() => setPrFilter(f)}
                          className={cn("h-6 rounded-full px-2.5 text-xs", prFilter === f ? "bg-accent text-accent-foreground" : "border text-muted-foreground hover:text-foreground")}
                        >
                          {name}
                        </button>
                      ))}
                    </div>
                  }
                  items={prItems}
                  empty={prs === null ? "Loading pull requests…" : "No pull requests"}
                  hint="A PR always opens in a new worktree on its head branch."
                  trigger={
                    <FieldButton
                      icon={<PrIcon pr={pr} />}
                      placeholder="Pick a pull request"
                      title={pr && <span className="truncate">#{pr.number}{pr.title ? ` ${pr.title}` : ""}</span>}
                    />
                  }
                />
              )}
            </div>
          )}

          <div className="grid gap-2">
            <Label>Agent</Label>
            {agents.length === 0 ? (
              <div className="flex h-9 items-center gap-2 rounded-md border pl-3 pr-1">
                <span className="flex-1 text-muted-foreground">No Agents installed yet</span>
                <Button size="sm" variant="ghost" className="h-7" onClick={onManageAgents}>Open Agents</Button>
              </div>
            ) : (
              <Picker
                label="Agents"
                open={agentOpen}
                onOpenChange={setAgentOpen}
                search={agents.length > 6 ? { value: "", onChange: () => {}, placeholder: "Filter Agents" } : undefined}
                items={agentItems}
                trigger={
                  <FieldButton
                    icon={agent ? <AgentIcon icon={agent.icon} name={agent.name} className="size-4 text-[10px]" /> : null}
                    title={agent?.name}
                    subtitle={agent?.version ? `v${agent.version}` : undefined}
                    placeholder="Pick an Agent"
                  />
                }
              />
            )}
          </div>

          <div className="grid gap-2">
            <Label
              extra={
                <Tooltip content="The Frontend is fixed for the Session's life.">
                  <button type="button" aria-label="About Frontends" className="grid size-5 place-items-center rounded-full text-muted-foreground hover:text-foreground">
                    <Info className="size-3.5" />
                  </button>
                </Tooltip>
              }
            >
              Frontend
            </Label>
            <div role="radiogroup" aria-label="Frontend" className="grid grid-cols-3 gap-2">
              {frontends.map((f) => {
                const info = FRONTEND_INFO[f.id];
                const Icon = info?.icon ?? Puzzle;
                const on = f.id === frontendId;
                return (
                  <Tooltip key={f.id} content={info?.text ?? `v${f.version}`}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => setFrontendId(f.id)}
                      className={cn(
                        "flex h-9 min-w-0 items-center gap-2 rounded-md border px-2.5 text-left shadow-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                        on ? "border-primary bg-accent" : "border-input hover:bg-accent/50",
                      )}
                    >
                      <Icon className={cn("size-4 shrink-0", on ? "text-foreground" : "text-muted-foreground")} />
                      <span className="truncate">{f.name}</span>
                    </button>
                  </Tooltip>
                );
              })}
            </div>
          </div>

          <div className="grid gap-3">
            <button type="button" aria-expanded={more} onClick={() => setMore((m) => !m)} className="flex items-center gap-1.5 text-left text-xs text-muted-foreground hover:text-foreground">
              <ChevronRight className={cn("size-3.5 transition-transform", more && "rotate-90")} />
              More options
              {!more && <span className="truncate text-muted-foreground/70">{moreSummary}</span>}
            </button>
            {more && (
              <div className="grid gap-3 pl-5">
                {mcpServers.length > 0 && (
                  <fieldset className="grid gap-1">
                    <legend className="mb-1 text-xs font-medium text-muted-foreground">MCP servers</legend>
                    {mcpServers.map((s) => (
                      <label key={s.id} className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={mcpIds.includes(s.id!)}
                          onChange={(e) => setMcpIds((cur) => (e.target.checked ? [...cur, s.id!] : cur.filter((x) => x !== s.id)))}
                        />
                        {s.name}
                        <span className="text-xs text-muted-foreground">{s.transport.type}</span>
                      </label>
                    ))}
                  </fieldset>
                )}
                <label className="grid gap-1">
                  <span className="text-xs font-medium text-muted-foreground">Title</span>
                  <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={mode === "pr" && pr?.title ? `#${pr.number} ${pr.title}` : folder ? baseName(folder) : "Optional"} />
                </label>
              </div>
            )}
          </div>
          {error && <p className="whitespace-pre-wrap text-destructive">{error}</p>}
        </div>

        <DialogFooter className="border-t px-5 py-3">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!canCreate} onClick={() => void create()}>
            Create <span className="text-xs opacity-60">⌘↵</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
