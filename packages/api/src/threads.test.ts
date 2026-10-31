import { describe, expect, it } from "vitest";
import type { Event, EventKind } from "./generated";
import { threadsOf } from "./threads";

let seq = 0;
const ev = (thread_id: string | null, kind: EventKind): Event => ({ v: 1, seq: seq++, session_id: "s", thread_id, ts_ms: 0, kind });

describe("threadsOf", () => {
  it("lists Main first, then Side Threads with titles, writable and Turn counts", () => {
    const list = threadsOf([
      ev("m", { type: "ThreadStarted", agent_id: "a", main: true }),
      ev("m", { type: "TurnStarted", turn_id: "t1", text: "hello" }),
      ev("s1", { type: "ThreadStarted", agent_id: "a", main: false, forked_from: { thread_id: "m", turn: 1, seq: 3 } }),
      ev("s2", { type: "ThreadStarted", agent_id: "a", main: false }),
      ev("s2", { type: "TurnStarted", turn_id: "t2", text: "x".repeat(100) }),
      ev("s2", { type: "ThreadWritableChanged", writable: true }),
      ev("m", { type: "TurnStarted", turn_id: "t3", text: "again" }),
      ev(null, { type: "SessionInfoUpdated", title: "T" }),
    ]);
    expect(list.map((t) => t.id)).toEqual(["m", "s1", "s2"]);
    expect(list[0]).toMatchObject({ main: true, title: "hello", turns: 2, writable: true });
    expect(list[1]).toMatchObject({ main: false, title: null, turns: 0, writable: false, forkedFrom: { turn: 1 } });
    expect(list[2]!.title).toHaveLength(48);
    expect(list[2]).toMatchObject({ writable: true, turns: 1 });
  });
});
