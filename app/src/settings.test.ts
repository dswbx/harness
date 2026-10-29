import { describe, expect, it } from "vitest";
import type { AgentInfo, McpServerDef, PermissionRule, RegistryAgent, RuleScope } from "@harness/api";
import { filterAgents, filterRegistry, filterRules, filterServers, parseScope, scopeLabel, summary } from "./settings";

const rule = (id: string, scope: RuleScope, o: Partial<PermissionRule> = {}): PermissionRule =>
  ({ id, scope, tool_kind: null, pattern: null, decision: "allow", ...o }) as PermissionRule;

const rules = [
  rule("1", { type: "global" }, { tool_kind: "execute", pattern: "git status", decision: "allow" }),
  rule("2", { type: "agent", agent_id: "claude" }, { tool_kind: "edit", pattern: "src/**", decision: "ask" }),
  rule("3", { type: "session", session_id: "sess-9" }, { decision: "deny" }),
];
const ids = (r: PermissionRule[]) => r.map((x) => x.id);

describe("parseScope", () => {
  it("global", () => expect(parseScope("global", null)).toEqual({ type: "global" }));
  it("agent", () => expect(parseScope("agent:claude", null)).toEqual({ type: "agent", agent_id: "claude" }));
  it("agent id with colon", () => expect(parseScope("agent:a:b:c", null)).toEqual({ type: "agent", agent_id: "a:b:c" }));
  it("session", () => expect(parseScope("session", "s1")).toEqual({ type: "session", session_id: "s1" }));
});

describe("scopeLabel", () => {
  it("labels", () => {
    expect(scopeLabel({ type: "global" })).toBe("global");
    expect(scopeLabel({ type: "agent", agent_id: "x" })).toBe("agent: x");
    expect(scopeLabel({ type: "session", session_id: "y" })).toBe("session: y");
  });
});

describe("filterRules", () => {
  it("scope filters", () => {
    expect(ids(filterRules(rules, "all", ""))).toEqual(["1", "2", "3"]);
    expect(ids(filterRules(rules, "global", ""))).toEqual(["1"]);
    expect(ids(filterRules(rules, "agent", ""))).toEqual(["2"]);
    expect(ids(filterRules(rules, "session", ""))).toEqual(["3"]);
  });
  it("matches pattern, kind, scope, decision", () => {
    expect(ids(filterRules(rules, "all", "src/"))).toEqual(["2"]);
    expect(ids(filterRules(rules, "all", "execute"))).toEqual(["1"]);
    expect(ids(filterRules(rules, "all", "sess-9"))).toEqual(["3"]);
    expect(ids(filterRules(rules, "all", "deny"))).toEqual(["3"]);
  });
  it("null kind matches 'any'", () => expect(ids(filterRules(rules, "all", "any"))).toEqual(["3"]));
  it("case-insensitive and trimmed", () => expect(ids(filterRules(rules, "all", "  GIT STATUS "))).toEqual(["1"]));
  it("whitespace query returns all", () => expect(filterRules(rules, "all", "   ")).toHaveLength(3));
  it("combines filter and query", () => expect(filterRules(rules, "global", "edit")).toEqual([]));
});

const agent = (name: string) => ({ id: name, name, command: "c", args: [], version: null, icon: null }) as AgentInfo;
const reg = (name: string, description: string) =>
  ({ id: name, name, version: "1", description, icon: null, website: null, install_method: null, installed_version: null }) as RegistryAgent;
const stdio = (name: string, command: string, args?: string[]): McpServerDef => ({ id: name, name, transport: { type: "stdio", command, args } });
const http = (name: string, url: string): McpServerDef => ({ id: name, name, transport: { type: "http", url } });

describe("filterAgents", () => {
  const as = [agent("Claude"), agent("Codex")];
  it("by name", () => expect(filterAgents(as, " CLA ").map((a) => a.name)).toEqual(["Claude"]));
  it("empty returns all", () => expect(filterAgents(as, "")).toHaveLength(2));
});

describe("filterRegistry", () => {
  const rs = [reg("Goose", "Open source agent"), reg("Gemini", "Google CLI")];
  it("by name", () => expect(filterRegistry(rs, "goose").map((r) => r.name)).toEqual(["Goose"]));
  it("by description", () => expect(filterRegistry(rs, "GOOGLE").map((r) => r.name)).toEqual(["Gemini"]));
  it("empty returns all", () => expect(filterRegistry(rs, " ")).toHaveLength(2));
});

describe("summary / filterServers", () => {
  const ss = [stdio("GitHub", "npx", ["-y", "server-github"]), http("Docs", "https://example.com/mcp"), stdio("Bare", "node")];
  it("summary", () => {
    expect(summary(ss[0])).toBe("npx -y server-github");
    expect(summary(ss[1])).toBe("https://example.com/mcp");
    expect(summary(ss[2])).toBe("node");
  });
  it("by name", () => expect(filterServers(ss, "github").map((s) => s.name)).toEqual(["GitHub"]));
  it("by command", () => expect(filterServers(ss, "server-github").map((s) => s.name)).toEqual(["GitHub"]));
  it("by url", () => expect(filterServers(ss, "EXAMPLE.com").map((s) => s.name)).toEqual(["Docs"]));
  it("empty returns all", () => expect(filterServers(ss, "")).toHaveLength(3));
});
