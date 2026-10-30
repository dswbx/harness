import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { AgentInfo, Decision, HarnessClient, PermissionRule } from "@harness/api";
import { Badge, Button, Input, Select, cn } from "@harness/ui";
import { SectionHeader } from "./SectionHeader";
import { FILTERS, filterRules, parseScope, scopeLabel, type Filter } from "./settings";

const KINDS = ["read", "edit", "delete", "move", "search", "execute", "fetch", "other"];
const errText = (e: unknown) => (e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e));

const sel = "h-8 px-2 text-xs";

/** Lists, adds and removes Permission Policy rules. */
export function PermissionsPanel({
  client, sessionId, agentsVersion = 0,
}: {
  client: HarnessClient;
  /** Currently selected Session, if any (enables the "this session" scope). */
  sessionId: string | null;
  /** Bump to reload the Agent list. */
  agentsVersion?: number;
}) {
  const [rules, setRules] = useState<PermissionRule[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  /** "global" | "agent:<id>" | "session" */
  const [scope, setScope] = useState("global");
  const [kind, setKind] = useState("");
  const [pattern, setPattern] = useState("");
  const [decision, setDecision] = useState<Decision>("allow");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(
    () => client.listPermissionRules().then(setRules).catch((e) => setError(errText(e))),
    [client],
  );

  useEffect(() => {
    setError(null);
    void refresh();
    void client.listAgents().then(setAgents).catch((e) => setError(errText(e)));
  }, [client, refresh, agentsVersion]);

  useEffect(() => {
    if (scope === "session" && !sessionId) setScope("global");
  }, [scope, sessionId]);

  const add = async () => {
    setError(null);
    const s = parseScope(scope, sessionId);
    try {
      await client.addPermissionRule({ scope: s, tool_kind: kind || null, pattern: pattern.trim() || null, decision });
      setPattern("");
      await refresh();
    } catch (e) {
      setError(errText(e));
    }
  };

  const remove = async (id: string) => {
    setError(null);
    try {
      await client.removePermissionRule(id);
      await refresh();
    } catch (e) {
      setError(errText(e));
    }
  };

  const placeholder = kind === "execute" ? "command prefix, e.g. git status" : "path glob, e.g. src/**";
  const shown = filterRules(rules, filter);

  return (
    <div className="text-sm">
      <SectionHeader
        title="Permissions"
        description="Rules auto-answer Agent permission requests. Narrowest scope wins, then the more specific rule, then the stricter decision."
      >
        <div role="group" aria-label="Filter by scope" className="inline-flex shrink-0 rounded-md border p-0.5">
          {FILTERS.map((f) => (
            <button
              key={f}
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
              className={cn("rounded px-2.5 py-1 text-xs capitalize", filter === f ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-accent/50")}
            >
              {f}
            </button>
          ))}
        </div>
      </SectionHeader>
      <div className="overflow-hidden rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Decision</th>
              <th className="px-3 py-2 font-medium">Scope</th>
              <th className="px-3 py-2 font-medium">Kind</th>
              <th className="px-3 py-2 font-medium">Pattern</th>
              <th className="w-10 px-3 py-2"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody className="divide-y">
            <tr className="border-t">
              <td className="px-2 py-2">
                <Select className={sel} aria-label="Decision" value={decision} onChange={(e) => setDecision(e.target.value as Decision)}>
                  <option value="allow">allow</option>
                  <option value="ask">ask</option>
                  <option value="deny">deny</option>
                </Select>
              </td>
              <td className="px-2 py-2">
                <Select className={sel} aria-label="Scope" value={scope} onChange={(e) => setScope(e.target.value)}>
                  <option value="global">Global</option>
                  {agents.map((a) => (
                    <option key={a.id} value={`agent:${a.id}`}>agent: {a.name}</option>
                  ))}
                  {sessionId && <option value="session">This session</option>}
                </Select>
              </td>
              <td className="px-2 py-2">
                <Select className={sel} aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)}>
                  <option value="">Any</option>
                  {KINDS.map((k) => (
                    <option key={k} value={k}>{k}</option>
                  ))}
                </Select>
              </td>
              <td className="px-2 py-2">
                <Input
                  className="h-8 font-mono text-xs"
                  aria-label="Pattern"
                  value={pattern}
                  onChange={(e) => setPattern(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void add()}
                  placeholder={placeholder}
                />
              </td>
              <td className="px-2 py-2">
                <Button size="icon" className="size-8" aria-label="Add rule" onClick={() => void add()}>
                  <Plus />
                </Button>
              </td>
            </tr>
            {shown.length === 0 && (
              <tr>
                <td colSpan={5} className="p-3 text-xs text-muted-foreground">{rules.length === 0 ? "No rules." : "No matching rules."}</td>
              </tr>
            )}
            {shown.map((r) => (
              <tr key={r.id}>
                <td className="px-3 py-1.5">
                  <Badge variant={r.decision === "allow" ? "success" : r.decision === "deny" ? "destructive" : "warning"}>{r.decision}</Badge>
                </td>
                <td className="px-3 py-1.5 text-xs text-muted-foreground">{scopeLabel(r.scope)}</td>
                <td className="px-3 py-1.5">{r.tool_kind ?? "any"}</td>
                <td className="max-w-0 px-3 py-1.5">
                  {r.pattern ? <code className="block truncate font-mono text-xs" title={r.pattern}>{r.pattern}</code> : <span className="text-xs text-muted-foreground">any</span>}
                </td>
                <td className="px-2 py-1.5">
                  <Button size="icon" variant="ghost" className="size-8" aria-label="Delete rule" onClick={() => void remove(r.id)}>
                    <Trash2 />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error && <p role="alert" className="mt-3 text-destructive">{error}</p>}
    </div>
  );
}
