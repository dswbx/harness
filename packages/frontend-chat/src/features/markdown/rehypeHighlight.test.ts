import { expect, test } from "vitest";
import { rehypeHighlightBlocks } from "./rehypeHighlight";

type Node = Parameters<ReturnType<typeof rehypeHighlightBlocks>>[0];
const code = (className: string[] | undefined, value: string): Node => ({
   type: "element",
   tagName: "pre",
   children: [
      {
         type: "element",
         tagName: "code",
         properties: className ? { className } : {},
         children: [{ type: "text", value }],
      },
   ],
});
const run = (n: Node, opts?: Parameters<typeof rehypeHighlightBlocks>[0]) => {
   rehypeHighlightBlocks(opts)({ type: "root", children: [n] });
   return n.children![0]!;
};

test("a block with a language gets hljs tokens", () => {
   const c = run(code(["language-ts"], "const x = 1;"));
   expect(c.properties?.className).toEqual(["hljs", "language-ts"]);
   expect(c.children?.some((k) => k.type === "element")).toBe(true);
});

test("plain-text languages, no-highlight and no language stay as they are", () => {
   const mermaid = run(code(["language-mermaid"], "graph TD"), { plainText: ["mermaid"] });
   expect(mermaid.properties?.className).toEqual(["language-mermaid"]);
   expect(mermaid.children).toEqual([{ type: "text", value: "graph TD" }]);
   expect(run(code(["language-ts", "no-highlight"], "x")).children).toHaveLength(1);
   expect(run(code(undefined, "x")).properties?.className).toBeUndefined();
});

test("an unknown language gets the class but no tokens", () => {
   const c = run(code(["language-nope"], "x y"));
   expect(c.properties?.className).toEqual(["hljs", "language-nope"]);
   expect(c.children).toEqual([{ type: "text", value: "x y" }]);
});
