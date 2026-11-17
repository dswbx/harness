import { lineCommentsOf } from "../../derive/comments";
import { CommandError } from "../../errors";
import type { MockTransport } from "../mock";
import type { Handlers } from "./types";

const commentsOf = (mock: MockTransport, sid: string) => lineCommentsOf(mock.logs.get(sid) ?? []);

function find(mock: MockTransport, sid: string, id: string) {
   const c = commentsOf(mock, sid).find((x) => x.id === id);
   if (!c) throw new CommandError("not_found", `no comment ${id}`);
   return c;
}

/** Like the core: the user's pending comments among `ids` become sent once the Turn started. */
export function markCommentsSent(mock: MockTransport, sid: string, ids: string[] | undefined) {
   if (!ids?.length) return;
   const pending = commentsOf(mock, sid)
      .filter((c) => c.status === "pending" && ids.includes(c.id))
      .map((c) => c.id);
   if (pending.length) mock.emit(sid, { type: "CommentsSent", ids: pending }, null);
}

/** Review Comments (ADR 0027): the same ids and rules as the core. */
export const commentsHandlers = {
   AddComment: (mock, cmd) => {
      mock.session(cmd.session_id);
      const n = (mock.logs.get(cmd.session_id) ?? []).filter(
         (e) => e.kind.type === "CommentAdded",
      ).length;
      const comment = {
         id: `c${n + 1}`,
         path: cmd.path,
         line: cmd.line,
         side: cmd.side,
         code: cmd.code,
         text: cmd.text,
         by: "user" as const,
      };
      mock.emit(cmd.session_id, { type: "CommentAdded", comment }, null);
      return { type: "Comment", comment };
   },
   EditComment: (mock, cmd) => {
      if (find(mock, cmd.session_id, cmd.id).status !== "pending")
         throw new CommandError("conflict", "a sent comment cannot be edited");
      mock.emit(cmd.session_id, { type: "CommentEdited", id: cmd.id, text: cmd.text }, null);
      return { type: "Ok" };
   },
   DeleteComment: (mock, cmd) => {
      if (find(mock, cmd.session_id, cmd.id).status !== "pending")
         throw new CommandError("conflict", "a sent comment cannot be deleted");
      mock.emit(cmd.session_id, { type: "CommentDeleted", id: cmd.id }, null);
      return { type: "Ok" };
   },
   ResolveComment: (mock, cmd) => {
      const c = find(mock, cmd.session_id, cmd.id);
      if (c.status === "pending")
         throw new CommandError("conflict", "send the comment before resolving it");
      if (c.status === "open")
         mock.emit(cmd.session_id, { type: "CommentResolved", id: cmd.id, by: "user" }, null);
      return { type: "Ok" };
   },
} satisfies Partial<Handlers>;
