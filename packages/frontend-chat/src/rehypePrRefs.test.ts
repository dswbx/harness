import type { PrRefContext } from "@harness/api";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { expect, it } from "vitest";
import { rehypePrRefs } from "./rehypePrRefs";

type Node = {
   type: string;
   tagName?: string;
   value?: string;
   properties?: Record<string, unknown>;
   children?: Node[];
};

const ctx: PrRefContext = {
   sessionRepo: { owner: "dswbx", name: "harness" },
   knownRepos: [{ repo: { owner: "supabase", name: "spark" }, sessions: 1, score: 1, last_ms: 0 }],
};

/** The chips (`key raw`) in the rendered markdown, and the tree. */
function run(md: string, c: PrRefContext | null = ctx) {
   const p = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkRehype)
      .use(rehypePrRefs, { ctx: c });
   const tree = p.runSync(p.parse(md)) as Node;
   const chips: string[] = [];
   const walk = (n: Node) => {
      if (n.properties?.dataPrRef) chips.push(`${n.properties.dataPrRef} ${n.properties.dataRaw}`);
      n.children?.forEach(walk);
   };
   walk(tree);
   return { chips, tree };
}

it("turns refs in text into chips, keeping the text around them", () => {
   const { chips, tree } = run("Fixed in #23 and supabase/spark#17, see spark#12. C# is fine.");
   expect(chips).toEqual(["supabase/spark#17 supabase/spark#17", "supabase/spark#12 spark#12"]);
   const p = tree.children![0]!;
   expect(p.children!.map((n) => n.value ?? `[${n.properties!.dataRaw}]`).join("")).toBe(
      "Fixed in #23 and [supabase/spark#17], see [spark#12]. C# is fine.",
   );
});

it("skips code spans, code blocks, named links and headings", () => {
   expect(
      run(
         "`spark#23` and\n\n```\nspark#24\n```\n\n[see spark#25](https://x.dev) and\n\n# Title spark#26\n\n**bold spark#27**",
      ).chips,
   ).toEqual(["supabase/spark#27 spark#27"]);
});

it("keeps bare #N as text (list items, steps)", () => {
   expect(run("To settle #3 and #9, see harness#4.").chips).toEqual(["dswbx/harness#4 harness#4"]);
});

it("turns `PR #N` and `PR#N` into a chip for the Session's repo; no Session repo, no chip", () => {
   expect(run("Step #2 is done in PR #5.").chips).toEqual(["dswbx/harness#5 #5"]);
   expect(run("Also PR#6.").chips).toEqual(["dswbx/harness#6 PR#6"]);
   expect(run("PR #5", { ...ctx, sessionRepo: null }).chips).toEqual([]);
});

it("turns PR autolinks into chips; named PR links and other links stay links", () => {
   const url = "https://github.com/supabase/spark/pull/17/files";
   const { chips, tree } = run(
      `${url} and [the PR](https://github.com/o/r/pull/3) and https://github.com/o/r/issues/4`,
   );
   expect(chips).toEqual([`supabase/spark#17 ${url}`]);
   const links: string[] = [];
   const walk = (n: Node) => (
      n.tagName === "a" && links.push(String(n.properties!.href)), n.children?.forEach(walk)
   );
   walk(tree);
   expect(links).toEqual(["https://github.com/o/r/pull/3", "https://github.com/o/r/issues/4"]);
});

it("does nothing without a context", () => {
   expect(run("#23 supabase/spark#17", null).chips).toEqual([]);
   expect(run("#23 o/r#1", { sessionRepo: null, knownRepos: [] }).chips).toEqual(["o/r#1 o/r#1"]);
});
