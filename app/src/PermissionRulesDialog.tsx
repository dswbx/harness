import { useCallback, useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import type { AgentInfo, Decision, HarnessClient, PermissionRule, RuleScope } from "@harness/api";
import {
  Badge, Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Input, ScrollArea, Select,
} from "@harness/ui";

const KINDS = ["read", "edit", "delete", "move", "search", "execute", "fetch", "other"];

function scopeLabel(s: RuleScope): string {
  return s.type === "global" ? "global" : s.type === "agent" ? `agent: ${s.agent_id}` : `session: ${s.session_id}`;
}

/** Lists, adds and removes Permission Policy rules. */
export function PermissionRulesDialog({
  client, open, onOpenChange, sessionId, agentsVersion = 0,
}: {
  client: HarnessClient;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Currently selected Session, if any (enables the "this session" scope). */
  sessionId: string | null;
  /** Bump to reload the Agent list. */
  agentsVersion?: number;
}) {
  const [rules, setRules] = useState<PermissionRule[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [scopeType, setScopeType] = useState<"global" | "agent" | "session">("global");
  const [agentId, setAgentId] = useState("");
  const [kind, setKind] = useState("");
  const [pattern, setPattern] = useState("");
  const [decision, setDecision] = useState<Decision>("allow");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(
    () => client.listPermissionRules().then(setRules).catch((e) => setError(String(e))),
    [client],
  );

  useEffect(() => {
    if (!open) return;
    setError(null);
    void refresh();
    void client.listAgents().then((a) => {
      setAgents(a);
      setAgentId((cur) => cur || a[0]?.id || "");
    }).catch((e) => setError(String(e)));
  }, [open, client, refresh, agentsVersion]);

  useEffect(() => {
    if (scopeType === "session" && !sessionId) setScopeType("global");
  }, [scopeType, sessionId]);

  const add = async () => {
    setError(null);
    const scope: RuleScope =
      scopeType === "global"
        ? { type: "global" }
        : scopeType === "agent"
          ? { type: "agent", agent_id: agentId }
          : { type: "session", session_id: sessionId! };
    try {
      await client.addPermissionRule({ scope, tool_kind: kind || null, pattern: pattern.trim() || null, decision });
      setPattern("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (id: string) => {
    setError(null);
    try {
      await client.removePermissionRule(id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const placeholder = kind === "execute" ? "command prefix, e.g. git status" : "path glob, e.g. src/**";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Permission rules</DialogTitle>
          <DialogDescription>
            Rules auto-answer Agent permission requests. Narrowest scope wins, then the more specific rule, then the stricter decision.
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-64 rounded-md border">
          <ul className="divide-y text-sm">
            {rules.length === 0 && <li className="p-3 text-xs text-muted-foreground">No rules.</li>}
            {rules.map((r) => (
              <li key={r.id} className="flex items-center gap-2 px-3 py-2">
                <Badge variant={r.decision === "allow" ? "success" : r.decision === "deny" ? "destructive" : "warning"}>{r.decision}</Badge>
                <span className="text-xs text-muted-foreground">{scopeLabel(r.scope)}</span>
                <span>{r.tool_kind ?? "any"}</span>
                {r.pattern && <code className="truncate rounded bg-muted px-1 text-xs">{r.pattern}</code>}
                <div className="flex-1" />
                <Button size="sm" variant="ghost" aria-label="Delete rule" onClick={() => void remove(r.id)}>
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        </ScrollArea>
        <div className="grid gap-2 text-sm">
          <div className="grid grid-cols-2 gap-2">
            <label className="grid gap-1">
              Scope
              <Select value={scopeType} onChange={(e) => setScopeType(e.target.value as typeof scopeType)}>
                <option value="global">Global</option>
                <option value="agent">Agent</option>
                {sessionId && <option value="session">This session</option>}
              </Select>
            </label>
            {scopeType === "agent" ? (
              <label className="grid gap-1">
                Agent
                <Select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </Select>
              </label>
            ) : (
              <div />
            )}
            <label className="grid gap-1">
              Kind
              <Select value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="">Any</option>
                {KINDS.map((k) => (
                  <option key={k} value={k}>{k}</option>
                ))}
              </Select>
            </label>
            <label className="grid gap-1">
              Decision
              <Select value={decision} onChange={(e) => setDecision(e.target.value as Decision)}>
                <option value="allow">Allow</option>
                <option value="ask">Ask</option>
                <option value="deny">Deny</option>
              </Select>
            </label>
          </div>
          <label className="grid gap-1">
            Pattern (optional)
            <Input value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder={placeholder} />
          </label>
          {error && <p className="text-destructive">{error}</p>}
          <div className="flex justify-end">
            <Button disabled={scopeType === "agent" && !agentId} onClick={() => void add()}>Add rule</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
