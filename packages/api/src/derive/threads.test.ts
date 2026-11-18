import { describe, expect, it } from "vitest";
import type { Event, EventKind } from "../generated";
import { threadsOf } from "./threads";

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
