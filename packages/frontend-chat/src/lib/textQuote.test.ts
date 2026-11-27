// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { describeRange, findQuote, textIndex } from "./textQuote";

const root = (html: string) => {
   const el = document.createElement("div");
   el.innerHTML = html;
   return el;
};

/** The range over `quote`'s `n`th occurrence in `el`'s text (within one text node). */
function rangeOf(el: Element, quote: string, n = 0): Range {
   const ix = textIndex(el);
   let at = -1;
   for (let i = 0; i <= n; i++) at = ix.text.indexOf(quote, at + 1);
   const r = document.createRange();
   const node = (o: number, end: boolean) => {
      const i = ix.nodes.findIndex((t, k) =>
         end
            ? o > ix.starts[k]! && o <= ix.starts[k]! + t.length
            : o >= ix.starts[k]! && o < ix.starts[k]! + t.length,
      );
      return [ix.nodes[i]!, o - ix.starts[i]!] as const;
   };
   r.setStart(...node(at, false));
   r.setEnd(...node(at + quote.length, true));
   return r;
}

/** Where a found range sits in the root's text. */
const offsets = (el: Element, r: Range) => {
   const ix = textIndex(el);
   const at = (n: Node, o: number) => ix.starts[ix.nodes.indexOf(n as Text)]! + o;
   return [at(r.startContainer, r.startOffset), at(r.endContainer, r.endOffset)];
};

describe("textQuote", () => {
   it("finds a unique quote", () => {
      const el = root("<p>The retry loop waits twice as long each time.</p>");
      const q = describeRange(el, rangeOf(el, "twice as long"))!;
      expect(q).toEqual({
         quote: "twice as long",
         prefix: "The retry loop waits ",
         suffix: " each time.",
      });
      const r = findQuote(el, q)!;
      expect(r.toString()).toBe("twice as long");
   });

   it("picks a repeated quote by its prefix and suffix", () => {
      const el = root("<p>one try then one more try, and one last try.</p>");
      const q = describeRange(el, rangeOf(el, "try", 1))!;
      expect(q.quote).toBe("try");
      const r = findQuote(el, q)!;
      expect(offsets(el, r)).toEqual(offsets(el, rangeOf(el, "try", 1)));
      const last = findQuote(el, describeRange(el, rangeOf(el, "try", 2))!)!;
      expect(offsets(el, last)).toEqual(offsets(el, rangeOf(el, "try", 2)));
   });

   it("finds a quote across inline markup", () => {
      const el = root("<p>Call <code>fetchWithRetry</code> with <strong>three</strong> tries.</p>");
      const r = document.createRange();
      r.setStart(el.querySelector("code")!.firstChild!, 5);
      r.setEnd(el.querySelector("strong")!.firstChild!, 5);
      const q = describeRange(el, r)!;
      expect(q.quote).toBe("WithRetry with three");
      // Rendered anew: other nodes, same text.
      const again = root(el.innerHTML);
      expect(findQuote(again, q)!.toString()).toBe("WithRetry with three");
   });

   it("describes a range with element boundary points", () => {
      const el = root("<p>alpha</p><p>beta</p>");
      const r = document.createRange();
      r.setStart(el, 1);
      r.setEnd(el, 2);
      expect(describeRange(el, r)?.quote).toBe("beta");
   });

   it("returns null when the quote is not there", () => {
      const el = root("<p>Nothing to see.</p>");
      expect(findQuote(el, { quote: "gone", prefix: "", suffix: "" })).toBeNull();
      expect(findQuote(el, { quote: "  ", prefix: "", suffix: "" })).toBeNull();
   });

   it("ignores whitespace changes", () => {
      const el = root("<p>wait   twice\nas long</p><p>then stop</p>");
      const r = findQuote(el, { quote: "twice as long", prefix: "wait ", suffix: "then" })!;
      expect(r.toString()).toBe("twice\nas long");
   });
});
