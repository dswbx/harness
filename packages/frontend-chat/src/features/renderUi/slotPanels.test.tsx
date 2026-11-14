import type { SessionApi } from "@harness/api";
import { act, cleanup, render } from "@testing-library/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultLayout, isOpen, type Layout, move, reconcile } from "../../shell/dock/model";
import { type PanelPlace, usePanelHost } from "../../shell/usePanelHost";
import { initialState } from "../../state/reducer";
import { slotPanels } from "./slotPanels";
import { type Slot, slotRef } from "./slots";

let slots: { left: Slot[]; right: Slot[] } = { left: [], right: [] };
// The family reads the render_ui split of the Session's items; the tests hand it slots directly.
vi.mock("../conversation/chatRows", () => ({
   renderUiOf: () => ({ inline: new Map(), slots: { top: [], bottom: [], ...slots } }),
}));

const slot = (id: string, over: Partial<Slot> = {}): Slot => ({
   id,
   title: null,
   icon: null,
   root: { type: "text", text: id } as never,
   files: {},
   ts: 1,
   source: null,
   ...over,
});

afterEach(cleanup);

// Constant lists, as the registry's are.
const NO_PANELS: never[] = [];
const FAMILIES = [slotPanels];

function setup() {
   const out = {} as {
      host: ReturnType<typeof usePanelHost>;
      lay: Layout;
      update: (f: (l: Layout) => Layout) => void;
   };
   function Harness({ tick }: { tick: number }) {
      const [lay, setLay] = useState(defaultLayout);
      const places = useRef<PanelPlace[]>([]);
      const update = useCallback(
         (f: (l: Layout) => Layout) => setLay((l) => f(reconcile(l, places.current))),
         [],
      );
      const host = usePanelHost({
         api: {
            sessionId: "s",
            panelSourceRead: async () => ({ hash: "", mtime: 0 }),
            panelSourceChanged: () => () => {},
         } as unknown as SessionApi,
         state: initialState(),
         variant: "full",
         lay,
         update,
         chat: null,
         host: {},
         panels: NO_PANELS,
         families: FAMILIES,
      });
      places.current = host.places;
      // The View gives the instances a place from their placement, a render later.
      const [placed, setPlaced] = useState<PanelPlace[]>([]);
      useEffect(() => setPlaced(host.places), [host.places]);
      const withPlaces = reconcile(lay, placed);
      useEffect(() => {
         if (withPlaces !== lay) setLay(withPlaces);
      }, [withPlaces, lay]);
      out.host = host;
      out.lay = withPlaces;
      out.update = update;
      return <span data-tick={tick} />;
   }
   const view = render(<Harness tick={0} />);
   const again = (n: number) => view.rerender(<Harness tick={n} />);
   return { out, again };
}

describe("slot panels family", () => {
   it("lists render_ui items placed left or right as `slot:<id>` panels, shown in the Quick Overlay", () => {
      slots = { left: [slot("a", { title: "Alpha" })], right: [slot("b")] };
      const { out } = setup();
      expect(out.host.entries.map((e) => [e.id, e.label, e.overlay, e.placement.edge])).toEqual([
         ["slot:a", "Alpha", true, "left"],
         ["slot:b", "b", true, "right"],
      ]);
      expect(out.host.overlayIds).toEqual(new Set(["slot:a", "slot:b"]));
      expect(out.host.statuses.get("slot:a")?.presence).toBe("ready");
      expect(out.host.places).toEqual([
         { id: "slot:a", zone: "leftTop" },
         { id: "slot:b", zone: "rightTop" },
      ]);
   });

   it("opens the newest slot placed after the Session opened, once: closing it keeps it closed", () => {
      slots = { left: [], right: [] };
      const { out, again } = setup();
      const fresh = slot("a", { ts: Date.now() + 10_000 });
      slots = { left: [fresh], right: [] };
      act(() => again(1));
      expect(isOpen(out.lay, "slot:a")).toBe(true);
      act(() => out.host.ctx.hide(slotRef("a")));
      expect(isOpen(out.lay, "slot:a")).toBe(false);
      act(() => again(2));
      act(() => again(3));
      expect(isOpen(out.lay, "slot:a")).toBe(false);
      // A later change of the same item opens it again.
      slots = { left: [{ ...fresh, ts: fresh.ts + 1 }], right: [] };
      act(() => again(4));
      expect(isOpen(out.lay, "slot:a")).toBe(true);
   });

   it("does not open a slot replayed with the Session", () => {
      slots = { left: [slot("old", { ts: 1 })], right: [] };
      const { out } = setup();
      expect(isOpen(out.lay, "slot:old")).toBe(false);
   });

   it("marks a change made while it was closed with a dot, and not while it is open", () => {
      slots = { left: [slot("a")], right: [] };
      const { out, again } = setup();
      expect(out.host.statuses.get("slot:a")?.dot).toBeUndefined();
      slots = { left: [slot("a", { root: { type: "text", text: "new" } as never })], right: [] };
      act(() => again(1));
      expect(out.host.statuses.get("slot:a")?.dot).toBe(true);
      // Opening it shows it; the dot goes once seen.
      act(() => out.host.ctx.open(slotRef("a")));
      act(() => again(2));
      expect(out.host.statuses.get("slot:a")?.dot).toBeUndefined();
   });

   it("a slot the Agent removed loses its icon but keeps its place, and comes back there", () => {
      slots = { left: [slot("a")], right: [] };
      const { out, again } = setup();
      expect(out.lay.zones.leftTop).toContain("slot:a");
      // The user moves it to another zone and leaves it open.
      act(() => out.update((l) => move(l, "slot:a", "bottomRight")));
      act(() => out.host.ctx.open(slotRef("a")));
      slots = { left: [], right: [] };
      act(() => again(1));
      expect(out.host.statuses.has("slot:a")).toBe(false);
      expect(out.lay.zones.bottomRight).toContain("slot:a");
      slots = { left: [slot("a")], right: [] };
      act(() => again(2));
      expect(out.host.statuses.get("slot:a")?.presence).toBe("ready");
      expect(out.lay.zones.bottomRight).toContain("slot:a");
      expect(out.lay.zones.leftTop).not.toContain("slot:a");
      expect(out.lay.open.bottomRight).toBe("slot:a");
   });
});
