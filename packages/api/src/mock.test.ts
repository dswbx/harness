import { describe, expect, it } from "vitest";
import type { AppEvent } from "./generated";
import { HarnessClient, createSessionApi } from "./client";
import { MockTransport } from "./mock";

describe("MockTransport app events", () => {
  it("emits SessionsChanged / AgentsChanged and stops after unsubscribe", async () => {
    const client = new HarnessClient(new MockTransport([], []));
    const got: AppEvent[] = [];
    const off = await client.subscribeApp((e) => got.push(e));
    const id = await client.createSession({ folder: "/tmp/x", agentId: "codex", frontendId: "chat" });
    await client.archiveSession(id);
    await client.addCustomAgent({ name: "Mine", command: "x", args: [], env: {} });
    expect(got.map((e) => e.type)).toEqual(["SessionsChanged", "SessionsChanged", "AgentsChanged"]);
    off();
    await client.deleteSession(id);
    expect(got).toHaveLength(3);
  });
});

describe("MockTransport PR references", () => {
  it("looks up PRs in order, searches with own PRs first", async () => {
    const transport = new MockTransport([], []);
    const spark = await new HarnessClient(transport).createSession({ folder: "/tmp/spark", agentId: "codex", frontendId: "chat" });
    expect((await createSessionApi(transport, spark).prContext()).session_repo).toEqual({ owner: "supabase", name: "spark" });
    const api = createSessionApi(transport, "mock-1");
    const ctx = await api.prContext();
    expect(ctx.session_repo).toEqual({ owner: "dswbx", name: "harness" });
    expect(ctx.me).toBe("dswbx");
    expect(ctx.known_repos.map((k) => `${k.repo.owner}/${k.repo.name}`)).toEqual(["dswbx/harness", "supabase/spark", "supabase/supabase", "supabase/lite", "dswbx/spikes"]);
    const prs = await api.lookupPrs([
      { repo: { owner: "supabase", name: "spark" }, number: 17 },
      { repo: { owner: "dswbx", name: "harness" }, number: 9999 },
      { repo: { owner: "DSWBX", name: "Harness" }, number: 23 },
    ]);
    expect(prs.map((p) => p && `${p.number} ${p.state}`)).toEqual(["17 open", null, "23 merged"]);
    const states = new Set((await api.searchPrs({ owner: "dswbx", name: "harness" })).map((p) => p.state));
    expect(states).toEqual(new Set(["open", "draft", "merged", "closed"]));
    const found = await api.searchPrs({ owner: "dswbx", name: "harness" }, "Summar");
    expect(found.map((p) => p.number)).toEqual([20]);
    const all = await api.searchPrs({ owner: "dswbx", name: "harness" });
    const mine = all.map((p) => p.author === "dswbx");
    expect(mine).toEqual([...mine].sort((a, b) => Number(b) - Number(a)));
  });
});
