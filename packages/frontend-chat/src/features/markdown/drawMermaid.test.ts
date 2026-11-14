import { beforeEach, describe, expect, it, vi } from "vitest";

const render = vi.fn();
vi.mock("mermaid", () => ({ default: { initialize: vi.fn(), render } }));

import { drawMermaid, knownDiagram } from "./drawMermaid";

describe("drawMermaid", () => {
   beforeEach(() => render.mockReset());

   it("remembers a drawn diagram", async () => {
      render.mockResolvedValue({ svg: "<svg/>" });
      expect(await drawMermaid(false, "graph TD; ok")).toEqual({ svg: "<svg/>" });
      expect(knownDiagram(false, "graph TD; ok")).toEqual({ svg: "<svg/>" });
      await drawMermaid(false, "graph TD; ok");
      expect(render).toHaveBeenCalledTimes(1);
   });

   it("never remembers a failed draw", async () => {
      render.mockRejectedValue(new Error("parse error"));
      expect(await drawMermaid(false, "graph TD; par")).toEqual({ error: "parse error" });
      expect(knownDiagram(false, "graph TD; par")).toBeUndefined();
      render.mockResolvedValue({ svg: "<svg/>" });
      expect(await drawMermaid(false, "graph TD; par")).toEqual({ svg: "<svg/>" });
   });
});
