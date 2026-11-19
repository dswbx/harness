import { describe, expect, it } from "vitest";
import { contextInstructions } from "./instructions";

const block = (parts: string, facts = "") =>
   `<harness_context>\nYou run inside Harness.\n\n${parts}## This Session\n- Workspace folder: /work/demo-side/sub\n- Repository: /work/demo-side\n${facts}</harness_context>`;

describe("contextInstructions", () => {
   it("finds the global and the repository part, keyed by the instructions folder", () => {
      const text = block(
         "## Your instructions for all Sessions\n\nBe brief.\n\n## Your instructions (demo)\n\nUse tabs.\n\n",
         "- Instructions folder: /work/demo\n",
      );
      expect(contextInstructions(text)).toEqual([
         { scope: { type: "global" }, name: "global" },
         { scope: { type: "repo", path: "/work/demo" }, name: "demo" },
      ]);
   });

   it("keeps a repository named global apart from Global", () => {
      const text = block(
         "## Your instructions (global)\n\nUse tabs.\n\n",
         "- Instructions folder: /work/global\n",
      );
      expect(contextInstructions(text)).toEqual([
         { scope: { type: "repo", path: "/work/global" }, name: "global" },
      ]);
   });

   it("finds nothing without the parts or the key line", () => {
      expect(contextInstructions(block(""))).toEqual([]);
      expect(contextInstructions(block("## Your instructions (demo)\n\nx\n\n"))).toEqual([]);
   });
});
