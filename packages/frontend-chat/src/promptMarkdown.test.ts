import { describe, expect, it } from "vitest";
import { createHeadlessEditor } from "@lexical/headless";
import { $convertFromMarkdownString, $convertToMarkdownString } from "@lexical/markdown";
import { PROMPT_NODES, PROMPT_TRANSFORMERS, enterAction, fenceLanguage, lineCount, unescapeMarkdown, type EnterCtx } from "./promptMarkdown";

const roundTrip = (md: string) => {
  const editor = createHeadlessEditor({ nodes: PROMPT_NODES, onError: (e) => { throw e; } });
  editor.update(() => $convertFromMarkdownString(md, PROMPT_TRANSFORMERS, undefined, true), { discrete: true });
  return editor.getEditorState().read(() => ({ md: unescapeMarkdown($convertToMarkdownString(PROMPT_TRANSFORMERS, undefined, true)) }));
};

describe("enterAction", () => {
  const ctx = (o: Partial<EnterCtx>): EnterCtx => ({ menuOpen: false, composing: false, shift: false, mod: false, block: "text", ...o });
  it("plain Enter sends in text, keeps editor behavior in list/code", () => {
    expect(enterAction(ctx({}))).toBe("send");
    expect(enterAction(ctx({ block: "list" }))).toBe("default");
    expect(enterAction(ctx({ block: "code" }))).toBe("default");
  });
  it("mod+Enter sends everywhere; Shift+Enter never sends", () => {
    expect(enterAction(ctx({ mod: true, block: "code" }))).toBe("send");
    expect(enterAction(ctx({ mod: true, block: "list" }))).toBe("send");
    expect(enterAction(ctx({ shift: true }))).toBe("default");
  });
  it("menu picks; composing wins over everything", () => {
    expect(enterAction(ctx({ menuOpen: true, mod: true }))).toBe("pick");
    expect(enterAction(ctx({ composing: true, menuOpen: true }))).toBe("default");
    expect(enterAction(ctx({ composing: true, mod: true }))).toBe("default");
  });
  it("fence line becomes a code block", () => {
    expect(enterAction(ctx({ block: "fence" }))).toBe("fence");
    expect(enterAction(ctx({ block: "fence", mod: true }))).toBe("send");
  });
});

describe("fenceLanguage", () => {
  it("parses fences", () => {
    expect(fenceLanguage("```")).toBe("");
    expect(fenceLanguage("```ts")).toBe("ts");
    expect(fenceLanguage("  ```shell-session ")).toBe("shell-session");
    expect(fenceLanguage("```ts x")).toBeNull();
    expect(fenceLanguage("hi")).toBeNull();
  });
});

describe("lineCount", () => {
  it("counts \\n-separated lines", () => {
    expect(lineCount("")).toBe(0);
    expect(lineCount("a")).toBe(1);
    expect(lineCount("a\n\nb")).toBe(3);
  });
});

describe("markdown round trip", () => {
  it.each([
    "hello **bold** and *italic* and `code` and ~~gone~~",
    "- one\n- two",
    "1. one\n2. two",
    "```ts\nconst a = 1;\n\nconst b = 2;\n```",
    "```\nno lang\n```",
    "see [docs](https://example.com)",
    "line one\nline two\n\nafter blank",
  ])("%s", (md) => {
    expect(roundTrip(md).md).toBe(md);
  });
  it("plain text keeps slash commands and special chars", () => {
    expect(roundTrip("/review a_b_c 2*3 ~x a\\b").md).toBe("/review a_b_c 2*3 ~x a\\b");
  });
  it("code keeps its text verbatim", () => {
    expect(roundTrip("`a_b` and a_b").md).toBe("`a_b` and a_b");
    expect(roundTrip("```\nx\\_y *z*\n```").md).toBe("```\nx\\_y *z*\n```");
  });
});

describe("unescapeMarkdown", () => {
  it("drops escapes outside code only", () => {
    expect(unescapeMarkdown("a\\_b \\*c\\* `d\\_e` \\")).toBe("a_b *c* `d\\_e` \\");
    expect(unescapeMarkdown("```ts\na\\_b\n```\nc\\_d")).toBe("```ts\na\\_b\n```\nc_d");
    expect(unescapeMarkdown("\\` not code `x\\_y`")).toBe("` not code `x\\_y`");
  });
});
