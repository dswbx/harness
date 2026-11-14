import { describe, expect, it } from "vitest";
import { highlight, highlightLines, isLanguage, languageOf, toLines } from "./highlight";

describe("languageOf", () => {
   it("covers what the file view and the diff each knew", () => {
      const cases: Record<string, string> = {
         // The file view's table.
         "a.mts": "typescript",
         "a.cts": "typescript",
         "a.mjs": "javascript",
         "a.cjs": "javascript",
         "a.jsonc": "json",
         "a.json5": "json",
         "a.toml": "ini",
         "a.html": "xml",
         "a.htm": "xml",
         "App.vue": "xml",
         "App.svelte": "xml",
         "a.zsh": "bash",
         "a.fish": "bash",
         "a.mdx": "markdown",
         "src/Makefile": "makefile",
         // The diff's table.
         "a.ts": "typescript",
         "a.tsx": "typescript",
         "a.js": "javascript",
         "a.jsx": "javascript",
         "a.json": "json",
         "a.md": "markdown",
         "a.rs": "rust",
         "a.py": "python",
         "a.go": "go",
         "a.css": "css",
         "a.xml": "xml",
         "a.svg": "xml",
         "a.yml": "yaml",
         "a.yaml": "yaml",
         "a.sh": "bash",
         "a.sql": "sql",
         "a.java": "java",
         "a.kt": "kotlin",
         "a.swift": "swift",
         "a.rb": "ruby",
      };
      for (const [path, lang] of Object.entries(cases))
         expect([path, languageOf(path)]).toEqual([path, lang]);
   });

   it("knows extensions that highlight.js knows by name, in any case", () => {
      expect(languageOf("lib/x.c")).toBe("c");
      expect(languageOf("a/b.LUA")).toBe("lua");
      expect(languageOf("a/b.php")).toBe("php");
   });

   it("is null for plain text and unknown files", () => {
      for (const p of ["README", "notes.txt2", "a.unknownext", "dir.d/file", ".gitignore"])
         expect([p, languageOf(p)]).toEqual([p, null]);
   });

   it("only names languages the highlighter has", () => {
      for (const p of ["a.vue", "a.toml", "Makefile", "a.c"])
         expect(isLanguage(languageOf(p)!)).toBe(true);
   });
});

describe("highlight", () => {
   it("gives hljs tokens, and null without a known language", () => {
      const tree = highlight("const x = 1;", "typescript")!;
      expect(JSON.stringify(tree)).toContain("hljs-keyword");
      expect(highlight("x", null)).toBeNull();
      expect(highlight("x", "nonesuch")).toBeNull();
   });

   it("splits a token over lines (a block comment) into runs per line", () => {
      const lines = highlightLines("typescript", ["/* a", "b */ x"]);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toEqual([{ text: "/* a", cls: "hljs-comment" }]);
      expect(lines[1]![0]).toEqual({ text: "b */", cls: "hljs-comment" });
      expect(toLines(highlight("a\nb", "plaintext")!)).toHaveLength(2);
   });

   it("is plain without a language", () => {
      expect(highlightLines(null, ["a", "", "b"])).toEqual([[{ text: "a" }], [], [{ text: "b" }]]);
   });
});
