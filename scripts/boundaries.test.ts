import { describe, expect, it } from "vitest";
import { importSpecs, importViolation, leaks, stripComments } from "./boundaries";

const root = "/repo/packages/frontend-x";
const file = `${root}/src/a/b.tsx`;
const declared = new Set(["lucide-react", "@lexical/react"]);
const check = (spec: string) => importViolation(spec, file, root, declared);

describe("importViolation", () => {
   it("allows own files, @harness/api, @harness/ui, react and declared deps", () => {
      for (const s of [
         "./c",
         "../d",
         "@harness/api",
         "@harness/ui",
         "react",
         "react-dom",
         "react/jsx-runtime",
         "lucide-react",
         "@lexical/react/LexicalComposer",
      ])
         expect(check(s), s).toBeNull();
   });

   it("rejects everything else", () => {
      for (const s of [
         "../../../x/y",
         "@tauri-apps/api/core",
         "@harness/app",
         "@harness/frontend-chat",
         "node:fs",
         "undeclared",
         "@lexical/other",
      ])
         expect(check(s), s).not.toBeNull();
   });
});

describe("importSpecs", () => {
   it("finds imports, re-exports and dynamic imports, not prose", () => {
      const src = `import a from "x";\nimport {\n  b,\n} from "y";\nexport * from "z";\nimport "w";\nconst m = await import("v");\nconst t = "read from \\"nowhere\\"";\n// import q from "commented";\n`;
      expect(importSpecs(src)).toEqual(["x", "y", "z", "w", "v"]);
   });
});

describe("leaks", () => {
   it("flags raw payload reads and Agent names in code", () => {
      expect(leaks("const p = call.rawInput.plan;")).toEqual([[1, "reads rawInput"]]);
      expect(leaks("x = k.raw_output;")).toEqual([[1, "reads raw_output"]]);
      expect(leaks('if (id === "Codex") {}')).toEqual([[1, "names an Agent"]]);
   });

   it("ignores comments and passing a whole value on", () => {
      expect(leaks("// Claude Code has /btw\nconst a = 1; // codex too")).toEqual([]);
      expect(leaks("/* rawInput.plan\n claude */ const a = present(tool.rawInput);")).toEqual([]);
      expect(stripComments("a /* x\ny */ b")).toBe("a \n b");
   });
});
