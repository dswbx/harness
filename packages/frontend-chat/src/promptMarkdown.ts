import { CodeHighlightNode, CodeNode } from "@lexical/code";
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
  $getRoot,
  $getSelection,
  $isLineBreakNode,
  $isRangeSelection,
  $isTabNode,
  $isTextNode,
  type LexicalEditor,
  type LexicalNode,
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

/**
 * Markdown of the editor's content, escapes undone outside code (call inside read/update).
 * Blocks are joined by a blank line (not preserveNewLines), so a paragraph after a list is not read as part of the last item.
 */
export const $exportMarkdown = () => unescapeMarkdown($convertToMarkdownString(PROMPT_TRANSFORMERS, undefined, false));

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
export type EnterAction = "pick" | "send" | "fence" | "default";

/** What Enter should do. "fence": current line is ``` (opt. lang) → turn it into a code block. */
export function enterAction({ menuOpen, composing, shift, mod, block }: EnterCtx): EnterAction {
  if (composing) return "default";
  if (menuOpen) return "pick";
  if (mod) return "send";
  if (shift) return "default";
  if (block === "fence") return "fence";
  return block === "text" ? "send" : "default";
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
