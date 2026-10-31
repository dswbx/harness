import { describe, expect, it } from "vitest";
import { collectArtifacts, filterArtifacts, markdownArtifacts } from "./artifacts";
import type { Item } from "./reducer";
import type { RenderUiInput } from "./tools";

const user = (id: string, text: string): Item => ({ type: "user", id, text, ts: 0, attachments: [], context: null });
const agent = (id: string, text: string): Item => ({ type: "agent", id, text, ts: 1 });
const ui = (id: string, value: RenderUiInput): Item => ({ type: "frontend_tool", id, ts: 2, tool: "render_ui", callId: id, path: "p", input: value, files: {}, render: { ok: true, value } });
const md = (text: string) => ({ type: "Markdown" as const, props: { text } });

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
    expect(markdownArtifacts(text).map(({ kind, title, sub, index }) => ({ kind, title, sub, index }))).toEqual([
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
      ui("f4", { root: { type: "PullRequest", props: { repo: "o/r", number: 8, title: "Fix", state: "open" } } }),
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
    const list = collectArtifacts([agent("a", "| Route | ms |\n|---|---|\n| /search | 9 |"), ui("f", { root: md("Hello") })]);
    expect(filterArtifacts(list, "table", "").length).toBe(1);
    expect(filterArtifacts(list, "all", "SEARCH").map((a) => a.kind)).toEqual(["table"]);
    expect(filterArtifacts(list, "ui", "search")).toEqual([]);
  });
});
