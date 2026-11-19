import { describe, expect, it } from "vitest";
import { contextInstructions } from "./instructions";

const block = (parts: string) =>
   `<harness_context>\nYou run inside Harness.\n\n${parts}## This Session\n- Workspace folder: /work/demo/sub\n- Repository: /work/demo\n</harness_context>`;

describe("contextInstructions", () => {
   it("finds the global and the repository part", () => {
      const text = block(
         "## Your instructions (global)\n\nBe brief.\n\n## Your instructions (demo)\n\nUse tabs.\n\n",
      );
      expect(contextInstructions(text)).toEqual([
         { scope: { type: "global" }, name: "global" },
         { scope: { type: "repo", path: "/work/demo" }, name: "demo" },
      ]);
   });

   it("uses the folder outside git and finds nothing without the parts", () => {
      const plain =
         "<harness_context>\n## Your instructions (notes)\n\nx\n\n## This Session\n- Workspace folder: /work/notes\n- Not a git repository\n</harness_context>";
      expect(contextInstructions(plain)).toEqual([
         { scope: { type: "repo", path: "/work/notes" }, name: "notes" },
      ]);
      expect(contextInstructions(block(""))).toEqual([]);
   });
});
