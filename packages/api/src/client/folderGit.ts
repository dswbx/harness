import type { Transport } from "../transport/transport";
import { expectResult } from "./expect";
import type { SessionApi } from "./session";

/** What the diff window reads from git: a Session's Workspace, or a folder with no Session (Folder Diff). */
export type GitSource = Pick<SessionApi, "gitDiff" | "gitLog" | "gitShowFile">;

/** Git reads of the repository containing `folder` (absolute), with no Session. Same defaults as a Session's. */
export const folderGit = (transport: Transport, folder: string): GitSource => ({
   gitDiff: async (from = null, to = null) =>
      (await expectResult(transport, { type: "FolderGitDiff", folder, from, to }, "Diff")).diff,
   gitLog: async () =>
      (await expectResult(transport, { type: "FolderGitLog", folder }, "GitLog")).commits,
   gitShowFile: async (rev, path) =>
      (
         await expectResult(
            transport,
            { type: "FolderGitShowFile", folder, rev, path },
            "FileContent",
         )
      ).content,
});
