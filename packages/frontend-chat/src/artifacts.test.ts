import { describe, expect, it } from "vitest";
import {
   blockMarkdown,
   collectArtifacts,
   filterArtifacts,
   groupShared,
   markdownArtifacts,
   markdownTitle,
} from "./artifacts";
import type { Item } from "./reducer";
import { type RenderUiInput, withSourceRoot } from "./tools";

const user = (id: string, text: string): Item => ({
   type: "user",
   id,
   text,
   ts: 0,
   attachments: [],
   context: null,
   from: null,
});
const agent = (id: string, text: string): Item => ({
   type: "agent",
   id,
   text,
   ts: 1,
   parent: null,
});
const ui = (id: string, value: RenderUiInput): Item => ({
   type: "frontend_tool",
   id,
   ts: 2,
   tool: "render_ui",
   callId: id,
   path: "p",
   input: value,
   files: {},
   render: { ok: true, value },
});
const md = (text: string) => ({ type: "Markdown" as const, props: { text } });

describe("markdownTitle", () => {
   const text = "Last runs:\n\n| A |\n| --- |\n| 1 |\n\nFlow:\n\n```mermaid\ngraph TD\n```\n";
   it("finds the title by kind and source", () => {
      expect(markdownTitle(text, "table", "| A |\n| --- |\n| 1 |")).toBe("Last runs");
      expect(markdownTitle(text, "diagram", "graph TD")).toBe("Flow");
   });
   it("has none for unknown source", () => {
      expect(markdownTitle(text, "diagram", "graph LR")).toBeUndefined();
   });
});

describe("markdownArtifacts", () => {
   it("finds mermaid fences and tables, named by the prose before them, skipping other code", () => {
      const text = [
         "The flow:",
         "```mermaid",
         "flowchart TD",
         "  A --> B",
         "```",
         "Last **20** CI runs:",
         "",
         "| Test | Fails |",
         "| --- | ---: |",
         "| pays | 6 |",
         "| refunds | 1 |",
         "",
         "```md",
         "| not | a table |",
         "| --- | --- |",
         "```",
         "```mermaid",
         "---",
         "title: Lifecycle",
         "---",
         "sequenceDiagram",
         "  A->>B: hi",
         "```",
      ].join("\n");
      expect(
         markdownArtifacts(text).map(({ kind, title, sub, index }) => ({
            kind,
            title,
            sub,
            index,
         })),
      ).toEqual([
         { kind: "diagram", title: "The flow", sub: "Mermaid · flowchart", index: 0 },
         { kind: "table", title: "Last 20 CI runs", sub: "Table · 2 columns, 2 rows", index: 0 },
         { kind: "diagram", title: "Lifecycle", sub: "Mermaid · sequence", index: 1 },
      ]);
   });

   it("names a table without prose by its columns", () => {
      expect(markdownArtifacts("| A | B |\n|---|---|\n| 1 | 2 |")[0]?.title).toBe("A, B");
   });
});

describe("collectArtifacts", () => {
   it("keeps one artifact per render_ui id, in place while inline, and drops removed ones", () => {
      const list = collectArtifacts([
         user("u1", "Look at the tests"),
         agent("a1", "Flow:\n```mermaid\ngraph LR\nA-->B\n```"),
         ui("f1", { id: "q", root: { type: "Card", props: { title: "Question 1" } } }),
         ui("f2", { id: "notes", placement: "right", title: "Notes", root: md("n") }),
         user("u2", "Next"),
         ui("f3", { id: "q", root: { type: "Card", props: { title: "Question 2" } } }),
         ui("f4", {
            root: {
               type: "PullRequest",
               props: { repo: "o/r", number: 8, title: "Fix", state: "open" },
            },
         }),
         ui("f5", { id: "notes", remove: true }),
      ]);
      expect(list.map((a) => [a.kind, a.title, a.sub, a.rowId, a.turn])).toEqual([
         ["diagram", "Flow", "Mermaid · graph", "a1", 1],
         ["ui", "Question 2", "Card", "f1", 1],
         ["ui", "o/r #8", "PullRequest · Open", "f4", 2],
      ]);
      expect(list[0]!.prompt).toBe("Look at the tests");
   });

   it("filters by kind and text", () => {
      const list = collectArtifacts([
         agent("a", "| Route | ms |\n|---|---|\n| /search | 9 |"),
         ui("f", { root: md("Hello") }),
      ]);
      expect(filterArtifacts(list, "table", "").length).toBe(1);
      expect(filterArtifacts(list, "all", "SEARCH").map((a) => a.kind)).toEqual(["table"]);
      expect(filterArtifacts(list, "ui", "search")).toEqual([]);
   });

   it("keeps a file-backed panel's file and shows the call as sent, not the reducer's node", () => {
      const input = { id: "p", placement: "right" as const, title: "P", source: "progress.md" };
      const [a] = collectArtifacts([ui("x", withSourceRoot(input))]);
      expect(a!.file).toBe("progress.md");
      expect(JSON.parse(a!.source)).toEqual(input);
      const [s] = collectArtifacts([ui("y", withSourceRoot({ ...input, source: "shared:x-1" }))]);
      expect(s!.shared).toEqual({ id: "x-1" });
      expect(s!.file).toBeUndefined();
   });
});

describe("groupShared (ADR 0024)", () => {
   const items: Item[] = [
      user("u1", "Make a plan"),
      ui("r1", {
         id: "plan",
         placement: "right",
         title: "Plan",
         root: { type: "Shared" as "Markdown", props: { id: "plan-3f9a1c" } },
         source: "shared:plan-3f9a1c",
      }),
      ui("r2", {
         id: "old",
         placement: "right",
         title: "Old",
         root: { type: "Shared" as "Markdown", props: { id: "old-000000" } },
         source: "shared:old-000000",
      }),
      ui("r3", { id: "notes", placement: "right", title: "Notes", root: md("n") }),
   ];

   it("marks items that show a Shared Artifact", () => {
      const a = collectArtifacts(items);
      expect(a.map((x) => x.shared?.id ?? null)).toEqual(["plan-3f9a1c", "old-000000", null]);
   });

   it("puts attached artifacts first (newest attach first) and drops detached ones", () => {
      const { shared, local } = groupShared(collectArtifacts(items), [
         { id: "plan-3f9a1c", ts: 1 },
         { id: "map-a1b2c3", ts: 2 },
      ]);
      expect(shared.map((r) => [r.id, r.artifact?.title ?? null])).toEqual([
         ["map-a1b2c3", null],
         ["plan-3f9a1c", "Plan"],
      ]);
      expect(local.map((a) => a.title)).toEqual(["Notes"]);
   });

   it("lists a shared copy of a message block once, as shared, while it is attached", () => {
      const list = collectArtifacts([
         user("u1", "Runs?"),
         agent("a1", "Runs:\n\n| A |\n| --- |\n| 1 |\n"),
      ]);
      const table = list[0]!;
      expect(blockMarkdown(table)).toBe("| A |\n| --- |\n| 1 |\n");
      const copies = new Map([[table.key, "runs-a1b2c3"]]);
      const attached = groupShared(list, [{ id: "runs-a1b2c3", ts: 1 }], copies);
      expect([attached.local.length, attached.shared.map((r) => r.id)]).toEqual([
         0,
         ["runs-a1b2c3"],
      ]);
      // The View passes copies of attached artifacts only: detached, the block is back.
      expect(groupShared(list, [], new Map()).local).toEqual([table]);
   });
});
