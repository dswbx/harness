import { describe, expect, it } from "vitest";
import { DiffFile } from "@git-diff-view/react";
import { changeCount, hunkLines, splitPatch, unifiedPatch } from "./diff";
import { codeAt } from "./DiffViewer";
import { formatReviewComments, withReviewComments, type DiffComment, type ReviewComment } from "./reviewComments";

const PATCH = `diff --git a/README.md b/README.md
new file mode 100644
index 0000000..f8a3bf8
--- /dev/null
+++ b/README.md
@@ -0,0 +1,2 @@
+# Mock
+A tiny project.
diff --git a/src/hello.ts b/src/hello.ts
index 673a470..812dc14 100644
--- a/src/hello.ts
+++ b/src/hello.ts
@@ -1,3 +1,5 @@
 export function hello() {
-  return "hi";
+  const name = "world";
+  return \`hello \${name}\`;
 }
+export const answer = 42;
diff --git a/src/legacy.ts b/src/legacy.ts
deleted file mode 100644
index c793192..0000000
--- a/src/legacy.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-// old
-export {};
`;

/** What DiffView builds from our `data`; proves git-diff-view parses each section. */
function gitDiffView(f: ReturnType<typeof splitPatch>[number], contents?: { old: string; new: string }) {
  const d = DiffFile.createInstance({
    oldFile: { fileName: f.oldPath, content: contents?.old ?? null },
    newFile: { fileName: f.newPath, content: contents?.new ?? null },
    hunks: [f.text],
  });
  d.initRaw();
  d.buildSplitDiffLines();
  d.buildUnifiedDiffLines();
  return d;
}

describe("splitPatch", () => {
  const files = splitPatch(PATCH);

  it("splits per file with paths, status and counts", () => {
    expect(files.map((f) => [f.path, f.oldPath, f.newPath, f.status, f.additions, f.deletions])).toEqual([
      ["README.md", null, "README.md", "A", 2, 0],
      ["src/hello.ts", "src/hello.ts", "src/hello.ts", "M", 3, 1],
      ["src/legacy.ts", "src/legacy.ts", null, "D", 0, 2],
    ]);
    expect(files.every((f) => f.text.startsWith("diff --git ") && f.text.endsWith("\n"))).toBe(true);
    expect(files.map((f) => f.text).join("")).toBe(PATCH);
  });

  it("gives git-diff-view data it parses to the same line counts", () => {
    for (const f of files) {
      const d = gitDiffView(f);
      expect([d.additionLength, d.deletionLength]).toEqual([f.additions, f.deletions]);
    }
  });

  it("with full contents git-diff-view can expand the collapsed rest", () => {
    const f = splitPatch(unifiedPatch("x.ts", "1\n2\n3\n4\n5\n6\n7\n8\n9\n10", "1\n2\n3\n4\n5\n6\n7\n8\n9\nTEN", 1))[0]!;
    const d = gitDiffView(f, { old: "1\n2\n3\n4\n5\n6\n7\n8\n9\n10", new: "1\n2\n3\n4\n5\n6\n7\n8\n9\nTEN" });
    expect(d.hasSomeLineCollapsed).toBe(true);
    d.onAllExpand("split");
    expect(d.hasExpandSplitAll).toBe(true);
  });

  it("ignores text before the first file", () => {
    expect(splitPatch("")).toEqual([]);
    expect(splitPatch("junk\n" + PATCH)).toHaveLength(3);
  });
});

describe("hunk helpers", () => {
  const hello = splitPatch(PATCH)[1]!;

  it("hunkLines maps line numbers per side", () => {
    const { old, new: nu } = hunkLines(hello.text);
    expect(old.get(2)).toBe('  return "hi";');
    expect(nu.get(2)).toBe('  const name = "world";');
    expect(nu.get(5)).toBe("export const answer = 42;");
    expect(old.get(5)).toBeUndefined();
  });

  it("changeCount counts runs of changed lines", () => {
    expect(changeCount(hello.text)).toBe(2);
    expect(changeCount(splitPatch(PATCH)[0]!.text)).toBe(1);
  });

  it("codeAt prefers full contents, else hunks", () => {
    expect(codeAt(hello, undefined, "new", 3)).toBe("  return `hello ${name}`;");
    expect(codeAt(hello, { old: "a\nb", new: "x\ny\nz" }, "new", 3)).toBe("z");
  });
});

describe("unifiedPatch", () => {
  it("builds hunks with context and correct headers", () => {
    const old = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].join("\n");
    const nu = ["a", "B", "c", "d", "e", "f", "g", "h", "i", "j", "k"].join("\n");
    expect(unifiedPatch("p.txt", old, nu, 1)).toBe(
      "diff --git a/p.txt b/p.txt\n--- a/p.txt\n+++ b/p.txt\n" +
        "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n" +
        "@@ -10,1 +10,2 @@\n j\n+k\n",
    );
  });

  it("marks a new file", () => {
    const p = unifiedPatch("n.ts", null, "x");
    expect(p).toContain("--- /dev/null");
    expect(splitPatch(p)[0]!.status).toBe("A");
    expect(p).toContain("@@ -0,0 +1,1 @@\n+x\n");
  });
});

describe("review comments", () => {
  const c = (o: Partial<DiffComment>): DiffComment => ({ id: "1", path: "src/a.ts", line: 3, side: "new", code: "const x = 1;", text: "Rename x.", ...o });

  it("formats a Review comments section", () => {
    expect(formatReviewComments([c({}), c({ id: "2", path: "b.md", line: 9, side: "old", code: "old line", text: " Why removed?\nKeep it. " })])).toBe(
      "Review comments:\n\n" +
        "src/a.ts:3 (new)\n```\nconst x = 1;\n```\nRename x.\n\n" +
        "b.md:9 (old)\n```\nold line\n```\nWhy removed?\nKeep it.",
    );
  });

  it("quote comments get their own section, after the diff ones", () => {
    const q: ReviewComment = { id: "q", kind: "quote", quote: "Frontend, which until\n\nnow", text: " Why? " };
    expect(formatReviewComments([q])).toBe("Comments on the conversation:\n\n> Frontend, which until\n>\n> now\n\nWhy?");
    expect(formatReviewComments([q, c({})])).toBe(
      "Review comments:\n\nsrc/a.ts:3 (new)\n```\nconst x = 1;\n```\nRename x.\n\n" +
        "Comments on the conversation:\n\n> Frontend, which until\n>\n> now\n\nWhy?",
    );
  });

  it("uses a longer fence when the code has backticks", () => {
    expect(formatReviewComments([c({ code: "s = ```x```" })])).toContain("````\ns = ```x```\n````");
  });

  it("appends to the prompt text, either part optional", () => {
    expect(withReviewComments("Fix these.", [])).toBe("Fix these.");
    expect(withReviewComments("  ", [c({})])).toBe(formatReviewComments([c({})]));
    expect(withReviewComments("Fix these.", [c({})])).toBe("Fix these.\n\n" + formatReviewComments([c({})]));
  });
});
