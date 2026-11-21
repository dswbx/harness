import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostedPanel } from "../usePanelHost";
import { beforeLoad, loadRecord, parseRecord, recordOf, saveRecord } from "./panelRecord";

const mem = new Map<string, string>();
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

const entry = (id: string, iconName?: string): HostedPanel => ({
   id,
   label: `${id} label`,
   iconName,
   placement: { edge: "right" },
   overlay: false,
   mount: "whenOpen",
   self: { id, open: false, opened: false, show() {}, hide() {}, target: null },
   Body: () => null,
   props: {},
});

describe("parseRecord", () => {
   it("reads a list of panels", () => {
      expect(
         parseRecord({
            panels: [
               { id: "files", label: "Files", ready: true },
               { id: "slot:a", label: "Notes", icon: "book", ready: false },
            ],
         }),
      ).toEqual([
         { id: "files", label: "Files", ready: true },
         { id: "slot:a", label: "Notes", icon: "book", ready: false },
      ]);
   });

   it("reads bad data as no record", () => {
      for (const raw of [
         undefined,
         null,
         "x",
         [],
         {},
         { panels: {} },
         { panels: [null] },
         { panels: [{ id: "", label: "A", ready: true }] },
         { panels: [{ id: "a", ready: true }] },
         { panels: [{ id: "a", label: "A", ready: "yes" }] },
         { panels: [{ id: "a", label: "A", icon: 3, ready: true }] },
         { panels: [{ id: "a", label: "A", ready: true }, 1] },
      ])
         expect(parseRecord(raw)).toBeNull();
   });
});

describe("loadRecord / saveRecord", () => {
   it("round-trips per Session", () => {
      const panels = [{ id: "slot:a", label: "Notes", icon: "book", ready: true }];
      expect(loadRecord("s1")).toBeNull();
      saveRecord("s1", panels);
      expect(loadRecord("s1")).toEqual(panels);
      expect(loadRecord("s2")).toBeNull();
      expect(JSON.parse(mem.get("harness.chat.dockPanels.s1")!)).toEqual({ panels });
   });

   it("reads data that is not JSON as no record", () => {
      mem.set("harness.chat.dockPanels.s1", "{nope");
      expect(loadRecord("s1")).toBeNull();
   });
});

describe("recordOf", () => {
   it("keeps the available panels in host order, with icon names and whether they can show", () => {
      const entries = [entry("files"), entry("plan"), entry("slot:a", "book"), entry("events")];
      expect(
         recordOf(entries, new Set(["slot:a", "files", "events"]), new Set(["slot:a"])),
      ).toEqual([
         { id: "files", label: "files label", ready: false },
         { id: "slot:a", label: "slot:a label", icon: "book", ready: true },
         { id: "events", label: "events label", ready: false },
      ]);
   });
});

describe("beforeLoad", () => {
   const record = [
      { id: "slot:a", label: "A", ready: true },
      { id: "slot:b", label: "B", ready: false },
      { id: "files", label: "Files", ready: true },
   ];

   it("adds the recorded panels; ready ones that cannot show yet get a placeholder", () => {
      const r = beforeLoad(record, {
         available: new Set(["files", "terminal"]),
         renderable: new Set(["files"]),
      });
      expect([...r.available].sort()).toEqual(["files", "slot:a", "slot:b", "terminal"]);
      expect([...r.renderable].sort()).toEqual(["files", "slot:a"]);
      expect([...r.placeholders]).toEqual([["slot:a", "A"]]);
   });

   it("leaves what can show now as it is", () => {
      const r = beforeLoad([], { available: new Set(["x"]), renderable: new Set(["x"]) });
      expect([...r.available]).toEqual(["x"]);
      expect([...r.renderable]).toEqual(["x"]);
      expect(r.placeholders.size).toBe(0);
   });
});
