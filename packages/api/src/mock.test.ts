import { describe, expect, it, vi } from "vitest";
import { createSessionApi, HarnessClient } from "./client";
import type { AppEvent, Event } from "./generated";
import { MockTransport } from "./mock";

describe("MockTransport app events", () => {
   it("emits SessionsChanged / AgentsChanged and stops after unsubscribe", async () => {
      const client = new HarnessClient(new MockTransport([], []));
      const got: AppEvent[] = [];
      const off = await client.subscribeApp((e) => got.push(e));
      const id = await client.createSession({
         folder: "/tmp/x",
         agentId: "codex",
         frontendId: "chat",
      });
      await client.archiveSession(id);
      await client.addCustomAgent({ name: "Mine", command: "x", args: [], env: {} });
      expect(got.map((e) => e.type)).toEqual([
         "SessionsChanged",
         "SessionsChanged",
         "AgentsChanged",
      ]);
      off();
      await client.deleteSession(id);
      expect(got).toHaveLength(3);
   });
});

describe("MockTransport PR references", () => {
   it("looks up PRs in order, searches with own PRs first", async () => {
      const transport = new MockTransport([], []);
      const spark = await new HarnessClient(transport).createSession({
         folder: "/tmp/spark",
         agentId: "codex",
         frontendId: "chat",
      });
      expect((await createSessionApi(transport, spark).prContext()).session_repo).toEqual({
         owner: "supabase",
         name: "spark",
      });
      const api = createSessionApi(transport, "mock-1");
      const ctx = await api.prContext();
      expect(ctx.session_repo).toEqual({ owner: "dswbx", name: "harness" });
      expect(ctx.me).toBe("dswbx");
      expect(ctx.known_repos.map((k) => `${k.repo.owner}/${k.repo.name}`)).toEqual([
         "dswbx/harness",
         "supabase/spark",
         "supabase/supabase",
         "supabase/lite",
         "dswbx/spikes",
      ]);
      const prs = await api.lookupPrs([
         { repo: { owner: "supabase", name: "spark" }, number: 17 },
         { repo: { owner: "dswbx", name: "harness" }, number: 9999 },
         { repo: { owner: "DSWBX", name: "Harness" }, number: 23 },
      ]);
      expect(prs.map((p) => p && `${p.number} ${p.state}`)).toEqual(["17 open", null, "23 merged"]);
      const states = new Set(
         (await api.searchPrs({ owner: "dswbx", name: "harness" })).map((p) => p.state),
      );
      expect(states).toEqual(new Set(["open", "draft", "merged", "closed"]));
      const found = await api.searchPrs({ owner: "dswbx", name: "harness" }, "Summar");
      expect(found.map((p) => p.number)).toEqual([20]);
      const all = await api.searchPrs({ owner: "dswbx", name: "harness" });
      const mine = all.map((p) => p.author === "dswbx");
      expect(mine).toEqual([...mine].sort((a, b) => Number(b) - Number(a)));
   });
});

describe("Session subscription lag recovery", () => {
   it("resubscribes from the next unseen seq after the core drops the View", async () => {
      const transport = new MockTransport([], []);
      const client = new HarnessClient(transport);
      const id = await client.createSession({
         folder: "/tmp/x",
         agentId: "codex",
         frontendId: "chat",
      });
      const api = createSessionApi(transport, id);
      const seqs: number[] = [];
      const off = await api.subscribe((e) => seqs.push(e.seq));
      const before = seqs.length;
      await client.archiveSession(id);
      expect(seqs.length).toBe(before + 1);
      transport.dropSubscribersAsLagged(id);
      // Events appended while dropped are replayed by the new subscription, exactly once.
      await client.unarchiveSession(id);
      await client.archiveSession(id);
      await new Promise((r) => setTimeout(r, 10));
      expect(seqs).toEqual(seqs.map((_, i) => seqs[0] + i));
      expect(seqs.length).toBe(before + 3);
      off();
      await client.unarchiveSession(id);
      expect(seqs.length).toBe(before + 3);
   });
});

describe("MockTransport Side Threads", () => {
   const modeOpt = (currentValue: string) => ({
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue,
      options: [
         { value: "read-only", name: "Read-only" },
         { value: "auto", name: "Auto" },
         { value: "full", name: "Full access" },
      ],
   });
   const fixture: Event[] = [
      {
         v: 1,
         seq: 0,
         session_id: "x",
         thread_id: "main",
         ts_ms: 0,
         kind: { type: "ThreadStarted", agent_id: "codex", main: true },
      },
      {
         v: 1,
         seq: 1,
         session_id: "x",
         thread_id: "main",
         ts_ms: 0,
         kind: { type: "ConfigOptionsChanged", options: [modeOpt("auto")] },
      },
   ];
   const setup = async () => {
      const transport = new MockTransport(fixture, []);
      const api = createSessionApi(transport, "mock-1");
      const events: Event[] = [];
      await api.subscribe((e) => events.push(e));
      return { api, events };
   };
   const sideMode = (events: Event[], thread: string) => {
      const k = [...events]
         .reverse()
         .find((e) => e.thread_id === thread && e.kind.type === "ConfigOptionsChanged")?.kind as
         | { options: { currentValue: string }[] }
         | undefined;
      return k?.options[0]?.currentValue;
   };

   it("reports the asking mode as side_mode on Main's config options", async () => {
      const { events } = await setup();
      const k = events.find((e) => e.kind.type === "ConfigOptionsChanged")!.kind;
      expect(k).toMatchObject({ side_mode: "read-only" });
   });

   it("starts a fresh Side Thread without forked_from, in the given mode", async () => {
      const { api, events } = await setup();
      const r = await api.startSideThread({ source: "fresh", mode: "full" });
      expect(r.forked).toBe(false);
      const started = events.find(
         (e) => e.thread_id === r.thread_id && e.kind.type === "ThreadStarted",
      )!.kind;
      expect(started).not.toHaveProperty("forked_from");
      expect(sideMode(events, r.thread_id)).toBe("full");
      vi.useFakeTimers();
      await api.prompt("hi", [], r.thread_id);
      expect(
         events.find((e) => e.thread_id === r.thread_id && e.kind.type === "AgentSessionStarted")
            ?.kind,
      ).toMatchObject({ boundary: "initial" });
      vi.runAllTimers();
      vi.useRealTimers();
      const reply = events
         .filter((e) => e.thread_id === r.thread_id && e.kind.type === "AgentMessageChunk")
         .map((e) => (e.kind as { text: string }).text)
         .join("");
      expect(reply).toContain("fresh Side Thread");
   });

   it("a seeded Side Thread keeps forked_from and starts in the asking mode", async () => {
      const { api, events } = await setup();
      const r = await api.startSideThread();
      const started = events.find(
         (e) => e.thread_id === r.thread_id && e.kind.type === "ThreadStarted",
      )!.kind;
      expect(started).toMatchObject({ forked_from: { thread_id: "main", turn: 0 } });
      expect(sideMode(events, r.thread_id)).toBe("read-only");
   });
});
