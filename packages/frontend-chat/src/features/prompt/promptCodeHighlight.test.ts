import { $createCodeNode, $isCodeHighlightNode, $isCodeNode, type CodeNode } from "@lexical/code";
import { createHeadlessEditor } from "@lexical/headless";
import { $createTextNode, $getRoot, $getSelection, $isRangeSelection } from "lexical";
import { describe, expect, it } from "vitest";
import { codeLeaves, registerCodeHighlight } from "./promptCodeHighlight";
import { $exportMarkdown, PROMPT_NODES } from "./promptMarkdown";

const editorWith = (text: string, language: string | null = "rust") => {
   const editor = createHeadlessEditor({
      nodes: PROMPT_NODES,
      onError: (e) => {
         throw e;
      },
   });
   registerCodeHighlight(editor);
   editor.update(
      () => {
         const code = $createCodeNode(language);
         code.append($createTextNode(text));
         $getRoot().clear().append(code);
      },
      { discrete: true },
   );
   return editor;
};
const code = () => $getRoot().getFirstChild() as CodeNode;
/** The block's token text and classes. */
const tokens = (editor: ReturnType<typeof editorWith>) =>
   editor.getEditorState().read(() =>
      code()
         .getChildren()
         .map((k) => [
            k.getTextContent(),
            $isCodeHighlightNode(k) ? (k.getHighlightType() ?? null) : k.getType(),
         ]),
   );

describe("codeLeaves", () => {
   it("gives a known language its highlight.js classes", () => {
      expect(codeLeaves("pub fn a()", "rust")).toContainEqual({
         text: "fn",
         type: "hljs-keyword",
      });
   });

   it("leaves no language or an unknown one plain", () => {
      expect(codeLeaves("pub fn", null)).toEqual([{ text: "pub fn" }]);
      expect(codeLeaves("graph TD", "mermaid")).toEqual([{ text: "graph TD" }]);
   });

   it("splits line breaks and tabs out", () => {
      expect(codeLeaves("a\n\tb", null)).toEqual([{ text: "a" }, "\n", "\t", { text: "b" }]);
   });
});

describe("registerCodeHighlight", () => {
   it("colors a code block and keeps its text", () => {
      const editor = editorWith("pub fn what()\n\tlet a = 1;");
      expect(tokens(editor)).toContainEqual(["fn", "hljs-keyword"]);
      expect(tokens(editor)).toContainEqual(["\n", "linebreak"]);
      expect(tokens(editor)).toContainEqual(["\t", "tab"]);
      expect(editor.getEditorState().read(() => code().getTextContent())).toBe(
         "pub fn what()\n\tlet a = 1;",
      );
   });

   it("exports the same Markdown", () => {
      const editor = editorWith("pub fn what()");
      expect(editor.getEditorState().read($exportMarkdown)).toBe("```rust\npub fn what()\n```");
   });

   it("colors again after an edit and keeps the caret offset", () => {
      const editor = editorWith("pu");
      editor.update(
         () => {
            code().selectEnd();
            const sel = $getSelection();
            if ($isRangeSelection(sel)) sel.insertText("b fn");
         },
         { discrete: true },
      );
      expect(tokens(editor)).toContainEqual(["pub", "hljs-keyword"]);
      expect(tokens(editor)).toContainEqual(["fn", "hljs-keyword"]);
      editor.getEditorState().read(() => {
         const sel = $getSelection();
         if (!$isRangeSelection(sel)) throw new Error("no selection");
         expect(sel.isCollapsed()).toBe(true);
         expect(sel.anchor.getNode().getTextContent()).toBe("fn");
         expect(sel.anchor.offset).toBe(2);
      });
   });

   it("keeps unchanged tokens as the same nodes", () => {
      const editor = editorWith("pub fn");
      const keys = () =>
         editor.getEditorState().read(() =>
            code()
               .getChildren()
               .map((k) => k.getKey()),
         );
      const before = keys();
      editor.update(
         () => {
            code().selectEnd();
            const sel = $getSelection();
            if ($isRangeSelection(sel)) sel.insertText(" ");
         },
         { discrete: true },
      );
      expect(keys()[0]).toBe(before[0]);
   });

   it("keeps a block with no language plain", () => {
      const editor = editorWith("pub fn", null);
      expect(tokens(editor)).toEqual([["pub fn", null]]);
      expect(editor.getEditorState().read(() => $isCodeNode(code()))).toBe(true);
   });
});
