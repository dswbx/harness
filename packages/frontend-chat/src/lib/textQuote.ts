/**
 * Text quotes in rendered DOM (a W3C-style TextQuoteSelector): describe a selected range as its quote with
 * some text before and after it, and find that quote again later, after the DOM was rendered anew. Capture
 * and lookup read the same text (the text nodes under `root`, in order), so offsets agree. DOM only.
 */

/** The quote and up to `CONTEXT` characters of text on each side of it. */
export type TextQuote = { quote: string; prefix: string; suffix: string };

/** Characters of text kept before and after a quote. */
export const CONTEXT = 32;

/** The text under a root: its text nodes in order, and where each starts in `text`. */
export type TextIndex = { text: string; nodes: Text[]; starts: number[] };

export function textIndex(root: Node): TextIndex {
   const walker = (root.ownerDocument ?? document).createTreeWalker(root, NodeFilter.SHOW_TEXT);
   const nodes: Text[] = [];
   const starts: number[] = [];
   let text = "";
   for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      nodes.push(n as Text);
      starts.push(text.length);
      text += (n as Text).data;
   }
   return { text, nodes, starts };
}

const FOLLOWS = 4; // Node.DOCUMENT_POSITION_FOLLOWING

/** The offset in `ix.text` of a range boundary point (`container`, `offset`). */
function offsetAt(ix: TextIndex, container: Node, offset: number): number {
   if (container.nodeType === 3) {
      const i = ix.nodes.indexOf(container as Text);
      if (i >= 0) return ix.starts[i]! + Math.min(offset, (container as Text).length);
   }
   // Between children: the first text node at or after the point.
   const child = container.childNodes[offset] ?? null;
   for (let i = 0; i < ix.nodes.length; i++) {
      const n = ix.nodes[i]!;
      const after = child
         ? n === child || child.contains(n) || !!(child.compareDocumentPosition(n) & FOLLOWS)
         : !container.contains(n) && !!(container.compareDocumentPosition(n) & FOLLOWS);
      if (after) return ix.starts[i]!;
   }
   return ix.text.length;
}

/** The quote `range` selects under `root`, trimmed, with its prefix and suffix; null when it selects no text. */
export function describeRange(root: Node, range: Range): TextQuote | null {
   const ix = textIndex(root);
   let start = offsetAt(ix, range.startContainer, range.startOffset);
   let end = offsetAt(ix, range.endContainer, range.endOffset);
   while (start < end && /\s/.test(ix.text[start]!)) start++;
   while (end > start && /\s/.test(ix.text[end - 1]!)) end--;
   if (start >= end) return null;
   return {
      quote: ix.text.slice(start, end),
      prefix: ix.text.slice(Math.max(0, start - CONTEXT), start),
      suffix: ix.text.slice(end, end + CONTEXT),
   };
}

/** `s` with each run of whitespace as one space, and for each character its offset in `s`. */
function normalize(s: string): { text: string; map: number[] } {
   let text = "";
   const map: number[] = [];
   for (let i = 0; i < s.length; i++) {
      const space = /\s/.test(s[i]!);
      if (space && text.endsWith(" ")) continue;
      text += space ? " " : s[i];
      map.push(i);
   }
   return { text, map };
}
const squash = (s: string) => s.replace(/\s+/g, " ");

/** Characters `a` and `b` share at their ends (`fromEnd`) or starts. */
function shared(a: string, b: string, fromEnd: boolean): number {
   let n = 0;
   const max = Math.min(a.length, b.length);
   while (n < max) {
      const x = fromEnd ? a[a.length - 1 - n] : a[n];
      const y = fromEnd ? b[b.length - 1 - n] : b[n];
      if (x !== y) break;
      n++;
   }
   return n;
}

/** The text node holding offset `at` (`end`: a range end, which may sit at a node's end). */
function nodeAt(ix: TextIndex, at: number, end: boolean): [Text, number] | null {
   for (let i = 0; i < ix.nodes.length; i++) {
      const n = ix.nodes[i]!;
      const s = ix.starts[i]!;
      if (end ? at > s && at <= s + n.length : at >= s && at < s + n.length) return [n, at - s];
   }
   return null;
}

/**
 * The range of `anchor`'s quote under `root`, or null when it is not there. Each occurrence of the quote is
 * scored by how much of the prefix and suffix match around it (whitespace runs count as one space); the
 * best one wins, the first on a tie.
 */
export function findQuote(root: Node, anchor: TextQuote): Range | null {
   const quote = squash(anchor.quote).trim();
   if (!quote) return null;
   const ix = textIndex(root);
   const norm = normalize(ix.text);
   const prefix = squash(anchor.prefix);
   const suffix = squash(anchor.suffix);
   let best = -1;
   let bestScore = -1;
   for (let at = norm.text.indexOf(quote); at >= 0; at = norm.text.indexOf(quote, at + 1)) {
      const before = norm.text.slice(Math.max(0, at - prefix.length - 1), at);
      const after = norm.text.slice(at + quote.length, at + quote.length + suffix.length + 1);
      const score =
         shared(before.trimEnd(), prefix.trimEnd(), true) +
         shared(after.trimStart(), suffix.trimStart(), false);
      if (score > bestScore) {
         best = at;
         bestScore = score;
      }
   }
   if (best < 0) return null;
   const start = nodeAt(ix, norm.map[best]!, false);
   const end = nodeAt(ix, norm.map[best + quote.length - 1]! + 1, true);
   if (!start || !end) return null;
   const range = (root.ownerDocument ?? document).createRange();
   range.setStart(start[0], start[1]);
   range.setEnd(end[0], end[1]);
   return range;
}
