import type { SubagentRow } from "@harness/api";
import { describe, expect, test } from "vitest";
import type { PanelStatus } from "../panels/contract";
import { defaultLayout, type PanelId, slotPanel } from "./panelLayout";
import { PANELS, panelDef, zoneOfHint } from "./panels";
import { availablePanels } from "./viewState";

const row = (state: SubagentRow["state"]): SubagentRow => ({
   id: state,
   title: "t",
   type: null,
   model: null,
   modelInherited: false,
   effort: null,
   calls: 0,
   state,
   startedAt: null,
   endedAt: null,
});
const statusOf = (id: string, model: unknown): PanelStatus => panelDef(id)!.status(model);
const registered = (m: { rows: SubagentRow[]; running: number }) =>
   new Map<string, PanelStatus>([
      ["events", statusOf("events", null)],
      ["subagents", statusOf("subagents", m)],
   ]);
const none = { overlay: false, slotPanels: [], git: false, hasPlans: false };

describe("registry", () => {
   test("lists Events, then Subagents", () => {
      expect(PANELS.map((p) => p.id)).toEqual(["events", "subagents"]);
      expect(panelDef("subagents")?.label).toBe("Subagents");
      expect(panelDef("files")).toBeUndefined();
   });

   test("with the hand-written remainder it yields the default layout", () => {
      expect(defaultLayout().zones).toEqual({
         leftTop: ["artifacts"],
         leftBottom: ["references", "subagents"],
         bottomLeft: ["terminal"],
         bottomRight: ["events"],
         rightBottom: [],
         rightTop: ["changes", "files", "side", "plan"],
      });
   });

   test("Events and Subagents mount only while open; Events can expand", () => {
      for (const p of PANELS) expect(p.mount ?? "whenOpen").toBe("whenOpen");
      expect(panelDef("events")?.expandable).toBe(true);
      expect(panelDef("subagents")?.expandable).toBeFalsy();
   });
});

describe("zoneOfHint", () => {
   test.each([
      [{ edge: "left" }, "leftTop"],
      [{ edge: "left", end: true }, "leftBottom"],
      [{ edge: "bottom" }, "bottomLeft"],
      [{ edge: "bottom", end: true }, "bottomRight"],
      [{ edge: "right" }, "rightTop"],
      [{ edge: "right", end: true }, "rightBottom"],
   ] as const)("%j starts in %s", (hint, zone) => {
      expect(zoneOfHint(hint)).toBe(zone);
   });

   test("Events and Subagents start where they always did", () => {
      expect(zoneOfHint(panelDef("events")!.placement)).toBe("bottomRight");
      expect(zoneOfHint(panelDef("subagents")!.placement)).toBe("leftBottom");
   });
});

describe("Events status", () => {
   test("is always ready, without a badge", () => {
      expect(statusOf("events", null)).toEqual({ presence: "ready" });
   });
});

describe("Subagents status", () => {
   test("is absent without subagents", () => {
      expect(statusOf("subagents", { rows: [], running: 0 }).presence).toBe("absent");
   });
   test("is ready with some, badged by the running ones", () => {
      expect(statusOf("subagents", { rows: [row("running"), row("done")], running: 1 })).toEqual({
         presence: "ready",
         badge: 1,
      });
   });
   test("has no badge when none runs", () => {
      expect(statusOf("subagents", { rows: [row("done")], running: 0 }).badge).toBeUndefined();
   });
});

describe("availablePanels with registered panels", () => {
   test("Events is available, Subagents only with subagents", () => {
      const a = availablePanels({ ...none, registered: registered({ rows: [], running: 0 }) });
      expect(a.has("events")).toBe(true);
      expect(a.has("subagents")).toBe(false);
      const b = availablePanels({
         ...none,
         registered: registered({ rows: [row("done")], running: 0 }),
      });
      expect(b.has("subagents")).toBe(true);
   });
   test("the other panels are unchanged", () => {
      const a = availablePanels({ ...none, registered: registered({ rows: [], running: 0 }) });
      expect([...a].sort()).toEqual(
         ["artifacts", "events", "files", "references", "side", "terminal"].sort(),
      );
   });
   test("the overlay shows only slot panels, whatever is registered", () => {
      const a = availablePanels({
         ...none,
         overlay: true,
         slotPanels: [slotPanel("a") as PanelId],
         registered: registered({ rows: [row("running")], running: 1 }),
      });
      expect([...a]).toEqual(["slot:a"]);
   });
});
