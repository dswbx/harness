import { describe, expect, it } from "vitest";
import { PANELS, zoneOfHint } from "../panels";
import {
   defaultLayout,
   expand,
   hide,
   type Layout,
   move,
   reconcile,
   resetLayout,
   resize,
   show,
   toggle,
   zoneOf,
} from "./model";

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

/** What the host feeds `reconcile` with when only the registered panels exist. */
const registered = PANELS.map((p) => ({ id: p.id, zone: zoneOfHint(p.placement) }));

describe("defaultLayout", () => {
   it("has Artifacts left top, References then Subagents left bottom, Changes then Files first in right top", () => {
      const { zones } = defaultLayout();
      expect(zones.leftTop).toEqual(["artifacts"]);
      expect(zones.leftBottom).toEqual(["references", "subagents"]);
      expect(zones.rightTop).toEqual(["changes", "files", "side", "plan", "tasks"]);
   });
});

describe("toggle, show, hide", () => {
   it("toggle opens the panel in its zone, then hides it", () => {
      const on = toggle(empty, "changes");
      expect(on.open.leftTop).toBe("changes");
      expect(toggle(on, "changes").open.leftTop).toBeNull();
   });
   it("showing another panel of the zone replaces the open one", () => {
      const l = move(open(empty, "changes"), "artifacts", "leftTop");
      expect(show(l, "artifacts").open.leftTop).toBe("artifacts");
   });
   it("show is a no-op when already shown, hide when not shown", () => {
      const l = open(empty, "events");
      expect(show(l, "events")).toBe(l);
      expect(hide(l, "terminal")).toBe(l);
      expect(hide(l, "events").open.bottomRight).toBeNull();
   });
   it("unknown panels are ignored", () => {
      expect(toggle(empty, "slot:nope")).toBe(empty);
   });
   it("hiding the expanded panel shrinks it", () => {
      const l = expand(open(empty, "events"), "events");
      expect(l.expanded).toBe("events");
      expect(hide(l, "events").expanded).toBeNull();
      expect(toggle(l, "events").expanded).toBeNull();
   });
   it("only an open panel expands", () => {
      expect(expand(empty, "events")).toBe(empty);
   });
});

describe("move", () => {
   it("moves between zones, to the end by default", () => {
      const l = move(empty, "events", "rightTop");
      expect(l.zones.bottomRight).toEqual([]);
      expect(l.zones.rightTop).toEqual(["side", "events"]);
      expect(zoneOf(l, "events")).toBe("rightTop");
   });
   it("inserts at an index", () => {
      expect(move(empty, "events", "rightTop", 0).zones.rightTop).toEqual(["events", "side"]);
   });
   it("an open panel stays open in its new zone and leaves the old one empty", () => {
      const l = move(open(empty, "terminal"), "terminal", "rightBottom");
      expect(l.open.bottomLeft).toBeNull();
      expect(l.open.rightBottom).toBe("terminal");
   });
   it("a closed panel stays closed", () => {
      const l = move(empty, "terminal", "rightBottom");
      expect(l.open.rightBottom).toBeNull();
   });
   it("replaces what the target zone showed", () => {
      const l = move(open(empty, "events", "side"), "events", "rightTop");
      expect(l.open.rightTop).toBe("events");
      expect(l.zones.rightTop).toEqual(["side", "events"]);
   });
   it("the expanded panel stays expanded when it moves, and shrinks if its zone's panel is replaced", () => {
      const l = expand(open(empty, "events"), "events");
      expect(move(l, "events", "rightTop").expanded).toBe("events");
      expect(move(open(l, "side"), "terminal", "rightTop").expanded).toBe("events");
   });
   describe("reorder in the same zone (index = position before the move)", () => {
      const l = move(move(empty, "events", "rightTop"), "changes", "rightTop"); // side, events, changes
      it("forward", () => {
         expect(move(l, "side", "rightTop", 2).zones.rightTop).toEqual([
            "events",
            "side",
            "changes",
         ]);
         expect(move(l, "side", "rightTop", 3).zones.rightTop).toEqual([
            "events",
            "changes",
            "side",
         ]);
      });
      it("backward", () => {
         expect(move(l, "changes", "rightTop", 0).zones.rightTop).toEqual([
            "changes",
            "side",
            "events",
         ]);
         expect(move(l, "changes", "rightTop", 1).zones.rightTop).toEqual([
            "side",
            "changes",
            "events",
         ]);
      });
      it("dropping on its own place changes nothing", () => {
         expect(move(l, "events", "rightTop", 1).zones.rightTop).toEqual([
            "side",
            "events",
            "changes",
         ]);
         expect(move(l, "events", "rightTop", 2).zones.rightTop).toEqual([
            "side",
            "events",
            "changes",
         ]);
      });
      it("keeps the open panel", () => {
         expect(move(show(l, "events"), "events", "rightTop", 0).open.rightTop).toBe("events");
      });
   });
});

describe("reset", () => {
   // Owner decision: Reset layout resets placement only. It no longer reopens Side chats because tabs exist
   // (the tabs are not part of the layout any more).
   it("restores places and sizes, and opens nothing", () => {
      const l = resize(open(move(empty, "side", "leftTop"), "side", "events"), { left: 500 });
      const r = resetLayout();
      expect(r.zones).toEqual(defaultLayout().zones);
      expect(r.sizes).toEqual(empty.sizes);
      expect(r.open).toEqual(empty.open);
      expect(l.open.leftTop).toBe("side");
   });
});

describe("reconcile", () => {
   it("is the identity when nothing is missing", () => {
      const full = {
         ...empty,
         zones: {
            ...empty.zones,
            leftBottom: ["artifacts", "references", "subagents"] as string[],
            rightTop: ["side", "plan", "tasks"] as string[],
         },
      };
      expect(reconcile(full, registered)).toBe(full);
   });
   it("puts built-in panels missing from the zones in their default zone", () => {
      const l = { ...empty, zones: { ...empty.zones, bottomRight: [], leftTop: [] } };
      const r = reconcile(l, registered);
      expect(r.zones.bottomRight).toEqual(["events"]);
      expect(r.zones.rightTop).toEqual(["side", "changes", "plan", "tasks"]);
   });
   it("adds the Files panel to an old saved layout, next to Changes", () => {
      const old = defaultLayout();
      old.zones.rightTop = ["changes", "side"];
      const r = reconcile(old, registered);
      expect(r.zones.rightTop).toEqual(["changes", "side", "files", "plan", "tasks"]);
      expect(zoneOf(r, "files")).toBe("rightTop");
   });
   it("keeps an unknown id in its place, drops duplicates, and still places a known panel that is missing", () => {
      const l = {
         ...empty,
         zones: {
            ...empty.zones,
            leftBottom: ["nope", "changes", "artifacts"] as string[],
            bottomRight: [],
         },
      };
      const r = reconcile(l, registered);
      expect(r.zones.leftBottom).toEqual(["nope", "artifacts", "references", "subagents"]);
      expect(r.zones.leftTop).toEqual(["changes"]);
      expect(r.zones.bottomRight).toEqual(["events"]);
      expect(reconcile(r, registered)).toBe(r);
   });
   it("an unknown id keeps being open-able state: it stays in its zone and its open entry", () => {
      const l = {
         ...empty,
         zones: { ...empty.zones, rightBottom: ["files", "ghost"] },
         open: { ...empty.open, rightBottom: "ghost" },
      };
      const r = reconcile(l, registered);
      expect(r.zones.rightBottom).toEqual(["files", "ghost"]);
      expect(r.open.rightBottom).toBe("ghost");
   });
   it("places new slots by placement and leaves placed ones where the user put them", () => {
      let l = reconcile(empty, [
         ...registered,
         { id: "slot:a", zone: "rightTop" },
         { id: "slot:b", zone: "leftTop" },
      ]);
      expect(l.zones.rightTop).toEqual(["side", "plan", "tasks", "slot:a"]);
      expect(l.zones.leftTop).toEqual(["changes", "slot:b"]);
      l = move(l, "slot:a", "bottomRight");
      const again = reconcile(l, [
         ...registered,
         { id: "slot:a", zone: "rightTop" },
         { id: "slot:b", zone: "leftTop" },
      ]);
      expect(again).toBe(l);
   });
   it("keeps the spot of a slot that is gone (it only loses its icon)", () => {
      const l = reconcile(empty, [...registered, { id: "slot:a", zone: "rightTop" }]);
      expect(reconcile(l, registered)).toBe(l);
   });
   it("clears an open entry that is not in its zone", () => {
      const l = { ...empty, open: { ...empty.open, rightTop: "events" as string } };
      expect(reconcile(l, registered).open.rightTop).toBeNull();
   });
});
