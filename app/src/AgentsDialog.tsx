import { inTauri } from "@harness/api";
import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Loader2, RefreshCw } from "lucide-react";
import type { AgentInfo, HarnessClient, RegistryAgent } from "@harness/api";
import {
  Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, ScrollArea, Textarea, cn,
} from "@harness/ui";

/** Inside Tauri, links open in the default browser; in a plain browser the anchor works as is. */
function openExternal(e: React.MouseEvent, url: string) {
  if (!inTauri()) return;
  e.preventDefault();
  void import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(url));
}

const errText = (e: unknown) => (e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e));

function AgentIcon({ icon, name }: { icon: string | null; name: string }) {
  const [broken, setBroken] = useState(false);
  if (icon && !broken) {
    return <img src={icon} alt="" className="size-8 shrink-0 rounded object-contain" onError={() => setBroken(true)} />;
  }
  return (
    <div className="grid size-8 shrink-0 place-items-center rounded bg-muted text-sm font-medium uppercase">{name.slice(0, 1)}</div>
  );
}

/** Installed Agents, the ACP Registry, and Custom Agents. */
export function AgentsDialog({
  client, open, onOpenChange, onChanged, version = 0,
}: {
  client: HarnessClient;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Called after the installed list changed. */
  onChanged?: () => void;
  /** Bumps when the core reports AgentsChanged: reloads the lists while open. */
  version?: number;
}) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [registry, setRegistry] = useState<RegistryAgent[]>([]);
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [installing, setInstalling] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [listError, setListError] = useState<string | null>(null);
  const [toRemove, setToRemove] = useState<AgentInfo | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [env, setEnv] = useState("");
  const [customError, setCustomError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(
    async (refresh: boolean) => {
      setListError(null);
      try {
        const [a, r] = await Promise.all([client.listAgents(), client.listRegistry(refresh)]);
        setAgents(a);
        setRegistry(r);
      } catch (e) {
        setListError(errText(e));
      }
    },
    [client],
  );

  useEffect(() => {
    if (open) void load(false);
  }, [open, load, version]);

  const refresh = async () => {
    setRefreshing(true);
    await load(true);
    setRefreshing(false);
  };

  const install = async (id: string) => {
    setInstalling((s) => new Set(s).add(id));
    setErrors((e) => ({ ...e, [id]: "" }));
    try {
      await client.installAgent(id);
      await load(false);
      onChanged?.();
    } catch (e) {
      setErrors((x) => ({ ...x, [id]: errText(e) }));
    } finally {
      setInstalling((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
    }
  };

  const remove = async () => {
    if (!toRemove) return;
    try {
      await client.removeAgent(toRemove.id);
      setToRemove(null);
      await load(false);
      onChanged?.();
    } catch (e) {
      setRemoveError(errText(e));
    }
  };

  const addCustom = async () => {
    setAdding(true);
    setCustomError(null);
    try {
      const envMap: Record<string, string> = {};
      for (const line of env.split("\n")) {
        const l = line.trim();
        if (!l) continue;
        const i = l.indexOf("=");
        if (i < 1) throw new Error(`Invalid env line "${l}", expected KEY=VALUE`);
        envMap[l.slice(0, i).trim()] = l.slice(i + 1);
      }
      await client.addCustomAgent({ name: name.trim(), command: command.trim(), args: args.split(/\s+/).filter(Boolean), env: envMap });
      setName(""); setCommand(""); setArgs(""); setEnv("");
      await load(false);
      onChanged?.();
    } catch (e) {
      setCustomError(errText(e));
    } finally {
      setAdding(false);
    }
  };

  const registryVersion = (a: AgentInfo) =>
    a.source?.type === "registry" ? registry.find((r) => r.id === (a.source as { registry_id: string }).registry_id) : undefined;
  const q = query.trim().toLowerCase();
  const shown = registry.filter((r) => !q || r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q));

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Agents</DialogTitle>
            <DialogDescription>Install Agents from the ACP Registry or add your own.</DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[70vh]">
            <div className="grid gap-5 pr-3 text-sm">
              {listError && <p role="alert" className="text-destructive">{listError}</p>}

              <section className="grid gap-2">
                <h3 className="font-medium">Installed</h3>
                <ul className="divide-y rounded-md border">
                  {agents.length === 0 && <li className="p-3 text-xs text-muted-foreground">No Agents installed yet.</li>}
                  {agents.map((a) => {
                    const reg = registryVersion(a);
                    const canUpdate = !!reg && !!a.version && reg.version !== a.version && !!reg.install_method;
                    const id = reg?.id ?? "";
                    return (
                      <li key={a.id} className="flex items-center gap-3 px-3 py-2">
                        <AgentIcon icon={a.icon} name={a.name} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate font-medium">{a.name}</span>
                            <Badge variant="secondary">{a.source?.type === "registry" ? "registry" : "custom"}</Badge>
                            {a.version && <span className="text-xs text-muted-foreground">v{a.version}</span>}
                          </div>
                          {id && errors[id] && <p role="alert" className="text-xs text-destructive">{errors[id]}</p>}
                        </div>
                        {canUpdate && (
                          <Button size="sm" variant="outline" disabled={installing.has(id)} onClick={() => void install(id)}>
                            {installing.has(id) && <Loader2 className="animate-spin" />} Update to v{reg!.version}
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => { setToRemove(a); setRemoveError(null); }}>Remove</Button>
                      </li>
                    );
                  })}
                </ul>
              </section>

              <section className="grid gap-2">
                <div className="flex items-center gap-2">
                  <h3 className="font-medium">ACP Registry</h3>
                  <div className="flex-1" />
                  <Input className="max-w-48" placeholder="Search" aria-label="Search registry" value={query} onChange={(e) => setQuery(e.target.value)} />
                  <Button size="sm" variant="ghost" aria-label="Refresh registry" title="Refresh registry" disabled={refreshing} onClick={() => void refresh()}>
                    <RefreshCw className={cn(refreshing && "animate-spin")} />
                  </Button>
                </div>
                <ul className="divide-y rounded-md border">
                  {shown.length === 0 && <li className="p-3 text-xs text-muted-foreground">No matching Agents.</li>}
                  {shown.map((r) => {
                    const unavailable = !r.install_method;
                    const busy = installing.has(r.id);
                    return (
                      <li key={r.id} className={cn("flex items-center gap-3 px-3 py-2", unavailable && "opacity-50")}>
                        <AgentIcon icon={r.icon} name={r.name} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate font-medium">{r.name}</span>
                            <span className="text-xs text-muted-foreground">v{r.version}</span>
                            {r.website && (
                              <a href={r.website} target="_blank" rel="noreferrer" onClick={(e) => openExternal(e, r.website!)} aria-label={`${r.name} website`} className="text-muted-foreground hover:text-foreground">
                                <ExternalLink className="size-3.5" />
                              </a>
                            )}
                          </div>
                          <p className="line-clamp-2 text-xs text-muted-foreground">{r.description}</p>
                          {unavailable && <p className="text-xs">Not available on this Mac</p>}
                          {errors[r.id] && <p role="alert" className="text-xs text-destructive">{errors[r.id]}</p>}
                          {busy && <p className="text-xs text-muted-foreground">Installing, this can take a minute on first use...</p>}
                        </div>
                        {r.installed_version ? (
                          <Badge variant="success">Installed</Badge>
                        ) : (
                          <Button size="sm" disabled={unavailable || busy} onClick={() => void install(r.id)}>
                            {busy && <Loader2 className="animate-spin" />} Install
                          </Button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>

              <section className="grid gap-2">
                <h3 className="font-medium">Add Custom Agent</h3>
                <div className="grid gap-2">
                  <label className="grid gap-1">Name<Input value={name} onChange={(e) => setName(e.target.value)} /></label>
                  <label className="grid gap-1">
                    Command (absolute path)
                    <Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="/usr/local/bin/my-agent" />
                  </label>
                  <label className="grid gap-1">Args<Input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="--acp --verbose" /></label>
                  <label className="grid gap-1">
                    Env (KEY=VALUE per line)
                    <Textarea rows={3} value={env} onChange={(e) => setEnv(e.target.value)} />
                  </label>
                  {customError && <p role="alert" className="text-destructive">{customError}</p>}
                  <div className="flex justify-end">
                    <Button disabled={adding || !name.trim() || !command.trim()} onClick={() => void addCustom()}>Add Agent</Button>
                  </div>
                </div>
              </section>
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>
      <Dialog open={toRemove !== null} onOpenChange={(o) => !o && setToRemove(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove Agent?</DialogTitle>
            <DialogDescription>"{toRemove?.name}" will be removed. Existing Sessions keep their own copy of its launch settings.</DialogDescription>
          </DialogHeader>
          {removeError && <p role="alert" className="text-sm text-destructive">{removeError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setToRemove(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => void remove()}>Remove</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
