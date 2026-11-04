import {
   $createCodeHighlightNode,
   $isCodeHighlightNode,
   $isCodeNode,
   CodeHighlightNode,
   CodeNode,
} from "@lexical/code";
import {
   $createLineBreakNode,
   $createTabNode,
   $getEditor,
   $getSelection,
   $isLineBreakNode,
   $isRangeSelection,
   $isTabNode,
   $isTextNode,
   type LexicalEditor,
   type LexicalNode,
   type PointType,
   TextNode,
} from "lexical";
import { lowlight } from "./inlineCode";
import { $offsetIn } from "./promptMarkdown";

/** Larger code blocks stay plain: they are highlighted again on each key press. */
const MAX_CHARS = 20_000;

/** One child of a highlighted code block. `type`: its highlight.js classes (the code theme colors them). */
type Leaf = "\n" | "\t" | { text: string; type?: string };

type HastNode = {
   type: string;
   value?: string;
   properties?: { className?: string[] };
   children?: HastNode[];
};

/** `code` as colored text runs. No language, or one highlight.js does not know: one plain run. */
export function codeLeaves(code: string, language: string | null | undefined): Leaf[] {
   const runs: { text: string; type?: string }[] = [];
   const add = (text: string, type?: string) => {
      const last = runs.at(-1);
      if (last && last.type === type) last.text += text;
      else runs.push({ text, type });
   };
   // Nested tokens take the innermost class.
   const walk = (n: HastNode, type?: string) => {
      if (n.type === "text") return add(n.value ?? "", type);
      const own = n.properties?.className?.join(" ") || type;
      for (const c of n.children ?? []) walk(c, own);
   };
   if (language && code.length <= MAX_CHARS && lowlight.registered(language))
      walk(lowlight.highlight(language, code));
   else add(code);
   return runs.flatMap(({ text, type }) =>
      text
         .split(/(\n|\t)/)
         .filter(Boolean)
         .map((part) => (part === "\n" || part === "\t" ? part : { text: part, type })),
   );
}

function $isLeaf(node: LexicalNode, leaf: Leaf) {
   if (leaf === "\n") return $isLineBreakNode(node);
   if (leaf === "\t") return $isTabNode(node);
   return (
      $isCodeHighlightNode(node) &&
      node.getTextContent() === leaf.text &&
      (node.getHighlightType() ?? undefined) === leaf.type
   );
}

function $createLeaf(leaf: Leaf) {
   if (leaf === "\n") return $createLineBreakNode();
   if (leaf === "\t") return $createTabNode();
   return $createCodeHighlightNode(leaf.text, leaf.type);
}

/** Put `pt` at text offset `off` of `code`. */
function $setPoint(pt: PointType, code: CodeNode, off: number) {
   const kids = code.getChildren();
   for (const [i, kid] of kids.entries()) {
      if ($isTextNode(kid) && off <= kid.getTextContentSize())
         return pt.set(kid.getKey(), off, "text");
      if ($isLineBreakNode(kid) && off === 0) return pt.set(code.getKey(), i, "element");
      off -= kid.getTextContentSize();
   }
   pt.set(code.getKey(), kids.length, "element");
}

/** Make the children of `code` its colored runs; the caret keeps its text offset. Does nothing when they already are. */
function $highlight(code: CodeNode) {
   // Replacing nodes during IME composition would break it; the update that ends it comes back here.
   if ($getEditor().isComposing()) return;
   const kids = code.getChildren();
   const plain = (k: LexicalNode) =>
      $isLineBreakNode(k) || $isTabNode(k) || $isCodeHighlightNode(k) || k.getType() === "text";
   if (!kids.every(plain)) return;
   const leaves = codeLeaves(code.getTextContent(), code.getLanguage());
   // Keep the unchanged start and end, so only the edited tokens are redrawn.
   const max = Math.min(kids.length, leaves.length);
   let start = 0;
   while (start < max && $isLeaf(kids[start]!, leaves[start]!)) start++;
   if (start === kids.length && start === leaves.length) return;
   let end = 0;
   while (
      end < max - start &&
      $isLeaf(kids[kids.length - 1 - end]!, leaves[leaves.length - 1 - end]!)
   )
      end++;
   const sel = $getSelection();
   const points = $isRangeSelection(sel)
      ? [sel.anchor, sel.focus].flatMap((pt) => {
           const off = $offsetIn(code, pt);
           return off === null ? [] : [[pt, off] as const];
        })
      : [];
   code.splice(
      start,
      kids.length - start - end,
      leaves.slice(start, leaves.length - end).map($createLeaf),
   );
   for (const [pt, off] of points) $setPoint(pt, code, off);
}

/** Color code blocks with highlight.js tokens, like message code blocks. Returns the unregister function. */
export function registerCodeHighlight(editor: LexicalEditor) {
   const viaParent = (node: LexicalNode) => {
      const parent = node.getParent();
      if ($isCodeNode(parent)) $highlight(parent);
   };
   const offs = [
      editor.registerNodeTransform(CodeNode, $highlight),
      editor.registerNodeTransform(TextNode, viaParent),
      editor.registerNodeTransform(CodeHighlightNode, viaParent),
   ];
   return () => offs.forEach((off) => off());
}
