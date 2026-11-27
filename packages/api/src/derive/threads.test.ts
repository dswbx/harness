import { describe, expect, it } from "vitest";
import type { Event, EventKind } from "../generated";
import { stepThreads, threadsOf } from "./threads";

let seq = 0;
const ev = (thread_id: string | null, kind: EventKind): Event => ({
   v: 1,
   seq: seq++,
   session_id: "s",
   thread_id,
   ts_ms: 0,
   kind,
});

describe("threadsOf", () => {
   it("lists Main first, then Side Threads with titles and Turn counts", () => {
      const list = threadsOf([
         ev("m", { type: "ThreadStarted", agent_id: "a", main: true }),
         ev("m", { type: "TurnStarted", turn_id: "t1", text: "hello" }),
         ev("s1", {
            type: "ThreadStarted",
            agent_id: "a",
            main: false,
            forked_from: { thread_id: "m", turn: 1, seq: 3 },
         }),
         ev("s2", { type: "ThreadStarted", agent_id: "a", main: false }),
         ev("s2", { type: "TurnStarted", turn_id: "t2", text: "x".repeat(100) }),
         ev("m", { type: "TurnStarted", turn_id: "t3", text: "again" }),
      ]);
      expect(list.map((t) => t.id)).toEqual(["m", "s1", "s2"]);
      expect(list[0]).toMatchObject({ main: true, title: "hello", turns: 2 });
      expect(list[1]).toMatchObject({
         main: false,
         title: null,
         turns: 0,
         forkedFrom: { turn: 1 },
      });
      expect(list[2]!.title).toHaveLength(48);
      expect(list[2]).toMatchObject({ turns: 1 });
   });

   it("takes the Agent's title, not a fork's copy of the Main Thread's", () => {
      const list = threadsOf([
         ev("m", { type: "ThreadStarted", agent_id: "a", main: true }),
         ev("m", { type: "TurnStarted", turn_id: "t1", text: "hello" }),
         ev(null, { type: "SessionInfoUpdated", title: "Main title" }),
         ev("s1", {
            type: "ThreadStarted",
            agent_id: "a",
            main: false,
            forked_from: { thread_id: "m", turn: 1, seq: 3 },
         }),
         ev("s1", { type: "TurnStarted", turn_id: "t2", text: "why this format?" }),
         ev("s1", { type: "SessionInfoUpdated", title: "Main title" }),
      ]);
      expect(list[0]).toMatchObject({ title: "Main title", agentTitle: "Main title" });
      expect(list[1]).toMatchObject({ title: "why this format?", agentTitle: null });
      const later = threadsOf([
         ev("s1", { type: "ThreadStarted", agent_id: "a", main: false }),
         ev("s1", { type: "TurnStarted", turn_id: "t2", text: "why this format?" }),
         ev("s1", { type: "SessionInfoUpdated", title: "  Migration\nformat " }),
         ev("s1", { type: "TurnStarted", turn_id: "t3", text: "next" }),
         ev("x", { type: "SessionInfoUpdated", title: "Unknown" }),
      ]);
      expect(later).toHaveLength(1);
      expect(later[0]).toMatchObject({ title: "Migration format", turns: 2 });
   });
});

describe("Inline Threads", () => {
   const anchor = { thread_id: "m", seq: 4, quote: "q", prefix: "p ", suffix: " s" };

   it("carries the anchor, and folds resolve and reopen", () => {
      const events = [
         ev("m", { type: "ThreadStarted", agent_id: "a", main: true }),
         ev("s1", { type: "ThreadStarted", agent_id: "a", main: false, anchor }),
         ev("s2", { type: "ThreadStarted", agent_id: "a", main: false }),
         ev("s1", { type: "SideThreadResolved", resolved: true }),
      ];
      const list = threadsOf(events);
      expect(list[0]).toMatchObject({ anchor: null, resolved: false });
      expect(list[1]).toMatchObject({ anchor, resolved: true });
      expect(list[2]).toMatchObject({ anchor: null, resolved: false });
      const reopened = threadsOf([
         ...events,
         ev("s1", { type: "SideThreadResolved", resolved: false }),
      ]);
      expect(reopened[1]).toMatchObject({ anchor, resolved: false });
   });

   it("ignores a resolve that changes nothing, or of an unknown or Main Thread", () => {
      const list = threadsOf([
         ev("m", { type: "ThreadStarted", agent_id: "a", main: true }),
         ev("s1", { type: "ThreadStarted", agent_id: "a", main: false, anchor }),
      ]);
      for (const e of [
         ev("s1", { type: "SideThreadResolved", resolved: false }),
         ev("m", { type: "SideThreadResolved", resolved: true }),
         ev("x", { type: "SideThreadResolved", resolved: true }),
         ev(null, { type: "SideThreadResolved", resolved: true }),
      ])
         expect(stepThreads(list, e)).toBe(list);
   });
});

describe("lastAt", () => {
   it("is the time of the Thread's start or newest Turn", () => {
      const at = (ts_ms: number, e: Event) => ({ ...e, ts_ms });
      const list = threadsOf([
         at(5, ev("s", { type: "ThreadStarted", agent_id: "a", main: false })),
         at(9, ev("s", { type: "TurnStarted", turn_id: "t", text: "q" })),
         at(12, ev("s", { type: "SessionInfoUpdated", title: "T" })),
      ]);
      expect(list[0]!.lastAt).toBe(9);
   });
});
