import { describe, expect, it, vi } from "vitest";
import { storedValue } from "../platform/storage";
import { draftKey, draftStorageKey, parseDraftKey, sessionHasDraft } from "./drafts";

describe("draft keys (stored in localStorage: the format is pinned)", () => {
   it("Main Thread is the Session id, a Side Thread is sessionId#threadId", () => {
      expect(draftKey("s1", null)).toBe("s1");
      expect(draftKey("s1", "t9")).toBe("s1#t9");
      expect(draftStorageKey(draftKey("s1", "t9"))).toBe("harness.draft.s1#t9");
   });
   it("parses back", () => {
      expect(parseDraftKey("s1")).toEqual({ sessionId: "s1", threadId: null });
      expect(parseDraftKey("s1#t9")).toEqual({ sessionId: "s1", threadId: "t9" });
   });
});

describe("sessionHasDraft", () => {
   class Mem {
      m = new Map<string, string>();
      keyCalls = 0;
      get length() {
         this.keyCalls++;
         return this.m.size;
      }
      key = (i: number) => {
         this.keyCalls++;
         return [...this.m.keys()][i] ?? null;
      };
      getItem = (k: string) => this.m.get(k) ?? null;
      setItem = (k: string, v: string) => void this.m.set(k, v);
      removeItem = (k: string) => void this.m.delete(k);
   }
   const win = new EventTarget();

   it("scans once, then follows writes and the storage event", () => {
      const mem = new Mem();
      vi.stubGlobal("window", win);
      vi.stubGlobal("localStorage", mem);
      mem.setItem("harness.draft.s1#t1", "{}");
      mem.setItem("harness.draft.s2", "{}");
      mem.setItem("harness.other", "{}");
      expect(sessionHasDraft("s1")).toBe(true);
      expect(sessionHasDraft("s2")).toBe(true);
      expect(sessionHasDraft("s3")).toBe(false);
      const scanned = mem.keyCalls;
      expect(scanned).toBeGreaterThan(0);
      for (let i = 0; i < 50; i++) sessionHasDraft(`s${i}`);
      expect(mem.keyCalls).toBe(scanned);

      // A write through the helper keeps the index current.
      const draft = storedValue<string>({
         key: draftStorageKey("s3"),
         scope: { session: "s3" },
         parse: (r) => r ?? "",
         serialize: (v) => v,
      });
      draft.set("hi");
      expect(sessionHasDraft("s3")).toBe(true);
      draft.remove();
      expect(sessionHasDraft("s3")).toBe(false);

      // Another window writes: the storage event updates it.
      mem.setItem("harness.draft.s4#t", "{}");
      win.dispatchEvent(Object.assign(new Event("storage"), { key: "harness.draft.s4#t" }));
      expect(sessionHasDraft("s4")).toBe(true);
      mem.removeItem("harness.draft.s4#t");
      win.dispatchEvent(Object.assign(new Event("storage"), { key: "harness.draft.s4#t" }));
      expect(sessionHasDraft("s4")).toBe(false);
      expect(mem.keyCalls).toBe(scanned);

      // Cleared storage: rebuilt by one new scan.
      mem.m.clear();
      win.dispatchEvent(Object.assign(new Event("storage"), { key: null }));
      expect(sessionHasDraft("s1")).toBe(false);
   });

   it("a draft write keeps the exact key", () => {
      const mem = new Mem();
      vi.stubGlobal("localStorage", mem);
      storedValue<string>({
         key: draftStorageKey(draftKey("s1", "t9")),
         scope: { session: "s1" },
         parse: (r) => r ?? "",
         serialize: (v) => v,
      }).set("x");
      expect([...mem.m.keys()]).toEqual(["harness.draft.s1#t9"]);
   });
});
