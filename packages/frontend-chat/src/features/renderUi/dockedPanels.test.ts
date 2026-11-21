import { describe, expect, it } from "vitest";
import {
   addedPanelId,
   closePanel,
   isClosed,
   NO_DOCKED,
   openAsPanel,
   panelIdOf,
   placedPanelId,
} from "./dockedPanels";

const placed = { key: "ui:p", placement: "right", slotId: "p", ts: 10 };
const inline = { key: "ui:i", placement: "inline", slotId: "i", ts: 10 };
const diagram = { key: "r1:diagram:0", placement: "inline", slotId: null, ts: 10 };

describe("docked panels", () => {
   it("names added panels by render_ui id, else by artifact key", () => {
      expect(addedPanelId("ui:i")).toBe("i");
      expect(addedPanelId("r1:diagram:0")).toBe("a:r1:diagram:0");
      expect(placedPanelId(placed)).toBe("p");
      expect(placedPanelId(inline)).toBeNull();
   });

   it("closes a placed panel and opens it again", () => {
      const closed = closePanel(NO_DOCKED, "p", placed.ts);
      expect(closed.closed).toEqual({ p: 10 });
      expect(panelIdOf(placed, closed)).toBeNull();
      const { next, id } = openAsPanel(closed, placed.key, placedPanelId(placed));
      expect(id).toBe("p");
      expect(next.closed).toEqual({});
      expect(panelIdOf(placed, next)).toBe("p");
   });

   it("a later Agent call brings a closed panel back", () => {
      const closed = closePanel(NO_DOCKED, "p", 10);
      expect(isClosed(closed, "p", 10)).toBe(true);
      expect(isClosed(closed, "p", 11)).toBe(false);
      expect(panelIdOf({ ...placed, ts: 11 }, closed)).toBe("p");
      // Closed again after that call: closed until the next one.
      const again = closePanel(closed, "p", 11);
      expect(isClosed(again, "p", 11)).toBe(true);
   });

   it("adds an inline item or diagram, and closing forgets it", () => {
      const a = openAsPanel(NO_DOCKED, diagram.key, null);
      const b = openAsPanel(a.next, inline.key, null);
      expect(b.next.added).toEqual([diagram.key, inline.key]);
      expect(panelIdOf(diagram, b.next)).toBe("a:r1:diagram:0");
      expect(panelIdOf(inline, b.next)).toBe("i");
      const c = closePanel(b.next, "a:r1:diagram:0", 10);
      expect(c).toEqual({ closed: {}, added: [inline.key] });
      expect(panelIdOf(diagram, c)).toBeNull();
   });

   it("adding twice or closing twice changes nothing", () => {
      const a = openAsPanel(NO_DOCKED, diagram.key, null).next;
      expect(openAsPanel(a, diagram.key, null).next).toBe(a);
      const c = closePanel(NO_DOCKED, "p", 10);
      expect(closePanel(c, "p", 10)).toBe(c);
   });
});
