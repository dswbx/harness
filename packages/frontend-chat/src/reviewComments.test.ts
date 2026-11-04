import { describe, expect, it } from "vitest";
import { parseReviewComments, type ReviewComment, withReviewComments } from "./reviewComments";

const diff = (over: Partial<ReviewComment> = {}): ReviewComment =>
   ({
      id: "d",
      path: "src/a.ts",
      line: 12,
      side: "new",
      code: "const x = 1;",
      text: "Rename this",
      ...over,
   }) as ReviewComment;
const quote = (q: string, text: string, side = false): ReviewComment => ({
   id: "q",
   kind: "quote",
   quote: q,
   text,
   ...(side && { source: "side_thread" as const }),
});

/** Parsed comments without ids, for comparing to the input. */
const roundTrip = (text: string, comments: ReviewComment[]) => {
   const p = parseReviewComments(withReviewComments(text, comments));
   return { text: p.text, comments: p.comments.map(({ id: _, ...c }) => c) };
};
const noIds = (cs: ReviewComment[]) => cs.map(({ id: _, ...c }) => c);

describe("withReviewComments", () => {
   it("puts the comments first, then the text after a separator", () => {
      expect(withReviewComments("  Fix it  ", [quote("hello", "why?")])).toBe(
         "Comments on the conversation:\n\n> hello\n\nwhy?\n\n---\n\nFix it",
      );
   });

   it("has no separator when one side is empty", () => {
      expect(withReviewComments("Fix it", [])).toBe("Fix it");
      expect(withReviewComments("", [quote("hello", "")])).toBe(
         "Comments on the conversation:\n\n> hello",
      );
   });

   it("keeps a leading slash command first", () => {
      expect(withReviewComments("/review now", [quote("hello", "why?")])).toBe(
         "/review now\n\nComments on the conversation:\n\n> hello\n\nwhy?",
      );
   });
});

describe("parseReviewComments", () => {
   it("round-trips all sections and the text", () => {
      const cs = [
         diff(),
         diff({
            path: "b.rs",
            line: 3,
            side: "old",
            code: "fn a() {}\n\nfn b() {}",
            text: "Two\n\nparas",
         }),
         quote("line one\n\nline three", "A **bold** comment"),
         quote("just a quote", ""),
         quote("from side", "take this", true),
      ];
      expect(roundTrip("Please fix\n\nall of these", cs)).toEqual({
         text: "Please fix\n\nall of these",
         comments: noIds(cs),
      });
   });

   it("round-trips code with backtick fences inside", () => {
      const cs = [diff({ code: "const s = `x`;\n```\nnested\n```", text: "Use `y` here" })];
      expect(roundTrip("", cs)).toEqual({ text: "", comments: noIds(cs) });
   });

   it("round-trips multi-line and nested quotes", () => {
      const cs = [
         quote("> already quoted\nsecond\n\n  indented", "ok"),
         quote("next", "and `code`"),
      ];
      expect(roundTrip("go", cs)).toEqual({ text: "go", comments: noIds(cs) });
   });

   it("leaves other text untouched", () => {
      for (const t of [
         "Just a prompt",
         "Fix it\n\nReview comments:\n\nsrc/a.ts:1 (new)\n```\nx\n```\nhm",
         "Review comments: are great",
         "Comments on the conversation:\n\nnot a quote",
      ])
         expect(parseReviewComments(t)).toEqual({ comments: [], text: t });
   });
});
