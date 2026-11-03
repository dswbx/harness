import {
   type PrEntry,
   type PrInfo,
   type PrRefContext,
   type PrRefKey,
   type PrStore,
   prKey,
} from "@harness/api";
import { $createCodeNode } from "@lexical/code";
import { createHeadlessEditor } from "@lexical/headless";
import { $convertFromMarkdownString } from "@lexical/markdown";
import {
   $createNodeSelection,
   $createParagraphNode,
   $createTextNode,
   $getRoot,
   $getSelection,
   $isRangeSelection,
   $setSelection,
   type ElementNode,
   type LexicalEditor,
   type ParagraphNode,
} from "lexical";
import { describe, expect, it } from "vitest";
import { $createPrRefNode, $isPrRefNode } from "./PrRefNode";
import {
   $exportMarkdown,
   PROMPT_NODES,
   PROMPT_TRANSFORMERS,
   restoreSnapshot,
   snapshot,
} from "./promptMarkdown";
import {
   $caretToken,
   $importPrRefs,
   $replaceToken,
   $unchip,
   autoChips,
   type CaretToken,
   registerAutoChip,
} from "./promptPrRefs";

const harness = { owner: "dswbx", name: "harness" };
const spark = { owner: "supabase", name: "spark" };
const ctx: PrRefContext = {
   sessionRepo: harness,
   knownRepos: [{ repo: spark, sessions: 3, score: 2, last_ms: 0 }],
};
const k = (repo: typeof harness, number: number): PrRefKey => ({ repo, number });

const newEditor = () =>
   createHeadlessEditor({
      nodes: PROMPT_NODES,
      onError: (e) => {
         throw e;
      },
   });
const run = (ed: LexicalEditor, fn: () => void) => ed.update(fn, { discrete: true });
const mdOf = (ed: LexicalEditor) => ed.getEditorState().read($exportMarkdown);
/** Paragraph contents: text as is, chips as `[typed]`. */
const shape = (ed: LexicalEditor) =>
   ed.getEditorState().read(() =>
      ($getRoot().getChildren() as ElementNode[]).map((b) =>
         b
            .getChildren()
            .map((n) => ($isPrRefNode(n) ? `[${n.getTyped()}]` : n.getTextContent()))
            .join(""),
      ),
   );
const caret = (ed: LexicalEditor) =>
   ed.getEditorState().read(() => {
      const s = $getSelection();
      return $isRangeSelection(s) ? [s.anchor.getNode().getTextContent(), s.anchor.offset] : null;
   });
/** One paragraph: text, a chip for `#23` (typed), text. */
const withChip = (before: string, after: string) => {
   const ed = newEditor();
   run(
      ed,
      () =>
         void $getRoot().append(
            $createParagraphNode().append(
               ...(before ? [$createTextNode(before)] : []),
               $createPrRefNode(k(harness, 23), "#23"),
               ...(after ? [$createTextNode(after)] : []),
            ),
         ),
   );
   return ed;
};

describe("PrRefNode", () => {
   it("exports the qualified ref, whatever was typed", () => {
      const ed = withChip("see ", " now");
      expect(mdOf(ed)).toBe("see dswbx/harness#23 now");
      expect(ed.getEditorState().read(() => $getRoot().getTextContent())).toBe(
         "see dswbx/harness#23 now",
      );
   });
   it("snapshot round trip keeps the chip and its typed text", () => {
      const ed = withChip("see ", " now");
      const snap = snapshot(ed);
      run(ed, () => void $getRoot().clear().append($createParagraphNode()));
      expect(restoreSnapshot(ed, snap)).toBe(true);
      expect(shape(ed)).toEqual(["see [#23] now"]);
   });
   it("Markdown import turns `owner/repo#N` into a chip, not inside code", () => {
      const ed = newEditor();
      run(ed, () =>
         $convertFromMarkdownString(
            "see supabase/spark#17, and `dswbx/harness#2`\n\n```\nsupabase/spark#3\n```",
            PROMPT_TRANSFORMERS,
            undefined,
            true,
         ),
      );
      expect(shape(ed)[0]).toBe("see [supabase/spark#17], and dswbx/harness#2");
      expect(mdOf(ed)).toBe(
         "see supabase/spark#17, and `dswbx/harness#2`\n\n```\nsupabase/spark#3\n```",
      );
   });
   it("plain text import (setText) chips every qualified ref, not `#N` or `a/b#3x`", () => {
      const ed = newEditor();
      run(ed, () => {
         const t = $createTextNode("a/b#1 x a/b#3x #4 (c/d#5).");
         $getRoot().append($createParagraphNode().append(t));
         $importPrRefs(t);
      });
      expect(shape(ed)).toEqual(["[a/b#1] x a/b#3x #4 ([c/d#5])."]);
   });
});

describe("unchip", () => {
   it("Backspace right after a chip turns it into the typed text, caret at its end", () => {
      const ed = withChip("see ", " now");
      let did = false;
      run(ed, () => {
         $getRoot().getAllTextNodes()[1]!.select(0, 0);
         did = $unchip("backward");
      });
      expect(did).toBe(true);
      expect(shape(ed)).toEqual(["see #23 now"]);
      expect(caret(ed)).toEqual(["see #23 now", 7]);
   });
   it("at the end of a paragraph (element point) and with the chip selected", () => {
      const ed = withChip("see ", "");
      run(ed, () => {
         ($getRoot().getFirstChildOrThrow() as ParagraphNode).select(2, 2);
         $unchip("backward");
      });
      expect(shape(ed)).toEqual(["see #23"]);
      const ed2 = withChip("see ", " now");
      run(ed2, () => {
         const sel = $createNodeSelection();
         sel.add(($getRoot().getFirstChildOrThrow() as ParagraphNode).getChildAtIndex(1)!.getKey());
         $setSelection(sel);
         $unchip("backward");
      });
      expect(shape(ed2)).toEqual(["see #23 now"]);
   });
   it("Delete right before a chip, caret at its start; not when text is between", () => {
      const ed = withChip("see ", " now");
      run(ed, () => {
         $getRoot().getAllTextNodes()[0]!.select(4, 4);
         $unchip("forward");
      });
      expect(shape(ed)).toEqual(["see #23 now"]);
      expect(caret(ed)).toEqual(["see #23 now", 4]);
      const ed2 = withChip("see ", " now");
      let did = true;
      run(ed2, () => {
         $getRoot().getAllTextNodes()[0]!.select(3, 3);
         did = $unchip("forward");
      });
      expect(did).toBe(false);
   });
});

describe("autoChips", () => {
   const at = (text: string) => autoChips(text, text.length - 1, text.length, ctx)[0] ?? null;
   it("strict refs followed by a space or punctuation", () => {
      expect(at("see harness#23 ")).toMatchObject({
         start: 4,
         end: 14,
         raw: "harness#23",
         key: k(harness, 23),
      });
      expect(at("supabase/spark#17,")?.key).toEqual(k(spark, 17));
      expect(at("spark#17)")?.key).toEqual(k(spark, 17));
      expect(at("https://github.com/supabase/spark/pull/9 ")?.key).toEqual(k(spark, 9));
   });
   it("nothing for bare #N, fuzzy names, unknown names or no boundary", () => {
      expect(at("spa#17 ")).toBeNull();
      expect(at("issue#3 ")).toBeNull();
      expect(at("see #23 ")).toBeNull();
      expect(at("see harness#23")).toBeNull();
      expect(at("harness#23x ")).toBeNull();
   });
   it("every ref whose boundary lies in the typed range, none before it", () => {
      const t = "spark#1 spark#2 #3 spark#4 x";
      expect(autoChips(t, 7, t.length, ctx).map((c) => c.raw)).toEqual([
         "spark#1",
         "spark#2",
         "spark#4",
      ]);
      expect(autoChips(t, 8, t.length, ctx).map((c) => c.raw)).toEqual(["spark#2", "spark#4"]);
   });
});

/** A store whose lookups the test settles by hand. */
function fakeStore() {
   const entries = new Map<string, PrEntry>();
   const listeners = new Set<() => void>();
   const requested: string[] = [];
   const store: PrStore = {
      peek: (key) => entries.get(prKey(key)) ?? { status: "loading" },
      request: (key) => void requested.push(prKey(key)),
      subscribe: (l) => (listeners.add(l), () => void listeners.delete(l)),
      seed: () => {},
   };
   const settle = (key: PrRefKey, e: PrEntry) => {
      entries.set(prKey(key), e);
      listeners.forEach((l) => l());
   };
   return { store, settle, requested };
}
const found = (key: PrRefKey): PrEntry => ({
   status: "found",
   pr: { repo: key.repo, number: key.number } as PrInfo,
});

describe("auto-chip", () => {
   const setup = (text: string, code = false) => {
      const ed = newEditor();
      const s = fakeStore();
      registerAutoChip(ed, () => ({ ctx, store: s.store }));
      run(ed, () => {
         const t = $createTextNode(text);
         if (code) $getRoot().append($createCodeNode().append(t));
         else $getRoot().append($createParagraphNode().append(t));
         t.selectEnd();
      });
      const type = (c: string) => run(ed, () => void $getSelection()!.insertText(c));
      return { ed, ...s, type };
   };
   const flush = () => new Promise((r) => setTimeout(r));

   it("typing a space after a ref chips it once the PR is found; the caret stays after it", async () => {
      const { ed, settle, requested, type } = setup("see harness#23");
      type(" ");
      expect(requested).toEqual(["dswbx/harness#23"]);
      expect(shape(ed)).toEqual(["see harness#23 "]);
      settle(k(harness, 23), found(k(harness, 23)));
      await flush();
      expect(shape(ed)).toEqual(["see [harness#23] "]);
      expect(caret(ed)).toEqual([" ", 1]);
      expect(mdOf(ed)).toBe("see dswbx/harness#23 ");
   });
   it("a missing or unavailable PR stays text", async () => {
      const a = setup("harness#23");
      a.type(" ");
      a.settle(k(harness, 23), { status: "missing" });
      const b = setup("spark#17");
      b.type(".");
      b.settle(k(spark, 17), { status: "unavailable" });
      await flush();
      expect(shape(a.ed)).toEqual(["harness#23 "]);
      expect(shape(b.ed)).toEqual(["spark#17."]);
   });
   it("leaves text changed meanwhile alone", async () => {
      const { ed, settle, type } = setup("see harness#23");
      type(" ");
      run(ed, () => {
         const t = $getRoot().getAllTextNodes()[0]!;
         t.setTextContent("see harness#24 ");
         t.selectEnd();
      });
      settle(k(harness, 23), found(k(harness, 23)));
      await flush();
      expect(shape(ed)).toEqual(["see harness#24 "]);
   });
   it("never in code, never for a fuzzy name, only on a typed character", async () => {
      const code = setup("harness#23", true);
      code.type(" ");
      const fuzzy = setup("spa#17");
      fuzzy.type(" ");
      expect(code.requested).toEqual([]);
      expect(fuzzy.requested).toEqual([]);
      const moved = setup("harness#23 x");
      moved.requested.length = 0;
      run(moved.ed, () => void $getRoot().getAllTextNodes()[0]!.select(11, 11));
      expect(moved.requested).toEqual([]);
      const inline = newEditor();
      const s = fakeStore();
      registerAutoChip(inline, () => ({ ctx, store: s.store }));
      run(inline, () => {
         const t = $createTextNode("harness#23").toggleFormat("code");
         $getRoot().append($createParagraphNode().append(t));
         t.selectEnd();
      });
      run(inline, () => void $getSelection()!.insertText(" "));
      expect(s.requested).toEqual([]);
   });
   it("several refs typed in one update (fast typing, paste) all chip", async () => {
      const { ed, settle, type } = setup("see");
      type(" harness#23 and spark#17, ok");
      settle(k(harness, 23), found(k(harness, 23)));
      expect(shape(ed)).toEqual(["see harness#23 and spark#17, ok"]);
      settle(k(spark, 17), found(k(spark, 17)));
      await flush();
      expect(shape(ed)).toEqual(["see [harness#23] and [spark#17], ok"]);
      expect(mdOf(ed)).toBe("see dswbx/harness#23 and supabase/spark#17, ok");
   });
   it("a bare #N stays text; the # menu picks those", () => {
      const { requested, type, ed } = setup("see #23");
      type(" ");
      expect(requested).toEqual([]);
      expect(shape(ed)).toEqual(["see #23 "]);
   });
   it("a cached PR chips at once", async () => {
      const ed = newEditor();
      const s = fakeStore();
      s.settle(k(spark, 17), found(k(spark, 17)));
      registerAutoChip(ed, () => ({ ctx, store: s.store }));
      run(ed, () => {
         const t = $createTextNode("supabase/spark#17");
         $getRoot().append($createParagraphNode().append(t));
         t.selectEnd();
      });
      run(ed, () => void $getSelection()!.insertText(" "));
      await flush();
      expect(shape(ed)).toEqual(["[supabase/spark#17] "]);
   });
});

describe("# menu token and pick", () => {
   /** One paragraph with `text`, caret at `at` (default: end); returns the token at the caret. */
   const at = (text: string, offset = text.length, code = false) => {
      const ed = newEditor();
      run(ed, () => {
         const t = code ? $createTextNode(text).toggleFormat("code") : $createTextNode(text);
         $getRoot().append($createParagraphNode().append(t));
         t.select(offset, offset);
      });
      return { ed, token: ed.getEditorState().read($caretToken) };
   };
   it("the run before the caret that contains #, from a space or (", () => {
      expect(at("see #fix").token).toMatchObject({ start: 4, end: 8, text: "#fix" });
      expect(at("(spark#1").token).toMatchObject({ start: 1, text: "spark#1" });
      expect(at("see sp#  x", 7).token).toMatchObject({ start: 4, end: 7, text: "sp#" });
      expect(at("see fix").token).toBeNull();
      expect(at("#fix more", 2).token).toBeNull();
      expect(at("#fix", 4, true).token).toBeNull();
   });
   it("picking a PR replaces the token with a chip and a space, caret after it", () => {
      const { ed, token } = at("see #fi");
      run(ed, () => void $replaceToken(token!, { pr: k(harness, 23), typed: "#23" }));
      expect(shape(ed)).toEqual(["see [#23] "]);
      expect(mdOf(ed)).toBe("see dswbx/harness#23 ");
      expect(caret(ed)).toEqual([" ", 1]);
      const n = ed.getEditorState().read(() => $getRoot().getAllTextNodes().length);
      expect(n).toBe(2);
      const chip = ed
         .getEditorState()
         .read(() =>
            ($getRoot().getFirstChild() as ElementNode)
               .getChildren()
               .find($isPrRefNode)!
               .getRefKey(),
         );
      expect(chip).toEqual(k(harness, 23));
   });
   it("a pick mid-text reuses the following space", () => {
      const { ed, token } = at("a spark# b", 8);
      run(ed, () => void $replaceToken(token!, { pr: k(spark, 17), typed: "supabase/spark#17" }));
      expect(shape(ed)).toEqual(["a [supabase/spark#17] b"]);
      expect(caret(ed)).toEqual([" b", 1]);
   });
   it("a repo pick rewrites the token to owner/repo#, caret at its end", () => {
      const { ed, token } = at("x sp#");
      run(ed, () => void $replaceToken(token!, { text: "supabase/spark#" }));
      expect(shape(ed)).toEqual(["x supabase/spark#"]);
      expect(ed.getEditorState().read($caretToken)?.text).toBe("supabase/spark#");
   });
   it("does nothing when the token text changed", () => {
      const { ed, token } = at("#fi");
      run(ed, () => void $getSelection()!.insertText("x"));
      let done = true;
      run(
         ed,
         () => void (done = $replaceToken(token as CaretToken, { pr: k(harness, 1), typed: "#1" })),
      );
      expect(done).toBe(false);
      expect(shape(ed)).toEqual(["#fix"]);
   });
});
