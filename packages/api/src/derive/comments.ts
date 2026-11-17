import type { Event, LineComment, StateWriter } from "../generated";

/** Where a Review Comment is in its life (ADR 0027): `open` is sent (or the Agent's own). */
export type CommentStatus = "pending" | "open" | "resolved";

/** A line comment with its status, projected from the Session Log. */
export type LineCommentState = LineComment & {
   status: CommentStatus;
   resolvedBy: StateWriter | null;
   note: string | null;
};

/**
 * One step of the Review Comments projection (ADR 0027), in the order they were added. Returns `list`
 * itself when `e` changes nothing. A user's comment starts pending, an Agent's open.
 */
export function stepLineComments(
   list: readonly LineCommentState[],
   e: Event,
): readonly LineCommentState[] {
   const k = e.kind;
   const patch = (
      pick: (c: LineCommentState) => boolean,
      f: (c: LineCommentState) => LineCommentState,
   ) => (list.some(pick) ? list.map((c) => (pick(c) ? f(c) : c)) : list);
   switch (k.type) {
      case "CommentAdded":
         if (list.some((c) => c.id === k.comment.id)) return list;
         return [
            ...list,
            {
               ...k.comment,
               status: k.comment.by === "agent" ? "open" : "pending",
               resolvedBy: null,
               note: null,
            },
         ];
      case "CommentEdited":
         return patch(
            (c) => c.id === k.id && c.status === "pending",
            (c) => ({ ...c, text: k.text }),
         );
      case "CommentDeleted":
         return list.some((c) => c.id === k.id) ? list.filter((c) => c.id !== k.id) : list;
      case "CommentsSent":
         return patch(
            (c) => c.status === "pending" && k.ids.includes(c.id),
            (c) => ({ ...c, status: "open" }),
         );
      case "CommentResolved":
         return patch(
            (c) => c.id === k.id && c.status !== "resolved",
            (c) => ({ ...c, status: "resolved", resolvedBy: k.by, note: k.note ?? null }),
         );
      default:
         return list;
   }
}

/** Folds a whole log (or a batch) into the projection. */
export const lineCommentsOf = (events: readonly Event[]): readonly LineCommentState[] =>
   events.reduce(stepLineComments, [] as readonly LineCommentState[]);

/** Comments still needing attention: pending and open (not resolved). */
export const activeCommentCount = (list: readonly LineCommentState[]) =>
   list.filter((c) => c.status !== "resolved").length;

/**
 * Where a comment's line is now (ADR 0027 line drift). `lines` are the current lines of the file (null:
 * not loaded: keep the line). The line stays if it still holds `code`, else the nearest line that
 * does; none: the original line, `outdated`.
 */
export function anchorLine(
   lines: readonly string[] | null,
   line: number,
   code: string,
): { line: number; outdated: boolean } {
   if (!lines) return { line, outdated: false };
   if (lines[line - 1] === code) return { line, outdated: false };
   for (let d = 1; d < lines.length; d++) {
      if (lines[line - 1 - d] === code) return { line: line - d, outdated: false };
      if (lines[line - 1 + d] === code) return { line: line + d, outdated: false };
   }
   return { line, outdated: true };
}
