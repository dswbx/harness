import type { Transport } from "../../transport/transport";
import { expectResult, run } from "../expect";
import type { SessionApi } from "../session";

type Git = Pick<
   SessionApi,
   "gitStatus" | "gitDiff" | "gitLog" | "gitShowFile" | "gitCommit" | "gitPush"
>;

export const gitApi = (transport: Transport, sessionId: string): Git => ({
   gitStatus: async () =>
      (await expectResult(transport, { type: "GitStatus", session_id: sessionId }, "GitStatus"))
         .status,
   gitDiff: async (from = null, to = null) =>
      (await expectResult(transport, { type: "GitDiff", session_id: sessionId, from, to }, "Diff"))
         .diff,
   gitLog: async () =>
      (await expectResult(transport, { type: "GitLog", session_id: sessionId }, "GitLog")).commits,
   gitShowFile: async (rev, path) =>
      (
         await expectResult(
            transport,
            { type: "GitShowFile", session_id: sessionId, rev, path },
            "FileContent",
         )
      ).content,
   gitCommit: async (message) =>
      (
         await expectResult(
            transport,
            { type: "GitCommit", session_id: sessionId, message },
            "Committed",
         )
      ).commit,
   gitPush: () => run(transport, { type: "GitPush", session_id: sessionId }),
});
