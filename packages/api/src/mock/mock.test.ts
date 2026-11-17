import { describe, expect, it, vi } from "vitest";
import { createSessionApi, HarnessClient } from "../client/client";
import { expectResult } from "../client/expect";
import { CommandError } from "../errors";
import type { AppEvent, Command, Event } from "../generated";
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

describe("MockTransport Shared Artifacts (ADR 0024)", () => {
   const ui = (id: string, input: Record<string, unknown>): Event => ({
      v: 1,
      seq: 0,
      session_id: "x",
      thread_id: "main",
      ts_ms: 0,
      kind: { type: "FrontendToolOutput", tool: "render_ui", call_id: id, path: "p", input },
   });

   it("opens a shared artifact's content file in the editor without a Session", async () => {
      const transport = new MockTransport([], []);
      const client = new HarnessClient(transport);
      await expect(client.openSharedInEditor("release-checklist-3f9a1c")).rejects.toThrow(
         "choose an editor",
      );
      await client.setEditor({ type: "vscode" });
      await client.openSharedInEditor("release-checklist-3f9a1c");
      expect(transport.opened.at(-1)?.path).toBe(
         "/Users/me/.harness/shared/release-checklist-3f9a1c/content.md",
      );
   });

   it("lists fixtures newest first and searches title before text", async () => {
      const client = new HarnessClient(new MockTransport([], []));
      const all = await client.listSharedArtifacts();
      expect(all.map((e) => e.meta.kind)).toEqual(["md", "html", "ui"]);
      const found = await client.listSharedArtifacts("release");
      expect(found[0]!.meta.title).toBe("Release checklist");
      const text = await client.listSharedArtifacts("changelog");
      expect(text.map((e) => e.meta.id)).toEqual(["release-checklist-3f9a1c"]);
      expect(text[0]!.snippet).toContain("changelog");
   });

   it("shares a file panel: the item shows shared:<id> and the Session is attached", async () => {
      const transport = new MockTransport(
         [
            ui("c1", {
               id: "progress",
               placement: "right",
               title: "Progress",
               source: "progress.md",
            }),
         ],
         [],
      );
      const client = new HarnessClient(transport);
      const app: AppEvent[] = [];
      await client.subscribeApp((e) => app.push(e));
      // mock-1 replays the fixture: the item is in its log.
      const fresh = createSessionApi(transport, "mock-1");
      const meta = await fresh.shareArtifact("progress");
      expect(meta.kind).toBe("md");
      expect(meta.attached).toEqual(["mock-1"]);
      const read = await fresh.readShared(meta.id);
      expect(read.content).toContain("Upgrade progress");
      const events: Event[] = [];
      await fresh.subscribe((e) => events.push(e));
      const tail = events.slice(-2).map((e) => e.kind);
      expect(tail[0]).toMatchObject({
         type: "FrontendToolOutput",
         input: { id: "progress", source: `shared:${meta.id}` },
      });
      expect(tail[1]).toEqual({ type: "ArtifactAttached", id: meta.id, by: "user" });
      expect(app.some((e) => e.type === "SharedArtifactsChanged")).toBe(true);
      await expect(fresh.shareArtifact("progress")).rejects.toThrow();
   });

   it("attaches, patches state (logged once) and detaches", async () => {
      const transport = new MockTransport([], []);
      const client = new HarnessClient(transport);
      const sid = await client.createSession({
         folder: "/tmp/x",
         agentId: "a",
         frontendId: "chat",
      });
      const api = createSessionApi(transport, sid);
      const events: Event[] = [];
      await api.subscribe((e) => events.push(e));
      const changed: string[] = [];
      await api.sharedChanged((id) => changed.push(id));
      const meta = await api.attachShared("architecture-map-a1b2c3");
      expect(meta.attached).toEqual([sid]);
      await api.patchArtifactState("architecture-map-a1b2c3", [
         { op: "replace", path: "/reviewed", value: true },
      ]);
      expect((await api.readShared("architecture-map-a1b2c3")).state).toEqual({ reviewed: true });
      expect(changed).toEqual(["architecture-map-a1b2c3"]);
      await api.detachShared("architecture-map-a1b2c3");
      expect(events.slice(2).map((e) => e.kind.type)).toEqual([
         "ArtifactAttached",
         "ArtifactStateChanged",
         "ArtifactDetached",
      ]);
      expect(events.slice(2).every((e) => e.thread_id === null)).toBe(true);
      const md = await api.shareMarkdown("| A |\n| --- |\n| 1 |\n", "Runs", "r1:table:0");
      expect([md.title, md.kind, md.created_by.origin]).toEqual(["Runs", "md", "r1:table:0"]);
      await client.deleteSharedArtifact(md.id);
      await expect(client.readSharedArtifact(md.id)).rejects.toThrow();
   });
});

describe("MockTransport Commands without a canned reply", () => {
   it("accepts Cancel, WarmUp and ReportFrontendError; the error is logged once", async () => {
      const transport = new MockTransport([], []);
      const sid = await new HarnessClient(transport).createSession({
         folder: "/tmp/x",
         agentId: "codex",
         frontendId: "chat",
      });
      const got: Event[] = [];
      await transport.subscribe(sid, 0, (e) => got.push(e));
      const ok = { type: "Ok" };
      await expect(
         transport.execute({ type: "Cancel", session_id: sid, thread_id: null }),
      ).resolves.toEqual(ok);
      await expect(transport.execute({ type: "WarmUp", session_id: sid })).resolves.toEqual(ok);
      const report = {
         type: "ReportFrontendError",
         session_id: sid,
         tool: "render_ui",
         item: "card",
         message: "boom",
      } as const;
      await expect(transport.execute(report)).resolves.toEqual(ok);
      await expect(transport.execute(report)).resolves.toEqual(ok);
      expect(got.filter((e) => e.kind.type === "FrontendError")).toHaveLength(1);
   });
});

describe("MockTransport like the core", () => {
   const first = async (transport: MockTransport, sid: string) => {
      const log: Event[] = [];
      await transport.subscribe(sid, 0, (e) => log.push(e));
      return log;
   };

   it("starts every created and sample Session with SessionCreated and its Main Thread", async () => {
      const transport = new MockTransport([], []);
      const client = new HarnessClient(transport);
      const created = await client.createSession({
         folder: "/tmp/x",
         agentId: "codex",
         frontendId: "chat",
      });
      const quick = await client.createQuickSession({ agentId: "codex", frontendId: "chat" });
      for (const sid of [created, quick, "mock-s2", "mock-q1", "mock-p1-a"]) {
         const log = await first(transport, sid);
         expect(log.slice(0, 2).map((e) => e.kind.type)).toEqual([
            "SessionCreated",
            "ThreadStarted",
         ]);
         expect(log[0]!.thread_id).toBeNull();
         expect(log[1]!.kind).toMatchObject({ main: true });
         expect(log[1]!.thread_id).toBeTruthy();
         expect(log.filter((e) => e.kind.type === "ThreadStarted" && e.kind.main)).toHaveLength(1);
      }
   });

   it("logs a Turn on the Main Thread and emits TurnFinished", async () => {
      vi.useFakeTimers();
      try {
         const transport = new MockTransport([], []);
         const client = new HarnessClient(transport);
         const sid = await client.createSession({
            folder: "/tmp/x",
            agentId: "codex",
            frontendId: "chat",
            title: "T",
         });
         const log = await first(transport, sid);
         const app: AppEvent[] = [];
         await transport.subscribeApp((e) => app.push(e));
         await client.sessionApi(sid).prompt("hello");
         vi.runAllTimers();
         const main = log[1]!.thread_id;
         expect(log[1]!.kind).toMatchObject({ type: "ThreadStarted", main: true });
         const turn = log.filter(
            (e) => e.kind.type === "TurnStarted" || e.kind.type === "TurnEnded",
         );
         expect(turn.map((e) => e.thread_id)).toEqual([main, main]);
         expect(app.filter((e) => e.type === "TurnFinished")).toEqual([
            {
               type: "TurnFinished",
               session_id: sid,
               thread_id: main,
               title: "T",
               stop_reason: "end_turn",
            },
         ]);
      } finally {
         vi.useRealTimers();
      }
   });

   it("opens a new Session's log like the core: SessionCreated, then the Main Thread", async () => {
      const transport = new MockTransport([], []);
      const client = new HarnessClient(transport);
      const sid = await client.createSession({
         folder: "/tmp/x",
         agentId: "codex",
         frontendId: "chat",
         title: "T",
      });
      const log = await first(transport, sid);
      expect(log).toHaveLength(2);
      expect(log.map((e) => e.seq)).toEqual([0, 1]);
      expect(log[0]).toMatchObject({
         thread_id: null,
         kind: {
            type: "SessionCreated",
            title: "T",
            frontend_id: "chat",
            agent_id: "codex",
            folder: "/tmp/x",
         },
      });
      expect(log[1]).toMatchObject({
         kind: { type: "ThreadStarted", agent_id: "codex", main: true },
      });
   });

   it("a Turn: working after TurnStarted, idle before TurnEnded, then TurnFinished", async () => {
      vi.useFakeTimers();
      try {
         const transport = new MockTransport([], []);
         const client = new HarnessClient(transport);
         const sid = await client.createSession({
            folder: "/tmp/x",
            agentId: "codex",
            frontendId: "chat",
         });
         const log = await first(transport, sid);
         const order: string[] = [];
         await transport.subscribe(sid, log.length, (e) => order.push(e.kind.type));
         await transport.subscribeApp((e) => {
            if (e.type === "TurnFinished" || e.type === "SessionStatus")
               order.push(`app:${e.type}`);
         });
         await client.sessionApi(sid).prompt("hello");
         vi.runAllTimers();
         const keep = order.filter((t) => t !== "AgentMessageChunk" && t !== "WorkspaceChanged");
         expect(keep).toEqual([
            "TurnStarted",
            "SessionStatusChanged",
            "app:SessionStatus",
            "SessionStatusChanged",
            "app:SessionStatus",
            "TurnEnded",
            "app:TurnFinished",
            // `unseen` set: a Main Thread Turn ended.
            "app:SessionStatus",
         ]);
         const status = log.filter((e) => e.kind.type === "SessionStatusChanged");
         expect(status.map((e) => (e.kind as { status: string }).status)).toEqual([
            "working",
            "idle",
         ]);
         expect(status.every((e) => e.thread_id === null)).toBe(true);
      } finally {
         vi.useRealTimers();
      }
   });

   it("a Side Thread's Turn ends with TurnFinished for that Thread", async () => {
      vi.useFakeTimers();
      try {
         const transport = new MockTransport([], []);
         const client = new HarnessClient(transport);
         const sid = await client.createSession({
            folder: "/tmp/x",
            agentId: "codex",
            frontendId: "chat",
         });
         const side = await client.sessionApi(sid).startSideThread({ source: "fresh" });
         const app: AppEvent[] = [];
         await transport.subscribeApp((e) => app.push(e));
         await client.sessionApi(sid).prompt("hi", [], side.thread_id);
         vi.runAllTimers();
         expect(app.filter((e) => e.type === "TurnFinished")).toMatchObject([
            { session_id: sid, thread_id: side.thread_id },
         ]);
      } finally {
         vi.useRealTimers();
      }
   });

   it("archiving a parent archives its Sub Sessions first; unarchiving restores them", async () => {
      const transport = new MockTransport([], []);
      const client = new HarnessClient(transport);
      const archived = async () =>
         Object.fromEntries(
            (await client.listSessions())
               .filter((s) => s.id.startsWith("mock-p1"))
               .map((s) => [s.id, s.archived]),
         );
      const logs = await Promise.all(
         ["mock-p1", "mock-p1-a", "mock-p1-b"].map((id) => first(transport, id)),
      );
      await client.archiveSession("mock-p1");
      expect(await archived()).toEqual({ "mock-p1": true, "mock-p1-a": true, "mock-p1-b": true });
      for (const log of logs)
         expect(log.at(-1)!.kind).toEqual({ type: "SessionArchived", archived: true });
      // Archiving a child alone leaves its parent; a second archive of the parent is a conflict.
      await expect(client.archiveSession("mock-p1")).rejects.toMatchObject({ code: "conflict" });
      await client.unarchiveSession("mock-p1");
      expect(await archived()).toEqual({
         "mock-p1": false,
         "mock-p1-a": false,
         "mock-p1-b": false,
      });
      await expect(client.unarchiveSession("mock-p1")).rejects.toMatchObject({ code: "conflict" });
   });

   it("prompting an archived Session is a conflict", async () => {
      const transport = new MockTransport([], []);
      const client = new HarnessClient(transport);
      const sid = await client.createSession({
         folder: "/tmp/x",
         agentId: "codex",
         frontendId: "chat",
      });
      await client.archiveSession(sid);
      await expect(client.sessionApi(sid).prompt("hi")).rejects.toMatchObject({
         code: "conflict",
      });
   });

   it("coded errors reach expectResult with the core's codes", async () => {
      const transport = new MockTransport([], []);
      const client = new HarnessClient(transport);
      const sid = await client.createSession({
         folder: "/tmp/x",
         agentId: "codex",
         frontendId: "chat",
      });
      const code = (cmd: Command) =>
         expectResult(transport, cmd, "Ok").then(
            () => null,
            (e: unknown) => (e instanceof CommandError ? e.code : "plain"),
         );
      expect(await code({ type: "Prompt", session_id: "nope", thread_id: null, text: "x" })).toBe(
         "not_found",
      );
      expect(
         await code({ type: "Prompt", session_id: sid, text: "x", thread_id: "no-such-thread" }),
      ).toBe("not_found");
      expect(
         await code({
            type: "ResolvePermission",
            session_id: sid,
            request_id: "nope",
            option_id: null,
            global: false,
         }),
      ).toBe("not_found");
      expect(await code({ type: "PanelSourceRead", session_id: sid, name: "nope.md" })).toBe(
         "not_found",
      );
      expect(
         await code({ type: "ShareMarkdown", session_id: sid, markdown: " ", title: "t" }),
      ).toBe("invalid");
      expect(
         await code({
            type: "PatchArtifactState",
            id: "x",
            ops: [],
            session_id: sid,
         }),
      ).toBe("not_found");
      // An uncoded core error stays `internal`.
      expect(
         await code({
            type: "ReadSessionFile",
            session_id: sid,
            path: "no/such/file.txt",
         } as Command),
      ).toBe("internal");
   });

   it("fails with the core's codes", async () => {
      const transport = new MockTransport([], []);
      const client = new HarnessClient(transport);
      const failure = (p: Promise<unknown>) =>
         p.then(
            () => null,
            (e: unknown) => e,
         );
      expect(await failure(client.archiveSession("nope"))).toMatchObject({ code: "not_found" });
      expect(await failure(client.deleteSession("mock-s1"))).toMatchObject({ code: "conflict" });
      expect(await failure(client.rollbackAgent("nope"))).toMatchObject({ code: "not_found" });
      expect(await failure(client.holdAgentVersion("nope", true))).toMatchObject({
         code: "not_found",
      });
      expect(await failure(client.installAgent("not-listed"))).toMatchObject({ code: "not_found" });
      expect(await failure(client.installAgent("windows-only"))).toMatchObject({
         code: "agent_unavailable",
      });
   });
});

describe("MockTransport unused Quick Sessions", () => {
   const mk = () => {
      const main: Event = {
         v: 1,
         seq: 0,
         session_id: "x",
         thread_id: "main",
         ts_ms: 0,
         kind: { type: "ThreadStarted", agent_id: "codex", main: true },
      };
      const transport = new MockTransport([main], []);
      const client = new HarnessClient(transport);
      const sessions: AppEvent[] = [];
      void client.subscribeApp((e) => sessions.push(e));
      return { transport, client, events: sessions };
   };
   it("a Quick Session starts unused and any Thread's first prompt uses it", async () => {
      const { client, events } = mk();
      const id = await client.createQuickSession({ agentId: "codex", frontendId: "chat" });
      const unused = async () => (await client.listSessions()).find((s) => s.id === id)!.unused;
      expect(await unused()).toBe(true);
      const side = await client.sessionApi(id).startSideThread({ source: "fresh" });
      await client.sessionApi(id).prompt("hi", [], side.thread_id);
      expect(await unused()).toBe(false);
      // A Side Thread prompt does not replace the placeholder title.
      expect(events.find((e) => e.type === "SessionStatus")).toMatchObject({ unused: false });
      expect((await client.listSessions()).find((s) => s.id === id)!.title).toBe(
         "New Quick Session",
      );
   });
   it("discarding an unknown Session is a no-op", async () => {
      const { client } = mk();
      await expect(client.discardEmptySession("nope")).resolves.toBeUndefined();
   });
});

describe("MockTransport Review Comments", () => {
   it("follows the core's lifecycle: pending, sent by a prompt, immutable, resolved", async () => {
      const transport = new MockTransport([], []);
      const client = new HarnessClient(transport);
      const id = await client.createSession({
         folder: "/tmp/x",
         agentId: "codex",
         frontendId: "chat",
      });
      const api = createSessionApi(transport, id);
      const log: Event[] = [];
      await api.subscribe((e) => log.push(e));
      const c = await api.addComment({ path: "a.ts", line: 2, side: "new", code: "x", text: "t" });
      expect(c.id).toBe("c1");
      await api.editComment(c.id, "t2");
      await expect(api.resolveComment(c.id)).rejects.toBeInstanceOf(CommandError);
      await api.prompt("go", [], null, [c.id]);
      await expect(api.editComment(c.id, "t3")).rejects.toBeInstanceOf(CommandError);
      await expect(api.deleteComment(c.id)).rejects.toBeInstanceOf(CommandError);
      await api.resolveComment(c.id);
      const kinds = log.map((e) => e.kind.type).filter((t) => t.startsWith("Comment"));
      expect(kinds).toEqual(["CommentAdded", "CommentEdited", "CommentsSent", "CommentResolved"]);
      expect(
         (await api.addComment({ path: "a.ts", line: 1, side: null, code: "y", text: "u" })).id,
      ).toBe("c2");
   });
});
