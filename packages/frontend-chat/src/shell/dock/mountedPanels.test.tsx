import { describe, expect, it } from "vitest";
import type { HostedPanel } from "../usePanelHost";
import { mountedPanels } from "./mountedPanels";

const entry = (id: string, mount: HostedPanel["mount"], opened = false): HostedPanel => ({
   id,
   label: id,
   placement: { edge: "right" },
   overlay: false,
   mount,
   self: { id, open: false, opened, show() {}, hide() {}, target: null },
   Body: () => null,
   props: {},
});

describe("mountedPanels", () => {
   const entries = [
      entry("a", "whenOpen"),
      entry("b", "afterFirstOpen", true),
      entry("c", "afterFirstOpen", false),
      entry("d", "whileReady"),
   ];
   it("mounts by the panel's own rule: shown, once opened, or while it can render", () => {
      const ids = (shown: string[], renderable: string[]) =>
         mountedPanels(entries, (id) => shown.includes(id), new Set(renderable)).map((p) => p.id);
      expect(ids([], [])).toEqual(["b"]);
      expect(ids(["a", "c"], [])).toEqual(["a", "b"]);
      expect(ids([], ["d", "a"])).toEqual(["b", "d"]);
   });
   it("keeps the registry's order", () => {
      expect(mountedPanels(entries, () => true, new Set(["d"])).map((p) => p.id)).toEqual([
         "a",
         "b",
         "d",
      ]);
   });
});
