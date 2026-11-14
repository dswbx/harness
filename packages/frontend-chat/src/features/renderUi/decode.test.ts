import { describe, expect, it } from "vitest";
import type { DecodedRenderUi } from "../../state/types";
import { decodeTool } from "./decode";
import type { RenderUiInput } from "./tools";

describe("decodeTool", () => {
   it("RenderUiInput stays assignable to what the reducer reads (DecodedRenderUi)", () => {
      const accepts = (_: DecodedRenderUi) => {};
      accepts({} as RenderUiInput);
   });

   it("knows render_ui only", () => {
      expect(decodeTool("other_tool", {})).toBeNull();
      expect(decodeTool("render_ui", { root: { type: "Nope" } })).toMatchObject({ ok: false });
   });
});
