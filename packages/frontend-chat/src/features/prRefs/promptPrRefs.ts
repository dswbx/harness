// PR ref chips in the prompt editor: Markdown import/export, Backspace back to text, auto-chip after a typed ref.

import {
   findPrRefs,
   type PrEntry,
   type PrRefContext,
   type PrRefKey,
   type PrStore,
   qualify,
} from "@harness/api";
import { $isCodeNode } from "@lexical/code";
import { $isLinkNode } from "@lexical/link";
import type { TextMatchTransformer } from "@lexical/markdown";
import {
   $createTextNode,
   $getNodeByKey,
   $getSelection,
   $isNodeSelection,
   $isRangeSelection,
   $isTextNode,
   type LexicalEditor,
   type LexicalNode,
   type NodeKey,
   type TextNode,
} from "lexical";
import { $createPrRefNode, $isPrRefNode, $nodeAt, PrRefNode } from "./PrRefNode";

/** `owner/repo#N`, with the same boundaries as `findPrRefs`. */
const QUALIFIED = /(?<=^|[\s(])([\w-]+)\/([\w.-]+)#(\d+)(?=$|\s|[.,;:!?](?!\w)|[)\]}'"])/;

const keyOf = (m: RegExpMatchArray): PrRefKey => ({
   repo: { owner: m[1]!, name: m[2]! },
   number: Number(m[3]),
});

/** Chips export as `owner/repo#N`; importing that text (restore, `setText`) gives a chip again. Never in code. */
export const PR_REF: TextMatchTransformer = {
   dependencies: [PrRefNode],
   export: (node) => ($isPrRefNode(node) ? node.getTextContent() : null),
   importRegExp: QUALIFIED,
   regExp: new RegExp(`${QUALIFIED.source}$`),
   replace: (node, m) => void node.replace($createPrRefNode(keyOf(m), m[0])),
   type: "text-match",
};

/** Text where refs stay text: inline code, code blocks, links. */
const $noChips = (n: TextNode) =>
   n.hasFormat("code") || n.getParents().some((p: LexicalNode) => $isCodeNode(p) || $isLinkNode(p));

/** Turn each `owner/repo#N` in `node` into a chip (for `setText`; Markdown import uses `PR_REF`). */
export function $importPrRefs(node: TextNode) {
   if ($noChips(node)) return;
   let rest: TextNode | undefined = node;
   for (let m: RegExpExecArray | null; rest && (m = QUALIFIED.exec(rest.getTextContent())); ) {
      const start = m.index;
      const parts: TextNode[] = rest.splitText(start, start + m[0].length);
      const target = parts[start === 0 ? 0 : 1]!;
      rest = parts[start === 0 ? 1 : 2];
      target.replace($createPrRefNode(keyOf(m), m[0]));
   }
}

/**
 * Backspace (`backward`) with the caret right after a chip, Delete (`forward`) right before one, or either with the chip
 * selected: the chip becomes the text the user typed, caret at its end (Backspace) or start. Returns whether it did.
 */
export function $unchip(dir: "backward" | "forward"): boolean {
   const sel = $getSelection();
   let node: LexicalNode | null = null;
   if ($isNodeSelection(sel)) {
      const nodes = sel.getNodes();
      if (nodes.length === 1) node = nodes[0]!;
   } else if ($isRangeSelection(sel) && sel.isCollapsed())
      node = $nodeAt(sel.anchor, dir === "backward" ? "before" : "after");
   if (!$isPrRefNode(node)) return false;
   const text = $createTextNode(node.getTyped());
   node.replace(text);
   if (dir === "backward") text.selectEnd();
   else text.selectStart();
   return true;
}

export type AutoChip = { start: number; end: number; raw: string; key: PrRefKey };

/** Characters that end a ref the user just typed. */
const BOUNDARY = /[\s.,;:!?)\]}'"]/;

/**
 * Refs in `text` whose ending boundary character (space, punctuation) was just typed, i.e. lies in `[from, to)`, and
 * that resolve strictly (`owner/repo#N`, a known repo's exact unique name, a PR URL; never fuzzy). `to` is the caret.
 * A bare `#N` stays text (often a list item); the `#` menu is how to pick a PR in the Session's repo.
 */
export function autoChips(text: string, from: number, to: number, ctx: PrRefContext): AutoChip[] {
   return findPrRefs(text.slice(0, to), ctx).flatMap((m) => {
      const typed = m.repo !== null && m.end >= from && m.end < to && BOUNDARY.test(text[m.end]!);
      const key = typed ? qualify(m, ctx) : null;
      return key ? [{ start: m.start, end: m.end, raw: m.raw, key }] : [];
   });
}

/** Replace the ref at `c` in text node `nodeKey` with a chip, only if that text is still there. Returns whether it did. */
export function $chipRange(nodeKey: NodeKey, c: AutoChip): boolean {
   const node = $getNodeByKey(nodeKey);
   if (
      !$isTextNode(node) ||
      $noChips(node) ||
      node.getTextContent().slice(c.start, c.end) !== c.raw
   )
      return false;
   const parts = node.splitText(c.start, c.end);
   const target = parts[c.start === 0 ? 0 : 1]!;
   const sel = $getSelection();
   const caretIn = $isRangeSelection(sel) && sel.anchor.key === target.getKey();
   const chip = $createPrRefNode(c.key, c.raw);
   target.replace(chip);
   if (caretIn) chip.selectNext(0, 0);
   return true;
}

/** Calls `fn` once the store has a settled entry for each of `keys` (requests them). Returns a cancel function. */
function whenSettled(
   store: PrStore,
   keys: PrRefKey[],
   fn: (entries: PrEntry[]) => void,
): () => void {
   let done = false;
   let off = () => {};
   const check = () => {
      const entries = keys.map((k) => store.peek(k));
      if (done || entries.some((e) => e.status === "loading")) return;
      done = true;
      off();
      fn(entries);
   };
   off = store.subscribe(check);
   keys.forEach((k) => store.request(k));
   check();
   return () => {
      done = true;
      off();
   };
}

/**
 * Auto-chip: when the user types a boundary character right after a strictly resolvable ref, look the PR up and, if it
 * exists, replace the ref text with a chip (only if that text is unchanged by then). Missing or unavailable: stays text.
 * Also covers several characters in one update (fast typing, paste).
 */
export function registerAutoChip(
   editor: LexicalEditor,
   refs: () => { ctx: PrRefContext; store: PrStore } | null,
): () => void {
   const pending = new Set<() => void>();
   const offUpdate = editor.registerUpdateListener(({ editorState, prevEditorState, tags }) => {
      const r = refs();
      if (!r || tags.has("historic")) return;
      const at = editorState.read(() => {
         const sel = $getSelection();
         if (!$isRangeSelection(sel) || !sel.isCollapsed() || sel.anchor.type !== "text")
            return null;
         const node = sel.anchor.getNode();
         if (!$isTextNode(node) || $noChips(node)) return null;
         return { key: node.getKey(), text: node.getTextContent(), offset: sel.anchor.offset };
      });
      if (!at) return;
      // Only after typing (the caret's node grew); what was typed starts where it differs from before.
      const prev = prevEditorState.read(() => $getNodeByKey(at.key)?.getTextContent()) ?? "";
      if (at.text.length <= prev.length) return;
      let from = 0;
      while (from < prev.length && prev[from] === at.text[from]) from++;
      const chips = autoChips(at.text, from, at.offset, r.ctx);
      if (!chips.length) return;
      // Cached entries settle at once, before `cancel` is set.
      let settled = false;
      let cancel = () => {};
      cancel = whenSettled(
         r.store,
         chips.map((c) => c.key),
         (entries) => {
            settled = true;
            pending.delete(cancel);
            const found = chips.filter((_, i) => entries[i]!.status === "found");
            // Last first: splitting keeps the node's key on the text before, where the earlier refs are.
            if (found.length)
               editor.update(() => found.reverse().forEach((c) => $chipRange(at.key, c)));
         },
      );
      if (!settled) pending.add(cancel);
   });
   return () => {
      offUpdate();
      pending.forEach((cancel) => cancel());
   };
}

/** The run of non-space characters ending at the caret (from a space or `(`) when it contains `#` and is followed by
 * nothing, a space; never in code or links. `start`/`end` are offsets in text node `nodeKey`. */
export type CaretToken = { nodeKey: NodeKey; start: number; end: number; text: string };

export function $caretToken(): CaretToken | null {
   const sel = $getSelection();
   if (!$isRangeSelection(sel) || !sel.isCollapsed() || sel.anchor.type !== "text") return null;
   const node = sel.anchor.getNode();
   if (!$isTextNode(node) || $noChips(node)) return null;
   const text = node.getTextContent();
   const end = sel.anchor.offset;
   if (end < text.length && !/\s/.test(text[end]!)) return null;
   const before = text.slice(0, end);
   const start = Math.max(before.search(/[^\s(]*$/), 0);
   const token = before.slice(start);
   return token.includes("#") ? { nodeKey: node.getKey(), start, end, text: token } : null;
}

/**
 * Replace `token` with a chip of `pr` plus a space (caret after the space), or with `text` (caret after it). Only if the
 * token is still there as it was (same text, still ending there). Returns whether it did.
 */
export function $replaceToken(
   token: CaretToken,
   by: { pr: PrRefKey; typed: string } | { text: string },
): boolean {
   const node = $getNodeByKey(token.nodeKey);
   const text = $isTextNode(node) ? node.getTextContent() : "";
   if (
      !$isTextNode(node) ||
      text.slice(token.start, token.end) !== token.text ||
      /\S/.test(text[token.end] ?? " ")
   )
      return false;
   if ("text" in by) {
      node.spliceText(token.start, token.end - token.start, by.text, true);
      return true;
   }
   const parts = node.splitText(token.start, token.end);
   const target = parts[token.start === 0 ? 0 : 1]!;
   const chip = $createPrRefNode(by.pr, by.typed);
   target.replace(chip);
   const next = chip.getNextSibling();
   if ($isTextNode(next) && next.getTextContent().startsWith(" ")) next.select(1, 1);
   else {
      const space = $createTextNode(" ");
      chip.insertAfter(space);
      space.select(1, 1);
   }
   return true;
}
