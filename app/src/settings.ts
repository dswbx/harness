import type { AgentInfo, McpServerDef, PermissionRule, RegistryAgent, RuleScope } from "@harness/api";

export const FILTERS = ["all", "global", "agent", "session"] as const;
export type Filter = (typeof FILTERS)[number];

export function scopeLabel(s: RuleScope): string {
  return s.type === "global" ? "global" : s.type === "agent" ? `agent: ${s.agent_id}` : `session: ${s.session_id}`;
}

/** Add-row select value: "global" | "agent:<id>" | "session". */
export function parseScope(value: string, sessionId: string | null): RuleScope {
  return value === "global"
    ? { type: "global" }
    : value === "session"
      ? { type: "session", session_id: sessionId! }
      : { type: "agent", agent_id: value.slice("agent:".length) };
}

export function filterRules(rules: PermissionRule[], filter: Filter, query: string): PermissionRule[] {
  const q = query.trim().toLowerCase();
  return rules.filter(
    (r) =>
      (filter === "all" || r.scope.type === filter) &&
      (!q || [r.pattern ?? "", r.tool_kind ?? "any", scopeLabel(r.scope), r.decision].some((t) => t.toLowerCase().includes(q))),
  );
}

export function filterAgents(agents: AgentInfo[], query: string): AgentInfo[] {
  const q = query.trim().toLowerCase();
  return agents.filter((a) => !q || a.name.toLowerCase().includes(q));
}

export function filterRegistry(registry: RegistryAgent[], query: string): RegistryAgent[] {
  const q = query.trim().toLowerCase();
  return registry.filter((r) => !q || r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q));
}

export function summary(s: McpServerDef) {
  return s.transport.type === "stdio" ? `${s.transport.command} ${(s.transport.args ?? []).join(" ")}`.trim() : s.transport.url;
}

export function filterServers(servers: McpServerDef[], query: string): McpServerDef[] {
  const q = query.trim().toLowerCase();
  return servers.filter((s) => !q || s.name.toLowerCase().includes(q) || summary(s).toLowerCase().includes(q));
}

export type Row = { key: string; value: string; secret: boolean; /** Secret already stored in the Keychain. */ stored: boolean };
export type Form = { id: string; name: string; kind: "stdio" | "http"; command: string; args: string; url: string; rows: Row[] };

/** Form -> command payload. Secret values go to `secrets`, never into the definition. */
export function fromForm(f: Form): { server: McpServerDef; secrets: Record<string, string> } {
  const plain: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  const secretKeys: string[] = [];
  for (const r of f.rows) {
    const key = r.key.trim();
    if (!key) continue;
    if (r.secret) {
      secretKeys.push(key);
      if (r.value) secrets[key] = r.value;
    } else plain[key] = r.value;
  }
  const transport: McpServerDef["transport"] =
    f.kind === "stdio"
      ? { type: "stdio", command: f.command.trim(), args: f.args.split(/\s+/).filter(Boolean), env: plain }
      : { type: "http", url: f.url.trim(), headers: plain };
  return { server: { id: f.id, name: f.name.trim(), transport, secret_keys: secretKeys }, secrets };
}
