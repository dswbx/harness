import { describe, expect, it } from "vitest";
import {
   apiEntryViolation,
   appViolation,
   importedNames,
   importSpecs,
   importViolation,
   leaks,
   stripComments,
   uiViolation,
} from "./boundaries";

describe("apiEntryViolation", () => {
   it("rejects the mock, allows the rest", () => {
      for (const s of ["./mock", "./mock/mock", "./mock/index"])
         expect(apiEntryViolation(s), s).not.toBeNull();
      for (const s of ["./client/client", "./mockery", "./generated"])
         expect(apiEntryViolation(s), s).toBeNull();
   });
});

describe("importViolation: @harness/api subpaths", () => {
   it("rejects @harness/api/mock in Frontend source", () => {
      expect(importViolation("@harness/api/mock", "/r/src/a.ts", "/r", new Set())).not.toBeNull();
      expect(importViolation("@harness/api", "/r/src/a.ts", "/r", new Set())).toBeNull();
   });
});

describe("uiViolation", () => {
   it("rejects @harness/api and Frontends", () => {
      for (const s of ["@harness/api", "@harness/api/x", "@harness/frontend-chat"])
         expect(uiViolation(s), s).not.toBeNull();
   });

   it("allows everything else", () => {
      for (const s of ["react", "./a", "@radix-ui/react-slot", "@harness/ui"])
         expect(uiViolation(s), s).toBeNull();
   });
});

describe("importedNames", () => {
   it("reads the names each import takes", () => {
      const src = `import { frontend } from "a";\nimport type { T, type U as V } from "b";\nimport def, { x as y } from "c";\nimport * as ns from "d";\nexport * from "e";\nexport { z } from "f";\nimport "g";\nconst m = await import("h");\nimport {\n  p,\n  q,\n} from "i";\n`;
      expect(importedNames(src)).toEqual([
         ["a", ["frontend"]],
         ["b", ["T", "U"]],
         ["c", ["x", "default"]],
         ["d", ["*"]],
         ["e", ["*"]],
         ["f", ["z"]],
         ["g", []],
         ["h", null],
         ["i", ["p", "q"]],
      ]);
   });
});

describe("appViolation", () => {
   const repo = "/repo";
   const f = "/repo/app/src/a/b.tsx";
   const check = (spec: string, names: string[] | null) => appViolation(spec, names, f, repo);

   it("allows the frontend object from a root entry, and anything not a Frontend", () => {
      expect(check("@harness/frontend-chat", ["frontend"])).toBeNull();
      expect(check("@harness/frontend-chat", [])).toBeNull();
      expect(check("@harness/api", ["Event"])).toBeNull();
      expect(check("../c", ["x"])).toBeNull();
      expect(check("../../../vite.config", ["x"])).toBeNull();
   });

   it("rejects other names, deep paths and relative paths into packages/", () => {
      expect(check("@harness/frontend-chat", ["frontend", "RenderUiGallery"])).not.toBeNull();
      expect(check("@harness/frontend-chat", ["default"])).not.toBeNull();
      expect(check("@harness/frontend-chat", ["*"])).not.toBeNull();
      expect(check("@harness/frontend-chat", null)).not.toBeNull();
      expect(check("@harness/frontend-chat/src/x", ["frontend"])).not.toBeNull();
      expect(check("../../../packages/frontend-chat/src/f.jsonl?raw", ["default"])).not.toBeNull();
      expect(check("../../../packages/ui/src/index", ["x"])).not.toBeNull();
   });
});

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

   it("flags reads of rawInput/rawOutput through casts, arguments and checks", () => {
      expect(leaks("const q = (tool.rawInput as { query?: unknown })?.query;")).toEqual([
         [1, "reads rawInput"],
      ]);
      expect(leaks("Array.isArray(tool.rawOutput)")).toEqual([[1, "reads rawOutput"]]);
      expect(leaks("commandOf(tool.rawInput, tool.title)")).toEqual([[1, "reads rawInput"]]);
      expect(leaks("const cmd = (rawInput as { command?: unknown } | null)?.command;")).toEqual([
         [1, "reads rawInput"],
      ]);
      expect(leaks("present(tool.rawOutput)")).toEqual([[1, "reads rawOutput"]]);
   });

   it("flags the mcp__ tool-title convention", () => {
      expect(leaks('title.startsWith("mcp__")')).toEqual([
         [1, "parses an Agent's MCP tool-title convention"],
      ]);
   });

   it("does not flag defining rawInput/rawOutput", () => {
      expect(leaks("rawInput: unknown;\nrawOutput?: unknown;")).toEqual([]);
      expect(leaks("function f(rawInput: unknown, title: string) {}")).toEqual([]);
      expect(leaks("const { rawInput, rawOutput } = x;")).toEqual([]);
      expect(leaks("const { rawInput,\n rawOutput } = x;")).toEqual([]);
   });

   it("ignores comments", () => {
      expect(leaks("// Claude Code has /btw\nconst a = 1; // codex too")).toEqual([]);
      expect(leaks("/* rawInput.plan\n claude */ const a = 1; // mcp__x")).toEqual([]);
      expect(stripComments("a /* x\ny */ b")).toBe("a \n b");
   });
});
