import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultLayout, expand, type Layout, move, resize, show } from "./model";
import { loadLayout, migratePanel, parseLayout, saveLayout } from "./persist";

/** A fixed arrangement, so these tests don't follow the defaults. */
const empty: Layout = {
   ...defaultLayout(),
   zones: {
      leftTop: ["changes"],
      leftBottom: ["artifacts", "references"],
      bottomLeft: ["terminal"],
      bottomRight: ["events"],
      rightBottom: ["files"],
      rightTop: ["side"],
   },
};
const open = (l: Layout, ...ids: string[]) => ids.reduce(show, l);

describe("persistence", () => {
   it("round-trips through parseLayout, minus expanded", () => {
      const l = expand(
         resize(open(move(show(empty, "side"), "events", "rightBottom"), "events", "terminal"), {
            right: 450,
            rightSplit: 0.4,
         }),
         "events",
      );
      const stored = JSON.parse(JSON.stringify({ zones: l.zones, open: l.open, sizes: l.sizes }));
      const r = parseLayout(stored);
      expect(r.zones).toEqual(l.zones);
      expect(r.open.rightBottom).toBe("events");
      expect(r.open.rightTop).toBe("side");
      expect(r.open.bottomLeft).toBe("terminal");
      expect(r.sizes.right).toBe(450);
      expect(r.expanded).toBeNull();
   });
   it("garbage gives the defaults", () => {
      expect(parseLayout(null)).toEqual(defaultLayout());
      expect(parseLayout("x")).toEqual(defaultLayout());
      expect(parseLayout({ zones: { rightTop: [1, null, ""] }, sizes: { left: "wide" } })).toEqual(
         defaultLayout(),
      );
   });
   it("drops duplicates, bad open entries and bad sizes", () => {
      const r = parseLayout({
         zones: { rightTop: ["side", "events"], leftTop: ["events", "changes"] },
         open: { rightTop: "changes", leftTop: "terminal" },
         sizes: { left: -5, right: 500 },
      });
      expect(r.zones.leftTop).toEqual(["events", "changes"]);
      expect(r.zones.rightTop).toEqual(["side"]);
      expect(r.open.rightTop).toBeNull();
      expect(r.open.leftTop).toBeNull();
      expect(r.sizes.left).toBe(empty.sizes.left);
      expect(r.sizes.right).toBe(500);
   });
});

describe("migration of the old right panel state", () => {
   it("opens the old view in its zone (its threads went to the Side chats tabs)", () => {
      const l = migratePanel({ threads: ["a", "b"], thread: "a", view: { kind: "events" } });
      expect(l.open.bottomRight).toBe("events");
      expect(l.open.rightTop).toBeNull();
   });
   it("the side view opens the side chats", () => {
      expect(
         migratePanel({ threads: ["a"], thread: "a", view: { kind: "side" } }).open.rightTop,
      ).toBe("side");
   });
   it("a slot view opens in right top", () => {
      const l = migratePanel({ threads: [], view: { kind: "slot", id: "notes" } });
      expect(l.zones.rightTop).toEqual(["changes", "files", "side", "plan", "tasks", "slot:notes"]);
      expect(l.open.rightTop).toBe("slot:notes");
   });
   it("no view or garbage opens nothing", () => {
      expect(migratePanel({ threads: [], view: null }).open).toEqual(empty.open);
      expect(migratePanel(null)).toEqual(defaultLayout());
      expect(migratePanel({ view: { kind: "terminal" } }).open).toEqual(empty.open);
   });
});

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

describe("saveLayout when storage is full", () => {
   useMemoryStorage();
   it("keeps the legacy key (the fallback copy) when the new write fails", () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const old = JSON.stringify({ threads: ["a"], view: { kind: "events" } });
      localStorage.setItem("harness.chat.panel.s1", old);
      const real = localStorage.setItem;
      localStorage.setItem = (k: string, v: string) => {
         if (k === "harness.chat.layout.s1") throw new Error("full");
         real(k, v);
      };
      const l = loadLayout("s1");
      saveLayout("s1", { ...l, open: { ...l.open, bottomRight: "events" } });
      expect(localStorage.getItem("harness.chat.panel.s1")).toBe(old);
      localStorage.setItem = real;
      saveLayout("s1", { ...l, open: { ...l.open, bottomRight: "events" } });
      expect(localStorage.getItem("harness.chat.panel.s1")).toBeNull();
   });
});

describe("versions", () => {
   useMemoryStorage();
   const key = "harness.chat.layout.s1";
   const oldKey = "harness.chat.panel.s1";
   const tabsKey = "harness.chat.sideThreads.s1";

   it("v0: the oldest key migrates (its view opens), and is removed on the next save", () => {
      localStorage.setItem(oldKey, JSON.stringify({ threads: ["a"], view: { kind: "events" } }));
      const l = loadLayout("s1");
      expect(l.open.bottomRight).toBe("events");
      saveLayout("s1", l);
      expect(localStorage.getItem(oldKey)).toBeNull();
      expect(JSON.parse(localStorage.getItem(key)!)).toMatchObject({ v: 2 });
   });
   it("v1: a value without a version is read as it always was", () => {
      localStorage.setItem(
         key,
         JSON.stringify({
            zones: { ...defaultLayout().zones, bottomLeft: ["terminal"], rightTop: ["side"] },
            open: { bottomLeft: "terminal", rightTop: "side" },
            sizes: { right: 450 },
         }),
      );
      const l = loadLayout("s1");
      expect(l.open.bottomLeft).toBe("terminal");
      expect(l.open.rightTop).toBe("side");
      expect(l.sizes.right).toBe(450);
      expect(l.sizes.left).toBe(defaultLayout().sizes.left);
   });
   it("v2: written as { v: 2, zones, open, sizes } and read back", () => {
      const l = resize(show(defaultLayout(), "files"), { bottom: 300 });
      saveLayout("s1", l);
      const stored = JSON.parse(localStorage.getItem(key)!);
      expect(Object.keys(stored).sort()).toEqual(["open", "sizes", "v", "zones"]);
      expect(stored.v).toBe(2);
      expect(loadLayout("s1")).toEqual(l);
   });
   it("a value of a later version is read as far as it matches", () => {
      localStorage.setItem(key, JSON.stringify({ v: 3, zones: { leftTop: ["files"] }, extra: 1 }));
      expect(loadLayout("s1").zones.leftTop).toEqual(["files"]);
   });
   it("the Terminal is restored open like every panel", () => {
      const l = show(defaultLayout(), "terminal");
      saveLayout("s1", l);
      expect(loadLayout("s1").open.bottomLeft).toBe("terminal");
   });
   it("an id no panel registers keeps its zone through load and save", () => {
      localStorage.setItem(
         key,
         JSON.stringify({ v: 2, zones: { rightTop: ["changes", "ghost"] }, open: {}, sizes: {} }),
      );
      const l = loadLayout("s1");
      expect(l.zones.rightTop).toEqual(["changes", "ghost"]);
      saveLayout("s1", l);
      expect(JSON.parse(localStorage.getItem(key)!).zones.rightTop).toEqual(["changes", "ghost"]);
      expect(loadLayout("s1").zones.rightTop).toEqual(["changes", "ghost"]);
   });

   describe("the Side chats tabs", () => {
      const v1 = { zones: {}, threads: ["a", "draft:x"], thread: "a" };
      it("travel along in the value until the tabs have their own key", () => {
         localStorage.setItem(key, JSON.stringify(v1));
         saveLayout("s1", resize(loadLayout("s1"), { left: 321 }));
         const stored = JSON.parse(localStorage.getItem(key)!);
         expect(stored).toMatchObject({ v: 2, threads: ["a", "draft:x"], thread: "a" });
         expect(stored.sizes.left).toBe(321);
      });
      it("are dropped once the tabs key exists", () => {
         localStorage.setItem(key, JSON.stringify(v1));
         localStorage.setItem(tabsKey, JSON.stringify({ v: 1, threads: ["a"], thread: "a" }));
         saveLayout("s1", resize(loadLayout("s1"), { left: 321 }));
         expect(Object.keys(JSON.parse(localStorage.getItem(key)!)).sort()).toEqual([
            "open",
            "sizes",
            "v",
            "zones",
         ]);
      });
      it("of a v0 value travel along too, as its key goes away", () => {
         localStorage.setItem(oldKey, JSON.stringify({ threads: ["a"], thread: "a" }));
         saveLayout("s1", resize(loadLayout("s1"), { left: 321 }));
         expect(localStorage.getItem(oldKey)).toBeNull();
         expect(JSON.parse(localStorage.getItem(key)!)).toMatchObject({ threads: ["a"] });
      });
      it("an empty list is not carried", () => {
         localStorage.setItem(key, JSON.stringify({ zones: {}, threads: [], thread: null }));
         saveLayout("s1", resize(loadLayout("s1"), { left: 321 }));
         expect(JSON.parse(localStorage.getItem(key)!)).not.toHaveProperty("threads");
      });
   });
   it("drops a plain layout", () => {
      saveLayout("s1", resize(defaultLayout(), { left: 321 }));
      expect(localStorage.getItem(key)).not.toBeNull();
      saveLayout("s1", defaultLayout());
      expect(localStorage.getItem(key)).toBeNull();
   });
});
