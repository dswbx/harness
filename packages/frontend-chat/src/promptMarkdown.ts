import { CodeHighlightNode, CodeNode } from "@lexical/code";
import { LinkNode } from "@lexical/link";
import { ListItemNode, ListNode } from "@lexical/list";
import {
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
 * Lexical escapes `*_\`~` in plain text on export (`a_b` → `a\_b`). Prompts go to an Agent, so undo that
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
      if (c === "\\" && /[*_`~]/.test(line[j + 1] ?? "")) {
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
