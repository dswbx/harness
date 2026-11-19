import { describe, expect, it } from "vitest";
import { initialState } from "../../state/reducer";
import { withSourceRoot } from "../renderUi/tools";
import { artifactFor } from "./ArtifactRequest";

const ui = (id: string, title: string) => {
   const value = withSourceRoot({ id, placement: "right", title, source: `${id}.md` });
   return {
      type: "frontend_tool" as const,
      id,
      ts: 2,
      tool: "render_ui",
      callId: id,
      path: "p",
      input: value,
      files: {},
      render: { ok: true as const, value },
   };
};

describe("artifactFor (view_artifact)", () => {
   const base = { ...initialState(), items: [ui("a", "Agent title"), ui("b", "Other")] };

   it("uses the user's title for a renamed panel", () => {
      const state = {
         ...base,
         panelEdits: { overrides: { a: { title: "Mine", icon: null } }, deleted: {} },
      };
      expect(artifactFor(state, { id: "a" }).title).toBe("Mine");
   });

   it("does not find a deleted panel", () => {
      const state = { ...base, panelEdits: { overrides: {}, deleted: { a: true as const } } };
      expect(() => artifactFor(state, { id: "a" })).toThrow(/No artifact/);
      expect(artifactFor(state, { id: "b" }).title).toBe("Other");
   });
});
