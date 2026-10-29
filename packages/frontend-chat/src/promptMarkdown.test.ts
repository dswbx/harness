import { describe, expect, it } from "vitest";
import { createHeadlessEditor } from "@lexical/headless";
import { $convertFromMarkdownString } from "@lexical/markdown";
import { $isListItemNode } from "@lexical/list";
import { $createParagraphNode, $createTextNode, $getRoot, $isTextNode, type ElementNode, type LexicalEditor, type TextNode } from "lexical";
import {
  $codeTab,
  $exportMarkdown,
  $indentListItems,
  MAX_LIST_DEPTH,
  PROMPT_NODES,
  PROMPT_TRANSFORMERS,
  enterAction,
  fenceLanguage,
  lineCount,
  restoreSnapshot,
  snapshot,
  unescapeMarkdown,
  type EnterCtx,
} from "./promptMarkdown";

const editorWith = (md: string) => {
  const editor = createHeadlessEditor({ nodes: PROMPT_NODES, onError: (e) => { throw e; } });
  editor.update(() => $convertFromMarkdownString(md, PROMPT_TRANSFORMERS, undefined, true), { discrete: true });
  return editor;
};
const mdOf = (editor: LexicalEditor) => editor.getEditorState().read($exportMarkdown);
const roundTrip = (md: string) => ({ md: mdOf(editorWith(md)) });
/** Run `fn` with the caret in the first text node containing `needle`. */
const at = (editor: LexicalEditor, needle: string, fn: () => void, offset = 0) =>
  editor.update(() => {
    const t = $getRoot().getAllTextNodes().find((n) => n.getTextContent().includes(needle))!;
    t.select(offset, offset);
    fn();
  }, { discrete: true });

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
    "line one\n\nafter blank",
    "- a\n    - b\n        - c\n- d",
    "1. a\n    1. b\n2. c",
  ])("%s", (md) => {
    expect(roundTrip(md).md).toBe(md);
  });
  it("plain text keeps slash commands and special chars", () => {
    expect(roundTrip("/review a_b_c 2*3 ~x a\\b").md).toBe("/review a_b_c 2*3 ~x a\\b");
  });
  it("blocks are split by a blank line, so text after a list or code block stays out of it", () => {
    const editor = createHeadlessEditor({ nodes: PROMPT_NODES, onError: (e) => { throw e; } });
    editor.update(() => {
      $convertFromMarkdownString("- a\n    - b", PROMPT_TRANSFORMERS, undefined, true);
      $getRoot().append($createParagraphNode().append($createTextNode("after list")));
    }, { discrete: true });
    expect(mdOf(editor)).toBe("- a\n    - b\n\nafter list");
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

describe("list indent", () => {
  it("Tab nests under the previous item, Shift+Tab outdents; Markdown reflects nesting", () => {
    const ed = editorWith("- a\n- b\n- c");
    at(ed, "b", () => $indentListItems(1));
    expect(mdOf(ed)).toBe("- a\n    - b\n- c");
    expect(roundTrip(mdOf(ed)).md).toBe("- a\n    - b\n- c");
    at(ed, "b", () => $indentListItems(-1));
    expect(mdOf(ed)).toBe("- a\n- b\n- c");
  });
  it("outdent at top level stays a list item; depth is capped", () => {
    const ed = editorWith("- a\n- b");
    at(ed, "a", () => $indentListItems(-1));
    expect(mdOf(ed)).toBe("- a\n- b");
    for (let i = 0; i < MAX_LIST_DEPTH + 3; i++) at(ed, "b", () => $indentListItems(1));
    const depth = ed.getEditorState().read(() => $getRoot().getAllTextNodes().find((n) => n.getTextContent() === "b")!.getParents().find($isListItemNode)!.getIndent());
    expect(depth).toBe(MAX_LIST_DEPTH - 1);
  });
  it("never indents paragraphs", () => {
    const ed = editorWith("plain");
    at(ed, "plain", () => $indentListItems(1));
    expect(ed.getEditorState().read(() => ($getRoot().getFirstChildOrThrow() as ElementNode).getIndent())).toBe(0);
  });
});

describe("code tab", () => {
  it("Tab inserts a tab, Shift+Tab removes it", () => {
    const ed = editorWith("```\nx\n```");
    at(ed, "x", () => $codeTab(false));
    expect(mdOf(ed)).toBe("```\n\tx\n```");
    at(ed, "x", () => $codeTab(true));
    expect(mdOf(ed)).toBe("```\nx\n```");
  });
  it("Shift+Tab strips a leading tab or up to 2 spaces of the caret's line only", () => {
    const ed = editorWith("```\n  a\n   b\n\tc\n```");
    at(ed, "b", () => $codeTab(true), 8);
    expect(mdOf(ed)).toBe("```\n  a\n b\n\tc\n```");
    at(ed, "c", () => $codeTab(true), 1);
    expect(mdOf(ed)).toBe("```\n  a\n b\nc\n```");
  });
});

describe("snapshot restore", () => {
  const literal = () => {
    const ed = createHeadlessEditor({ nodes: PROMPT_NODES, onError: (e) => { throw e; } });
    ed.update(() => void $getRoot().append($createParagraphNode().append($createTextNode("2*3*4 "), $createTextNode("it").toggleFormat("italic"))), { discrete: true });
    return ed;
  };
  const formats = (ed: LexicalEditor) => ed.getEditorState().read(() => $getRoot().getAllTextNodes().filter($isTextNode).map((n: TextNode) => [n.getTextContent(), n.getFormat()]));
  it("literal text exports unescaped, so re-parsing Markdown would turn it into italic", () => {
    const ed = literal();
    expect(mdOf(ed)).toBe("2*3*4 *it*");
    expect(formats(editorWith(mdOf(ed)))).not.toEqual(formats(ed));
  });
  it("restores the exact state, only into an empty editor", () => {
    const ed = literal();
    const before = formats(ed);
    const snap = snapshot(ed);
    ed.update(() => void $getRoot().clear().append($createParagraphNode()), { discrete: true });
    expect(restoreSnapshot(ed, snap)).toBe(true);
    expect(formats(ed)).toEqual(before);
    expect(mdOf(ed)).toBe("2*3*4 *it*");
    ed.update(() => void $getRoot().clear().append($createParagraphNode().append($createTextNode("new"))), { discrete: true });
    expect(restoreSnapshot(ed, snap)).toBe(false);
    expect(mdOf(ed)).toBe("new");
  });
});
