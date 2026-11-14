import type { HarnessClient, SessionSummary } from "@harness/api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { forgetGone, withSubSessions } from "./forgetGone";

const s = (id: string, parent?: string) =>
   ({ id, parent: parent ? { session_id: parent } : null }) as unknown as SessionSummary;

describe("withSubSessions", () => {
   it("collects the Session and its Sub Sessions at any depth, not others", () => {
      const list = [s("a"), s("b", "a"), s("c", "b"), s("d"), s("e", "d")];
      expect(withSubSessions(list, "a")).toEqual(["a", "b", "c"]);
      expect(withSubSessions(list, "x")).toEqual(["x"]);
   });
});

describe("forgetGone", () => {
   const mem = new Map<string, string>();
   beforeEach(() => {
      mem.clear();
      vi.stubGlobal("localStorage", {
         get length() {
            return mem.size;
         },
         key: (i: number) => [...mem.keys()][i] ?? null,
         getItem: (k: string) => mem.get(k) ?? null,
         setItem: (k: string, v: string) => void mem.set(k, v),
         removeItem: (k: string) => void mem.delete(k),
      });
   });
   const client = (list: SessionSummary[] | Error) =>
      ({
         listSessions: () => (list instanceof Error ? Promise.reject(list) : Promise.resolve(list)),
      }) as unknown as HarnessClient;

   it("forgets only the ids the core no longer lists", async () => {
      for (const id of ["a", "b"]) mem.set(`harness.chat.layout.${id}`, "{}");
      await forgetGone(client([s("b")]), ["a", "b"]);
      expect([...mem.keys()]).toEqual(["harness.chat.layout.b"]);
   });
   it("keeps everything when the list cannot be read", async () => {
      mem.set("harness.chat.layout.a", "{}");
      await forgetGone(client(new Error("down")), ["a"]);
      expect(mem.size).toBe(1);
   });
});
