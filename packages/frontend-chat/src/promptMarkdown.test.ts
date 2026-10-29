import { describe, expect, it } from "vitest";
import { createHeadlessEditor } from "@lexical/headless";
import { $convertFromMarkdownString } from "@lexical/markdown";
import { $createCodeNode, $isCodeNode } from "@lexical/code";
import { $createListItemNode, $createListNode, $isListItemNode } from "@lexical/list";
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isParagraphNode,
  $isRangeSelection,
  $isTextNode,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
  type TextNode,
} from "lexical";
import {
  $codeTab,
  $escapeBlock,
  $exitCode,
  $exportMarkdown,
  $indentListItems,
  $insertPlainText,
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
  it("Enter sends in text and lists; in code it makes a newline (or leaves the block)", () => {
    expect(enterAction(ctx({}))).toBe("send");
    expect(enterAction(ctx({ block: "list" }))).toBe("send");
    expect(enterAction(ctx({ block: "code" }))).toBe("code");
  });
  it("Shift+Enter makes a new paragraph / list item, newline in code; never sends", () => {
    expect(enterAction(ctx({ shift: true }))).toBe("paragraph");
    expect(enterAction(ctx({ shift: true, block: "list" }))).toBe("paragraph");
    expect(enterAction(ctx({ shift: true, block: "code" }))).toBe("code");
  });
  it("mod+Enter sends everywhere", () => {
    for (const block of ["text", "list", "code", "fence"] as const) expect(enterAction(ctx({ mod: true, block }))).toBe("send");
  });
  it("menu picks; composing wins over everything", () => {
    expect(enterAction(ctx({ menuOpen: true, mod: true }))).toBe("pick");
    expect(enterAction(ctx({ menuOpen: true, block: "list" }))).toBe("pick");
    expect(enterAction(ctx({ composing: true, menuOpen: true }))).toBe("default");
    expect(enterAction(ctx({ composing: true, mod: true }))).toBe("default");
  });
  it("fence line becomes a code block on Enter and Shift+Enter", () => {
    expect(enterAction(ctx({ block: "fence" }))).toBe("fence");
    expect(enterAction(ctx({ block: "fence", shift: true }))).toBe("fence");
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

/** Editor built from blocks (`p("text")` paragraph, `p()` empty, `ul(...)`, `code(...)`). */
const built = (...blocks: (() => LexicalNode)[]) => {
  const ed = createHeadlessEditor({ nodes: PROMPT_NODES, onError: (e) => { throw e; } });
  ed.update(() => void $getRoot().clear().append(...blocks.map((b) => b())), { discrete: true });
  return ed;
};
const p = (t?: string) => () => $createParagraphNode().append(...(t ? [$createTextNode(t)] : []));
const ul = (...items: string[]) => () => $createListNode("bullet").append(...items.map((t) => $createListItemNode().append($createTextNode(t))));
const kinds = (ed: LexicalEditor) => ed.getEditorState().read(() => $getRoot().getChildren().map((n) => n.getType()));
const caretBlock = (ed: LexicalEditor) =>
  ed.getEditorState().read(() => {
    const sel = $getSelection();
    return $isRangeSelection(sel) ? $getRoot().getChildren().findIndex((n) => n.is(sel.anchor.getNode().getTopLevelElement())) : -1;
  });

describe("export joining", () => {
  it("paragraphs join with a newline; an empty paragraph is a blank line", () => {
    expect(mdOf(built(p("a"), p("b")))).toBe("a\nb");
    expect(mdOf(built(p("a"), p(), p("b")))).toBe("a\n\nb");
    expect(mdOf(built(p("a"), p(), p(), p("b")))).toBe("a\n\n\nb");
  });
  it("lists and code get one blank line around them", () => {
    expect(mdOf(built(p("a"), ul("x", "y")))).toBe("a\n\n- x\n- y");
    expect(mdOf(built(ul("x"), p("b")))).toBe("- x\n\nb");
    expect(mdOf(built(ul("x"), p(), p("b")))).toBe("- x\n\nb");
    expect(mdOf(editorWith("```\nc\n```\n\nafter"))).toBe("```\nc\n```\n\nafter");
    expect(mdOf(built(p("a"), () => $createCodeBlock("c"), p("b")))).toBe("a\n\n```\nc\n```\n\nb");
  });
  it("leading/trailing empty paragraphs are dropped; escapes undone", () => {
    expect(mdOf(built(p(), p("a_b"), p(), p()))).toBe("a_b");
    expect(mdOf(built(p(), p()))).toBe("");
  });
  it("line breaks inside a paragraph (older content) still export", () => {
    const ed = built(() => $createParagraphNode().append($createTextNode("a"), $createLineBreakNode(), $createTextNode("b")));
    expect(mdOf(ed).replace(/ +\n/, "\n")).toBe("a\nb");
  });
});

/** A code block with `text` (lines split into line breaks). */
function $createCodeBlock(text: string, lang?: string) {
  const code = $createCodeNode(lang);
  text.split("\n").forEach((line, i) => {
    if (i) code.append($createLineBreakNode());
    if (line) code.append($createTextNode(line));
  });
  return code;
}

describe("paste", () => {
  it("each pasted line becomes a paragraph", () => {
    const ed = built(p("start "));
    at(ed, "start", () => $insertPlainText("one\r\n\ntwo"), 6);
    expect(kinds(ed)).toEqual(["paragraph", "paragraph", "paragraph"]);
    expect(mdOf(ed)).toBe("start one\n\ntwo");
  });
  it("in a code block lines stay inside the block", () => {
    const ed = built(() => $createCodeBlock("x"));
    at(ed, "x", () => $insertPlainText("a\nb"), 1);
    expect(mdOf(ed)).toBe("```\nxa\nb\n```");
  });
});

describe("code block escape", () => {
  const codeEd = (text: string, after = false) => built(...(after ? [p("before")] : []), () => $createCodeBlock(text));
  it("ArrowDown on the last line / ArrowRight at the end of a last code block adds a paragraph after", () => {
    for (const key of ["down", "right"] as const) {
      const ed = codeEd("l1\nl2");
      let r = false;
      at(ed, "l2", () => (r = $escapeBlock(key)), 2);
      expect(r).toBe(true);
      expect(kinds(ed)).toEqual(["code", "paragraph"]);
      expect(caretBlock(ed)).toBe(1);
    }
    const ed = codeEd("l1\nl2");
    let r = true;
    at(ed, "l1", () => (r = $escapeBlock("down")), 1);
    expect(r).toBe(false);
    at(ed, "l2", () => (r = $escapeBlock("right")), 1);
    expect(r).toBe(false);
    expect(kinds(ed)).toEqual(["code"]);
  });
  it("ArrowUp on the first line / ArrowLeft at the start of a first code block adds a paragraph before", () => {
    for (const key of ["up", "left"] as const) {
      const ed = codeEd("l1\nl2");
      let r = false;
      at(ed, "l1", () => (r = $escapeBlock(key)), 0);
      expect(r).toBe(true);
      expect(kinds(ed)).toEqual(["paragraph", "code"]);
      expect(caretBlock(ed)).toBe(0);
    }
    const ed = codeEd("l1\nl2");
    let r = true;
    at(ed, "l2", () => (r = $escapeBlock("up")), 0);
    expect(r).toBe(false);
  });
  it("does nothing when another block is on that side", () => {
    const ed = codeEd("l1", true);
    let r = true;
    at(ed, "l1", () => (r = $escapeBlock("up")), 0);
    expect(r).toBe(false);
    at(ed, "l1", () => (r = $escapeBlock("down")), 2);
    expect(r).toBe(true);
  });
  it("lists escape only from the very end of the last item / start of the first", () => {
    const ed = built(ul("a", "b"));
    let r = true;
    at(ed, "a", () => (r = $escapeBlock("down")), 1);
    expect(r).toBe(false);
    at(ed, "b", () => (r = $escapeBlock("down")), 0);
    expect(r).toBe(false);
    at(ed, "b", () => (r = $escapeBlock("down")), 1);
    expect(r).toBe(true);
    expect(kinds(ed)).toEqual(["list", "paragraph"]);
    at(ed, "a", () => (r = $escapeBlock("up")), 0);
    expect(r).toBe(true);
    expect(kinds(ed)).toEqual(["paragraph", "list", "paragraph"]);
  });
  it("paragraphs never escape", () => {
    const ed = built(p("x"));
    let r = true;
    at(ed, "x", () => (r = $escapeBlock("down")), 1);
    expect(r).toBe(false);
  });

  const atCodeEnd = (ed: LexicalEditor, fn: () => void) =>
    ed.update(() => {
      $getRoot().getChildren().find($isCodeNode)!.selectEnd();
      fn();
    }, { discrete: true });
  it("Enter after two empty last lines leaves the block and drops them", () => {
    const ed = codeEd("x\n\n");
    let r = false;
    atCodeEnd(ed, () => (r = $exitCode()));
    expect(r).toBe(true);
    expect(kinds(ed)).toEqual(["code", "paragraph"]);
    expect(caretBlock(ed)).toBe(1);
    expect(mdOf(ed)).toBe("```\nx\n```");
  });
  it("only after two empty lines, at the end", () => {
    let r = true;
    const one = codeEd("x\n");
    atCodeEnd(one, () => (r = $exitCode()));
    expect(r).toBe(false);
    const mid = codeEd("x\n\ny");
    at(mid, "x", () => (r = $exitCode()), 1);
    expect(r).toBe(false);
  });
  it("an emptied code block becomes the paragraph", () => {
    const ed = codeEd("\n");
    let r = false;
    atCodeEnd(ed, () => (r = $exitCode()));
    expect(r).toBe(true);
    expect(kinds(ed)).toEqual(["paragraph"]);
  });
  it("Backspace at the start of an empty code block turns it into a paragraph (Lexical's collapseAtStart)", () => {
    const ed = built(() => $createCodeNode());
    // deleteCharacter needs a DOM window; at offset 0 it calls the block's collapseAtStart.
    ed.update(() => void ($getRoot().getFirstChildOrThrow() as ElementNode).collapseAtStart($createRangeSelection()), { discrete: true });
    expect(ed.getEditorState().read(() => $isParagraphNode($getRoot().getFirstChild()))).toBe(true);
  });
});
