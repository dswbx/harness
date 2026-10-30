import { describe, expect, it } from "vitest";
import type { McpServerDef, PermissionRule, RuleScope } from "@harness/api";
import { filterRules, parseScope, scopeLabel, summary } from "./settings";

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
    expect(ids(filterRules(rules, "all"))).toEqual(["1", "2", "3"]);
    expect(ids(filterRules(rules, "global"))).toEqual(["1"]);
    expect(ids(filterRules(rules, "agent"))).toEqual(["2"]);
    expect(ids(filterRules(rules, "session"))).toEqual(["3"]);
  });
});

const stdio = (name: string, command: string, args?: string[]): McpServerDef => ({ id: name, name, transport: { type: "stdio", command, args } });
const http = (name: string, url: string): McpServerDef => ({ id: name, name, transport: { type: "http", url } });

describe("summary", () => {
  const ss = [stdio("GitHub", "npx", ["-y", "server-github"]), http("Docs", "https://example.com/mcp"), stdio("Bare", "node")];
  it("summary", () => {
    expect(summary(ss[0])).toBe("npx -y server-github");
    expect(summary(ss[1])).toBe("https://example.com/mcp");
    expect(summary(ss[2])).toBe("node");
  });
});
