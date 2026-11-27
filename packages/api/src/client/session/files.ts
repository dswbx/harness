import type { Transport } from "../../transport/transport";
import { getEditor, openInEditor } from "../commands";
import { expectResult, run } from "../expect";
import type { SessionApi } from "../session";

type Files = Pick<
   SessionApi,
   | "readAttachment"
   | "readImageFile"
   | "openInEditor"
   | "exportPlan"
   | "getEditor"
   | "listSessionFiles"
   | "readSessionFile"
   | "approveSessionFile"
   | "revokeSessionFile"
>;

/** Files of the Session's folder and its attachments, and the editor. */
export const filesApi = (transport: Transport, sessionId: string): Files => ({
   readAttachment: async (path) => {
      const r = await expectResult(
         transport,
         { type: "ReadAttachment", session_id: sessionId, path },
         "Attachment",
      );
      return { mime: r.mime, data: r.data };
   },
   readImageFile: async (path) => {
      const r = await expectResult(transport, { type: "ReadImageFile", path }, "Attachment");
      return { mime: r.mime, data: r.data };
   },
   openInEditor: (path, line) => openInEditor(transport, sessionId, path, line),
   getEditor: () => getEditor(transport),
   exportPlan: async (name, markdown, openInEditor) =>
      (
         await expectResult(
            transport,
            {
               type: "ExportPlan",
               session_id: sessionId,
               name,
               markdown,
               open_in_editor: openInEditor,
            },
            "PlanFile",
         )
      ).path,
   listSessionFiles: async () => {
      const r = await expectResult(
         transport,
         { type: "ListSessionFiles", session_id: sessionId },
         "SessionFiles",
      );
      return { files: r.files, prefix: r.prefix };
   },
   readSessionFile: async (path, start, end) => {
      const r = await expectResult(
         transport,
         {
            type: "ReadSessionFile",
            session_id: sessionId,
            path,
            start: start ?? null,
            end: end ?? null,
         },
         "FileLines",
      );
      return { path: r.path, start: r.start, lines: r.lines, total: r.total, scope: r.scope };
   },
   approveSessionFile: (path) =>
      run(transport, { type: "ApproveSessionFile", session_id: sessionId, path }),
   revokeSessionFile: (path) =>
      run(transport, { type: "RevokeSessionFile", session_id: sessionId, path }),
});
