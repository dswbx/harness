import { $isCodeNode, CodeHighlightNode, CodeNode } from "@lexical/code";
import { LinkNode } from "@lexical/link";
import { $isListItemNode, $isListNode, ListItemNode, ListNode } from "@lexical/list";
import {
  $convertToMarkdownString,
  BOLD_ITALIC_STAR,
  BOLD_ITALIC_UNDERSCORE,
  BOLD_STAR,
  BOLD_UNDERSCORE,
  CODE,
  INLINE_CODE,
  ITALIC_STAR,
  ITALIC_UNDERSCORE,
  LINK,
  ORDERED_LIST,
  STRIKETHROUGH,
  UNORDERED_LIST,
  type Transformer,
} from "@lexical/markdown";
import {
  $createParagraphNode,
  $getRoot,
  $getSelection,
  $isLineBreakNode,
  $isParagraphNode,
  $isRangeSelection,
  $isTabNode,
  $isTextNode,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
  type PointType,
  type SerializedEditorState,
} from "lexical";

export const PROMPT_NODES = [ListNode, ListItemNode, CodeNode, CodeHighlightNode, LinkNode];

export const PROMPT_TRANSFORMERS: Transformer[] = [
  UNORDERED_LIST,
  ORDERED_LIST,
  CODE,
  INLINE_CODE,
  BOLD_ITALIC_STAR,
  BOLD_ITALIC_UNDERSCORE,
  BOLD_STAR,
  BOLD_UNDERSCORE,
  ITALIC_STAR,
  ITALIC_UNDERSCORE,
  STRIKETHROUGH,
  LINK,
];

/** Markdown of one top-level block. `$convertToMarkdownString(…, node)` exports `node.getChildren()` as top-level blocks, so hand it a one-child stand-in. */
const $blockMarkdown = (n: LexicalNode) =>
  $convertToMarkdownString(PROMPT_TRANSFORMERS, { getChildren: () => [n] } as unknown as ElementNode, false);

/**
 * Markdown of the editor's content, escapes undone outside code (call inside read/update). Each line the user typed is
 * its own paragraph: paragraphs join with "\n", an empty paragraph is a blank line. Lists and code blocks get a blank
 * line around them, so a paragraph after a list is not read as part of the last item.
 */
export function $exportMarkdown(): string {
  const lines: string[] = [];
  let prev: "text" | "block" | "empty" | null = null;
  for (const n of $getRoot().getChildren()) {
    const md = $blockMarkdown(n);
    const kind = !$isParagraphNode(n) ? "block" : md.trim() ? "text" : "empty";
    if (kind === "empty") {
      if (prev) lines.push("");
    } else {
      if (prev && prev !== "empty" && (prev === "block" || kind === "block")) lines.push("");
      lines.push(md);
    }
    if (prev || kind !== "empty") prev = kind;
  }
  while (lines.at(-1) === "") lines.pop();
  return unescapeMarkdown(lines.join("\n"));
}

/** Paste plain text: each line becomes its own block (paragraph / list item); in a code block lines stay line breaks. */
export function $insertPlainText(text: string) {
  const sel = $getSelection();
  if (!$isRangeSelection(sel)) return;
  text = text.replace(/\r\n?/g, "\n");
  if ($inCode(sel.anchor.getNode())) return void sel.insertRawText(text);
  for (const [i, line] of text.split("\n").entries()) {
    const s = $getSelection();
    if (!$isRangeSelection(s)) return;
    if (i) s.insertParagraph();
    if (line) $getSelection()?.insertText(line);
  }
}

const $inCode = (n: LexicalNode) => [n, ...n.getParents()].some($isCodeNode);

/** Caret offset of `pt` within the text of `block` (whose children are leaves, as in a code block), or null. */
function $offsetIn(block: ElementNode, pt: PointType): number | null {
  const node = pt.getNode();
  if (node.is(block)) return block.getChildren().slice(0, pt.offset).reduce((a, c) => a + c.getTextContentSize(), 0);
  if (!node.getParent()?.is(block)) return null;
  let off = pt.type === "text" ? pt.offset : 0;
  for (let p = node.getPreviousSibling(); p; p = p.getPreviousSibling()) off += p.getTextContentSize();
  return off;
}

/** Collapsed caret's top-level block and the caret's text offset in it (flat blocks only: code; else offset null). */
function $caret() {
  const sel = $getSelection();
  if (!$isRangeSelection(sel) || !sel.isCollapsed()) return null;
  const top = sel.anchor.getNode().getTopLevelElement();
  if (!top) return null;
  return { sel, top, off: $isCodeNode(top) ? $offsetIn(top, sel.anchor) : null };
}

export type EscapeKey = "up" | "down" | "left" | "right";

/**
 * Leave a code block (or list) that is the first/last block: ArrowDown on its last line / ArrowRight at its end adds an
 * empty paragraph after it; ArrowUp on the first line / ArrowLeft at the start adds one before it. Caret moves there.
 * Lists only escape with the caret at the very end of the last item (down/right) or start of the first (up/left).
 * Returns whether it did.
 */
export function $escapeBlock(key: EscapeKey): boolean {
  const c = $caret();
  if (!c) return false;
  const { sel, top, off } = c;
  const after = key === "down" || key === "right";
  if (after ? top.getNextSibling() : top.getPreviousSibling()) return false;
  if ($isCodeNode(top)) {
    if (off === null) return false;
    const text = top.getTextContent();
    const ok = { up: !text.slice(0, off).includes("\n"), down: !text.slice(off).includes("\n"), left: off === 0, right: off === text.length }[key];
    if (!ok) return false;
  } else if ($isListNode(top)) {
    // Leaf at the list's edge: first/last text (nested items included), or an empty item itself.
    const edge = after ? top.getLastDescendant() : top.getFirstDescendant();
    const a = sel.anchor;
    const atEdge = $isTextNode(edge)
      ? a.type === "text" && a.key === edge.getKey() && a.offset === (after ? edge.getTextContentSize() : 0)
      : $isListItemNode(edge) && a.type === "element" && a.key === edge.getKey();
    if (!atEdge) return false;
  } else return false;
  const para = $createParagraphNode();
  if (after) top.insertAfter(para);
  else top.insertBefore(para);
  para.select();
  return true;
}

/**
 * Enter/Shift+Enter at the end of a code block whose last two lines are empty (Enter pressed 3 times): drop those empty
 * lines and move to a new paragraph after the block (an emptied block becomes that paragraph). Returns whether it did.
 */
export function $exitCode(): boolean {
  const c = $caret();
  if (!c || !$isCodeNode(c.top) || c.off === null) return false;
  const { top: code, off } = c;
  const text = code.getTextContent();
  if (off !== text.length || !(text.endsWith("\n\n") || text === "\n")) return false;
  for (let i = 0; i < 2 && $isLineBreakNode(code.getLastChild()); i++) code.getLastChild()!.remove();
  const para = $createParagraphNode();
  if (code.getTextContentSize() === 0) code.replace(para);
  else code.insertAfter(para);
  para.select();
  return true;
}

export const MAX_LIST_DEPTH = 5;

/** Indent (+1) / outdent (-1) the list items in the selection (nesting, max MAX_LIST_DEPTH levels). Other blocks never indent. */
export function $indentListItems(delta: 1 | -1) {
  const sel = $getSelection();
  if (!$isRangeSelection(sel)) return;
  const items = new Map<string, ListItemNode>();
  for (const n of sel.getNodes()) {
    const li = [n, ...n.getParents()].find((x): x is ListItemNode => $isListItemNode(x) && !$isListNode(x.getFirstChild()));
    if (li) items.set(li.getKey(), li);
  }
  for (const li of items.values()) {
    const next = li.getIndent() + delta;
    if (next >= 0 && next < MAX_LIST_DEPTH) li.setIndent(next);
  }
}

/** Tab in a code block: insert a tab. Shift+Tab: drop a leading tab (or up to 2 spaces) from the caret's line. */
export function $codeTab(shift: boolean) {
  const sel = $getSelection();
  if (!$isRangeSelection(sel)) return;
  if (!shift) return void sel.insertRawText("\t");
  const a = sel.anchor;
  let node: LexicalNode | null = a.getNode();
  let off = a.offset;
  if (a.type === "element") {
    const prev = a.offset > 0 ? a.getNode().getChildAtIndex(a.offset - 1) : null;
    [node, off] = prev && !$isLineBreakNode(prev) ? [prev, prev.getTextContentSize()] : [a.getNode().getChildAtIndex(a.offset), 0];
  }
  // Walk back to the line start; code text may hold "\n" itself or be split by LineBreakNodes.
  while (node) {
    const i = node.getTextContent().lastIndexOf("\n", off - 1);
    if (i >= 0 && off > 0) { off = i + 1; break; }
    const prev: LexicalNode | null = node.getPreviousSibling();
    if (!prev || $isLineBreakNode(prev)) { off = 0; break; }
    [node, off] = [prev, prev.getTextContentSize()];
  }
  if (node && off >= node.getTextContentSize()) [node, off] = [node.getNextSibling(), 0];
  if (!node || $isLineBreakNode(node)) return;
  if ($isTabNode(node)) return void node.remove();
  if (!$isTextNode(node)) return;
  const k = node.getTextContent()[off] === "\t" ? 1 : Math.min(2, /^ */.exec(node.getTextContent().slice(off))![0].length);
  if (!k) return;
  const key = node.getKey();
  const fix = [a, sel.focus].filter((pt) => pt.type === "text" && pt.key === key && pt.offset > off).map((pt) => [pt, pt.offset] as const);
  node.spliceText(off, k, "");
  for (const [pt, o] of fix) pt.set(key, o - Math.min(k, o - off), "text");
}

/** Exact editor content, to put back after a failed send (no Markdown re-parse, so literal `2*3*4` stays literal). */
export type PromptSnapshot = SerializedEditorState;
export const snapshot = (editor: LexicalEditor): PromptSnapshot => editor.getEditorState().toJSON();
/** Put `s` back only if the editor is empty. Returns whether it did. */
export function restoreSnapshot(editor: LexicalEditor, s: PromptSnapshot): boolean {
  if (editor.getEditorState().read(() => $getRoot().getTextContent().trim())) return false;
  editor.setEditorState(editor.parseEditorState(s));
  return true;
}

export type EnterCtx = { menuOpen: boolean; composing: boolean; shift: boolean; mod: boolean; block: "list" | "code" | "fence" | "text" };
/**
 * "paragraph": new paragraph / list item (INSERT_PARAGRAPH). "code": leave the block if at its end after 2 empty lines
 * ($exitCode), else editor default (newline). "fence": turn the ``` line into a code block.
 */
export type EnterAction = "pick" | "send" | "fence" | "paragraph" | "code" | "default";

/** What Enter does. Enter sends in text and lists, Shift+Enter makes a new line (block); in code both make a newline. */
export function enterAction({ menuOpen, composing, shift, mod, block }: EnterCtx): EnterAction {
  if (composing) return "default";
  if (menuOpen) return "pick";
  if (mod) return "send";
  if (block === "fence") return "fence";
  if (block === "code") return "code";
  return shift ? "paragraph" : "send";
}

/** Language of a ``` fence line ("" if none), or null if the line is not a fence. */
export function fenceLanguage(line: string): string | null {
  const m = /^[ \t]*```([\w-]*)[ \t]*$/.exec(line);
  return m ? m[1]! : null;
}

export const lineCount = (s: string) => (s ? s.split("\n").length : 0);

/**
 * Lexical escapes `*_\`~\\` in plain text on export (`a_b` → `a\_b`). Prompts go to an Agent, so undo that
 * outside code: fenced blocks and inline code spans stay verbatim.
 */
export function unescapeMarkdown(md: string): string {
  let out = "";
  let fence: string | null = null;
  for (const [i, line] of md.split("\n").entries()) {
    if (i) out += "\n";
    if (fence) {
      if (line === fence) fence = null;
      out += line;
      continue;
    }
    const open = /^`{3,}/.exec(line);
    if (open) {
      fence = open[0];
      out += line;
      continue;
    }
    for (let j = 0; j < line.length; ) {
      const c = line[j]!;
      if (c === "\\" && /[*_`~\\]/.test(line[j + 1] ?? "")) {
        out += line[j + 1];
        j += 2;
      } else if (c === "`") {
        const run = /^`+/.exec(line.slice(j))![0];
        const end = line.indexOf(run, j + run.length);
        const stop = end < 0 ? j + run.length : end + run.length;
        out += line.slice(j, stop);
        j = stop;
      } else {
        out += c;
        j++;
      }
    }
  }
  return out;
}
