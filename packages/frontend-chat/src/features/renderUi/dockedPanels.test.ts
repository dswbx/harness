import { describe, expect, it } from "vitest";
import {
   addedPanelId,
   closePanel,
   NO_DOCKED,
   openAsPanel,
   panelIdOf,
   placedPanelId,
} from "./dockedPanels";

const placed = { key: "ui:p", placement: "right", slotId: "p" };
const inline = { key: "ui:i", placement: "inline", slotId: "i" };
const diagram = { key: "r1:diagram:0", placement: "inline", slotId: null };

describe("docked panels", () => {
   it("names added panels by render_ui id, else by artifact key", () => {
      expect(addedPanelId("ui:i")).toBe("i");
      expect(addedPanelId("r1:diagram:0")).toBe("a:r1:diagram:0");
      expect(placedPanelId(placed)).toBe("p");
      expect(placedPanelId(inline)).toBeNull();
   });

   it("closes a placed panel and opens it again", () => {
      const closed = closePanel(NO_DOCKED, "p");
      expect(closed.closed).toEqual(["p"]);
      expect(panelIdOf(placed, closed)).toBeNull();
      const { next, id } = openAsPanel(closed, placed.key, placedPanelId(placed));
      expect(id).toBe("p");
      expect(panelIdOf(placed, next)).toBe("p");
   });

   it("adds an inline item or diagram, and closing forgets it", () => {
      const a = openAsPanel(NO_DOCKED, diagram.key, null);
      const b = openAsPanel(a.next, inline.key, null);
      expect(b.next.added).toEqual([diagram.key, inline.key]);
      expect(panelIdOf(diagram, b.next)).toBe("a:r1:diagram:0");
      expect(panelIdOf(inline, b.next)).toBe("i");
      const c = closePanel(b.next, "a:r1:diagram:0");
      expect(c).toEqual({ closed: [], added: [inline.key] });
      expect(panelIdOf(diagram, c)).toBeNull();
   });

   it("adding twice or closing twice changes nothing", () => {
      const a = openAsPanel(NO_DOCKED, diagram.key, null).next;
      expect(openAsPanel(a, diagram.key, null).next).toBe(a);
      const c = closePanel(NO_DOCKED, "p");
      expect(closePanel(c, "p")).toBe(c);
   });
});
