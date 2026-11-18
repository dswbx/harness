import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
   activeThreadId,
   closeThread,
   loadThreadTabs,
   moveThread,
   NO_TABS,
   newThreadTabId,
   openThread,
   openThreadIds,
   replaceThread,
   saveThreadTabs,
   selectThread,
   type ThreadTabs,
   threadStarted,
} from "./threadTabs";

const mem = new Map<string, string>();
const useMemoryStorage = () => {
   beforeEach(() => {
      mem.clear();
      vi.stubGlobal("localStorage", {
         getItem: (k: string) => mem.get(k) ?? null,
         setItem: (k: string, v: string) => void mem.set(k, String(v)),
         removeItem: (k: string) => void mem.delete(k),
         clear: () => mem.clear(),
      });
   });
   afterEach(() => vi.unstubAllGlobals());
};

const tabs = (threads: string[], thread: string | null): ThreadTabs => ({ threads, thread });

describe("Side Thread tabs", () => {
   test("open tabs: drafts and Threads that arrived", () => {
      expect(openThreadIds(["draft:1", "t1", "t2"], { t1: {} })).toEqual(["draft:1", "t1"]);
   });
   test("active: the selected one if open, else the last", () => {
      expect(activeThreadId("t1", ["t1", "t2"])).toBe("t1");
      expect(activeThreadId("gone", ["t1", "t2"])).toBe("t2");
      expect(activeThreadId(null, ["t1"])).toBe("t1");
      expect(activeThreadId(null, [])).toBeNull();
   });
   test("new tab reuses an open draft", () => {
      expect(newThreadTabId(tabs(["t1", "draft:a"], null), () => "zz")).toBe("draft:a");
      expect(newThreadTabId(tabs(["t1"], null), () => "zz")).toBe("draft:zz");
   });
   test("a started Thread replaces its draft tab in place and keeps it active", () => {
      const l = threadStarted(tabs(["t1", "draft:a", "t2"], "draft:a"), "draft:a", "t9");
      expect(l.threads).toEqual(["t1", "t9", "t2"]);
      expect(l.thread).toBe("t9");
   });
   test("a started Thread replaces an inactive draft without taking the focus", () => {
      const l = threadStarted(tabs(["draft:a", "t2"], "t2"), "draft:a", "t9");
      expect(l.threads).toEqual(["t9", "t2"]);
      expect(l.thread).toBe("t2");
   });
   test("without a draft, or when its tab closed meanwhile, a new tab opens active", () => {
      for (const draft of [undefined, "draft:gone"]) {
         const l = threadStarted(tabs(["t1"], "t1"), draft, "t9");
         expect(l.threads).toEqual(["t1", "t9"]);
         expect(l.thread).toBe("t9");
      }
   });
   test("closing the active tab activates its left neighbour, else right", () => {
      let l = tabs(["a", "b", "c"], "b");
      l = closeThread(l, "b");
      expect(l.threads).toEqual(["a", "c"]);
      expect(l.thread).toBe("a");
      expect(closeThread(selectThread(l, "a"), "a").thread).toBe("c");
   });
   test("closing the last tab leaves none", () => {
      expect(closeThread(openThread(NO_TABS, "a"), "a")).toEqual(NO_TABS);
   });
   test("closing a background tab keeps the active one", () => {
      expect(closeThread(["a", "b"].reduce(openThread, NO_TABS), "a")).toEqual(tabs(["b"], "b"));
   });
   test("opening appends, activates and does not duplicate", () => {
      const s = openThread(openThread(NO_TABS, "a"), "b");
      expect(s).toEqual(tabs(["a", "b"], "b"));
      expect(openThread(s, "a")).toEqual(tabs(["a", "b"], "a"));
   });
   test("selecting only works for open tabs", () => {
      const s = tabs(["a", "b"], "b");
      expect(selectThread(s, "a").thread).toBe("a");
      expect(selectThread(s, "zzz")).toBe(s);
   });
   test("replacing a tab that is not open changes nothing", () => {
      const s = tabs(["a"], "a");
      expect(replaceThread(s, "x", "y")).toBe(s);
   });
});

describe("storage", () => {
   useMemoryStorage();
   const own = "harness.chat.sideThreads.s1";
   const layout = "harness.chat.layout.s1";

   test("round-trips under its own key, with a version", () => {
      saveThreadTabs("s1", tabs(["a", "b"], "a"));
      expect(JSON.parse(localStorage.getItem(own)!)).toEqual({
         v: 1,
         threads: ["a", "b"],
         thread: "a",
      });
      expect(loadThreadTabs("s1")).toEqual(tabs(["a", "b"], "a"));
   });
   test("without a key of its own, restores the tabs from the layout's value, leaving it as it is", () => {
      const old = JSON.stringify({ zones: {}, threads: ["a", "draft:x"], thread: "a" });
      localStorage.setItem(layout, old);
      expect(loadThreadTabs("s1")).toEqual(tabs(["a", "draft:x"], "a"));
      expect(localStorage.getItem(layout)).toBe(old);
      expect(localStorage.getItem(own)).toBeNull();
   });
   test("its own key wins over the layout's fields, even with no tabs", () => {
      localStorage.setItem(layout, JSON.stringify({ threads: ["a"], thread: "a" }));
      saveThreadTabs("s1", NO_TABS);
      expect(loadThreadTabs("s1")).toEqual(NO_TABS);
   });
   test("the oldest right-panel value is the last resort", () => {
      localStorage.setItem("harness.chat.panel.s1", JSON.stringify({ threads: ["a", "b"] }));
      expect(loadThreadTabs("s1")).toEqual(tabs(["a", "b"], "b"));
   });
   test("garbage gives no tabs; the active one falls back to the last", () => {
      localStorage.setItem(own, "{nope");
      expect(loadThreadTabs("s1")).toEqual(NO_TABS);
      localStorage.setItem(own, JSON.stringify({ v: 1, threads: ["a", 3, "b"], thread: "zzz" }));
      expect(loadThreadTabs("s1")).toEqual(tabs(["a", "b"], "b"));
   });
});

describe("moveThread", () => {
   const t: ThreadTabs = { threads: ["a", "b", "c"], thread: "b" };
   test("moves a tab in front of another, or to the end; keeps the active one", () => {
      expect(moveThread(t, "c", "a")).toEqual({ threads: ["c", "a", "b"], thread: "b" });
      expect(moveThread(t, "a", null)).toEqual({ threads: ["b", "c", "a"], thread: "b" });
   });
   test("returns the same tabs when nothing moves", () => {
      expect(moveThread(t, "a", "b")).toBe(t);
      expect(moveThread(t, "c", null)).toBe(t);
      expect(moveThread(t, "a", "a")).toBe(t);
      expect(moveThread(t, "x", "a")).toBe(t);
      expect(moveThread(t, "a", "x")).toBe(t);
   });
});

describe("replaceThread", () => {
   test("never lists a Thread twice", () => {
      const t: ThreadTabs = { threads: ["a", "draft:x"], thread: "draft:x" };
      expect(replaceThread(t, "draft:x", "a")).toEqual({ threads: ["a"], thread: "a" });
   });
});
