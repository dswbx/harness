import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { inTauri, type AgentInfo, type Branches, type McpServerDef, type FrontendManifest, type HarnessClient } from "@harness/api";
import {
  Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Select,
} from "@harness/ui";

/** The Composer: sets up a new Session (Workspace, Agent, Frontend) before work starts. */
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
  const [folder, setFolder] = useState("");
  const [agentId, setAgentId] = useState("");
  const [frontendId, setFrontendId] = useState("");
  const [title, setTitle] = useState("");
  const [branches, setBranches] = useState<Branches | null>(null);
  const [branch, setBranch] = useState("");
  const [worktree, setWorktree] = useState(false);
  const [mcpServers, setMcpServers] = useState<McpServerDef[]>([]);
  const [mcpIds, setMcpIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  // Look up branches once a folder is chosen (debounced: the folder can be typed).
  useEffect(() => {
    setBranches(null);
    if (!isOpen || !folder.trim()) return;
    let off = false;
    const h = setTimeout(() => {
      client.listBranches(folder.trim()).then((b) => {
        if (off) return;
        setBranches(b);
        setBranch(b.current ?? b.branches[0] ?? "");
        setWorktree(false);
      }).catch((e) => !off && setError(String(e)));
    }, 250);
    return () => { off = true; clearTimeout(h); };
  }, [folder, isOpen, client]);

  const isRepo = branches?.repo_root != null;
  const pickBranch = (b: string) => {
    setBranch(b);
    // Switching to another branch would dirty-check the folder; a Worktree avoids that.
    setWorktree(b !== branches?.current);
  };

  const browse = async () => {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string") setFolder(picked);
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const id = await client.createSession({
        folder,
        agentId,
        frontendId,
        title: title.trim() || null,
        branch: isRepo && branch && branch !== branches?.current ? branch : null,
        worktree: isRepo && worktree,
        mcpServers: mcpIds,
      });
      setTitle("");
      setMcpIds([]);
      onOpenChange(false);
      onCreated(id);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New Session</DialogTitle>
          <DialogDescription>Pick the Workspace folder, the Agent and the Frontend. The Frontend is fixed for the Session's life.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 text-sm">
          <label className="grid gap-1">
            Workspace folder
            <div className="flex gap-2">
              <Input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="/path/to/repo" />
              {inTauri() && (
                <Button variant="outline" onClick={() => void browse()}>
                  Browse
                </Button>
              )}
            </div>
          </label>
          {isRepo && (
            <>
              <label className="grid gap-1">
                Branch
                <Select value={branch} onChange={(e) => pickBranch(e.target.value)}>
                  {branches!.current === null && <option value="">(detached HEAD)</option>}
                  {branches!.branches.map((b) => (
                    <option key={b} value={b}>{b}{b === branches!.current ? " (current)" : ""}</option>
                  ))}
                </Select>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  role="switch"
                  checked={worktree}
                  onChange={(e) => setWorktree(e.target.checked)}
                />
                Work in a new Worktree
                <span className="text-xs text-muted-foreground">on its own harness/ branch</span>
              </label>
            </>
          )}
          {branches && !isRepo && <p className="text-xs text-muted-foreground">Not a git repository</p>}
          <label className="grid gap-1">
            Agent
            {agents.length === 0 ? (
              <div className="flex items-center gap-2 rounded-md border p-2">
                <span className="flex-1 text-muted-foreground">No Agents installed yet</span>
                <Button size="sm" variant="outline" onClick={onManageAgents}>Open Agents</Button>
              </div>
            ) : (
              <Select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </Select>
            )}
          </label>
          <label className="grid gap-1">
            Frontend
            <Select value={frontendId} onChange={(e) => setFrontendId(e.target.value)}>
              {frontends.map((f) => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </Select>
          </label>
          {mcpServers.length > 0 && (
            <fieldset className="grid gap-1">
              <legend className="mb-1">MCP servers</legend>
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
            Title (optional)
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          {error && <p className="whitespace-pre-wrap text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={busy || !folder || !agentId || !frontendId} onClick={() => void create()}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
