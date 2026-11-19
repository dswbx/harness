import { beforeEach, describe, expect, it, vi } from "vitest";
import { forgetSession, onSessionForgotten } from "./forgetSession";
import { codec, onStorageFailure, type StorageFailure, storedNumber, storedValue } from "./storage";
import { matchKey, STORAGE_KEYS } from "./storageKeys";

class MemStorage {
   m = new Map<string, string>();
   get length() {
      return this.m.size;
   }
   key = (i: number) => [...this.m.keys()][i] ?? null;
   getItem = (k: string) => this.m.get(k) ?? null;
   setItem = (k: string, v: string) => void this.m.set(k, v);
   removeItem = (k: string) => void this.m.delete(k);
}

const win = new EventTarget();
let mem: MemStorage;
beforeEach(() => {
   vi.stubGlobal("window", win);
   mem = new MemStorage();
   vi.stubGlobal("localStorage", mem);
   vi.spyOn(console, "warn").mockImplementation(() => {});
});

const remote = (key: string | null) =>
   win.dispatchEvent(Object.assign(new Event("storage"), { key }));

const num = (key: string, extra = {}) =>
   storedValue<number>({ key, scope: "app", parse: codec.number(7), serialize: String, ...extra });

describe("storedValue", () => {
   it("reads the default for missing, bad and invalid data", () => {
      const s = num("harness:diff-split");
      expect(s.get()).toBe(7);
      mem.setItem("harness:diff-split", "abc");
      expect(s.get()).toBe(7);
      const j = storedValue<string[]>({
         key: "harness.sessionList.collapsed",
         scope: "app",
         parse: codec.json((v): v is string[] => Array.isArray(v), []),
      });
      mem.setItem("harness.sessionList.collapsed", "{nope");
      expect(j.get()).toEqual([]);
      mem.setItem("harness.sessionList.collapsed", '{"a":1}');
      expect(j.get()).toEqual([]);
      mem.setItem("harness.sessionList.collapsed", '["a"]');
      expect(j.get()).toEqual(["a"]);
   });

   it("a parser that throws reads as unset", () => {
      const s = storedValue<number>({
         key: "harness:diff-split",
         scope: "app",
         parse: (raw) => {
            if (raw !== null) throw new Error("bad");
            return 1;
         },
      });
      mem.setItem("harness:diff-split", "x");
      expect(s.get()).toBe(1);
   });

   it("keeps the same object for the same text", () => {
      const s = storedValue<{ a: number }>({
         key: "harness.recentFolders",
         scope: "app",
         parse: (raw) => JSON.parse(raw ?? '{"a":1}'),
      });
      expect(s.get()).toBe(s.get());
      s.set({ a: 2 });
      expect(s.get()).toEqual({ a: 2 });
      expect(s.get()).toBe(s.get());
   });

   it("keeps the existing text formats", () => {
      const n = num("harness:diff-split");
      n.set(0.5);
      expect(mem.getItem("harness:diff-split")).toBe("0.5");
      const t = storedValue<boolean>({
         key: "harness.terminal.optionIsMeta",
         scope: "app",
         parse: codec.onOff(false),
         serialize: (v) => (v ? "on" : "off"),
      });
      t.set(true);
      expect(mem.getItem("harness.terminal.optionIsMeta")).toBe("on");
      expect(t.get()).toBe(true);
   });

   it("a version wraps the value; another version reads as unset", () => {
      const mk = (version: number) =>
         storedValue<number>({
            key: "harness.sidebarWidth",
            scope: "app",
            parse: codec.number(0),
            serialize: String,
            version,
         });
      mk(1).set(5);
      expect(JSON.parse(mem.getItem("harness.sidebarWidth")!)).toEqual({ v: 1, d: "5" });
      expect(mk(1).get()).toBe(5);
      expect(mk(2).get()).toBe(0);
      mem.setItem("harness.sidebarWidth", "5");
      expect(mk(1).get()).toBe(0);
      mem.setItem("harness.sidebarWidth", "{bad");
      expect(mk(1).get()).toBe(0);
   });

   it("reports a failed write (quota) to the caller and once to the host", () => {
      const quota = Object.assign(new Error("full"), { name: "QuotaExceededError" });
      mem.setItem = () => {
         throw quota;
      };
      const seen: StorageFailure[] = [];
      const off = onStorageFailure((f) => seen.push(f));
      const s = storedValue<string>({
         key: "harness.draft.s1",
         scope: { session: "s1" },
         parse: (r) => r ?? "",
         serialize: (v) => v,
      });
      expect(s.set("a")).toBe(false);
      expect(s.set("b")).toBe(false);
      expect(seen).toEqual([{ key: "harness.draft.s1", quota: true, error: quota }]);
      expect(console.warn).toHaveBeenCalledTimes(1);
      // A later success re-arms the report.
      mem.setItem = (k, v) => void mem.m.set(k, v);
      expect(s.set("c")).toBe(true);
      mem.setItem = () => {
         throw quota;
      };
      s.set("d");
      // One report per window, not per key or streak.
      expect(seen).toHaveLength(1);
      off();
   });

   it("blocked storage: reads default, writes fail without throwing", () => {
      vi.stubGlobal("localStorage", undefined);
      const s = num("harness:diff-split");
      expect(s.get()).toBe(7);
      expect(s.set(1)).toBe(false);
      expect(s.remove()).toBe(true);
   });

   it("does not try to write when storage is not readable", () => {
      const setItem = vi.fn();
      vi.stubGlobal("localStorage", {
         getItem: () => {
            throw new Error("blocked");
         },
         setItem,
         removeItem: setItem,
      });
      const s = num("harness:diff-split");
      expect(s.set(1)).toBe(false);
      expect(s.remove()).toBe(true);
      expect(setItem).not.toHaveBeenCalled();
   });

   it("notifies this window on set and remove", () => {
      const s = num("harness:diff-split", { sync: false });
      const l = vi.fn();
      const off = s.subscribe(l);
      s.set(1);
      s.remove();
      expect(l).toHaveBeenCalledTimes(2);
      off();
   });

   it("follows the storage event of its own key; not of others; not with sync: false", () => {
      const synced = num("harness:diff-split");
      const own = num("harness:diff-wrap");
      const l1 = vi.fn();
      const l2 = vi.fn();
      const offs = [synced.subscribe(l1), storedNumber("harness:diff-wrap").subscribe(l2)];
      remote("harness:diff-split");
      expect(l1).toHaveBeenCalledTimes(1);
      expect(l2).toHaveBeenCalledTimes(0);
      remote(null);
      expect(l1).toHaveBeenCalledTimes(2);
      expect(l2).toHaveBeenCalledTimes(0);
      void own;
      for (const o of offs) o();
   });

   it("refuses a key that is not in the registry or has the wrong scope", () => {
      expect(() => num("harness.nope")).toThrow(/STORAGE_KEYS/);
      expect(() => storedValue({ key: "harness.files.s1", scope: "app", parse: (r) => r })).toThrow(
         /declared session/,
      );
      expect(() =>
         storedValue({ key: "harness.files.s1", scope: { session: "s2" }, parse: (r) => r }),
      ).toThrow(/does not belong/);
      expect(() =>
         storedValue({ key: "harness.sidebarOpen", scope: { session: "s1" }, parse: (r) => r }),
      ).toThrow(/declared app/);
   });
});

describe("registry", () => {
   // A rename or new key shows up here in review: users have data under these.
   it("pins the known keys", () => {
      expect(STORAGE_KEYS.map((k) => `${k.scope} ${k.pattern}`)).toEqual([
         "app harness.appearance",
         "app harness.themes",
         "app harness.sidebarOpen",
         "app harness.sidebarWidth",
         "app harness.recentFolders",
         "app harness.composer.worktree",
         "app harness.overlay.agent",
         "app harness.sessionList.sort",
         "app harness.sessionList.display",
         "app harness.sessionList.group",
         "app harness.sessionList.collapsed",
         "app harness.sessionList.folderOrder",
         "app harness.sharedArtifacts.seen",
         "app harness.sharedArtifacts.collapsed",
         "app harness.terminal.optionIsMeta",
         "app harness.chat.references.list.pr",
         "app harness.chat.references.list.code",
         "app harness.chat.references.list.link",
         "app harness.chat.guessInlineCode",
         "app harness.chat.wrapCode",
         "app harness.chat.toolDisplay",
         "app harness:shared-artifact-side-width",
         "app harness:diff-split",
         "app harness:diff-file-view",
         "app harness:diff-wrap",
         "app harness:diff-sidebar-width",
         "app harness:commits-pane-height",
         "app harness:files-tree-width",
         "app harness.tasks.view",
         "app harness:tasks-preview-width",
         "app harness.tasks.tree",
         "app harness:tasks-note-height",
         "app harness.tasks.panelDensity",
         "app harness:window-frame:{name}",
         "session harness.chat.layout.{session}",
         "session harness.chat.sideThreads.{session}",
         "session harness.chat.panel.{session}",
         "session harness.files.{session}",
         "session harness.changes.seen.{session}",
         "session harness.review-comments.{session}",
         "session harness.review-comments.{session}#{thread}",
         "session harness.draft.{session}",
         "session harness.draft.{session}#{thread}",
      ]);
   });

   it("every entry has an owner and patterns are unique", () => {
      expect(new Set(STORAGE_KEYS.map((k) => k.pattern)).size).toBe(STORAGE_KEYS.length);
      for (const k of STORAGE_KEYS) expect(k.owner, k.pattern).not.toBe("");
   });

   it("matches concrete keys to their entry and Session", () => {
      expect(matchKey("harness.chat.layout.s1")?.session).toBe("s1");
      expect(matchKey("harness.draft.s1#t9")).toMatchObject({ session: "s1" });
      expect(matchKey("harness.draft.s1")?.def.pattern).toBe("harness.draft.{session}");
      expect(matchKey("harness:window-frame:diff-s1")?.session).toBeNull();
      expect(matchKey("harness.unknown")).toBeNull();
   });
});

describe("forgetSession", () => {
   it("tells modules that cache per-Session stores", () => {
      const l = vi.fn();
      const off = onSessionForgotten(l);
      forgetSession("s1");
      expect(l).toHaveBeenCalledWith("s1");
      off();
   });

   it("removes exactly the Session's keys", () => {
      const mine = [
         "harness.chat.layout.s1",
         "harness.chat.sideThreads.s1",
         "harness.chat.panel.s1",
         "harness.files.s1",
         "harness.review-comments.s1",
         "harness.review-comments.s1#t1",
         "harness.draft.s1",
         "harness.draft.s1#t1",
         "harness.draft.s1#t2",
      ];
      const others = [
         "harness.chat.layout.s10",
         "harness.chat.layout.s2",
         "harness.draft.s10",
         "harness.review-comments.s10#s1",
         "harness.draft.s2#s1",
         "harness.sidebarOpen",
         "harness:window-frame:s1",
         "something.else.s1",
      ];
      for (const k of [...mine, ...others]) mem.setItem(k, "x");
      const l = vi.fn();
      const off = storedValue<string>({
         key: "harness.draft.s1",
         scope: { session: "s1" },
         parse: (r) => r ?? "",
      }).subscribe(l);
      expect(forgetSession("s1").sort()).toEqual([...mine].sort());
      expect([...mem.m.keys()].sort()).toEqual([...others].sort());
      expect(l).toHaveBeenCalled();
      off();
   });
});
