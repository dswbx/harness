import type { Transport } from "../../transport/transport";
import { expectResult, run } from "../expect";
import type { SessionApi } from "../session";

type Comments = Pick<SessionApi, "addComment" | "editComment" | "deleteComment" | "resolveComment">;

/** Review Comments (ADR 0027) as seen from one Session; the user is always the writer. */
export const commentsApi = (transport: Transport, sessionId: string): Comments => ({
   addComment: async ({ path, line, side, code, text }) =>
      (
         await expectResult(
            transport,
            { type: "AddComment", session_id: sessionId, path, line, side, code, text },
            "Comment",
         )
      ).comment,
   editComment: (id, text) =>
      run(transport, { type: "EditComment", session_id: sessionId, id, text }),
   deleteComment: (id) => run(transport, { type: "DeleteComment", session_id: sessionId, id }),
   resolveComment: (id) => run(transport, { type: "ResolveComment", session_id: sessionId, id }),
});
