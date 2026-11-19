import type { Transport } from "../../transport/transport";
import { expectResult, run } from "../expect";
import type { SessionApi } from "../session";

type FrontendFiles = Pick<
   SessionApi,
   | "frontendRead"
   | "frontendReadImage"
   | "frontendWrite"
   | "frontendList"
   | "panelSourceRead"
   | "panelSourceChanged"
   | "getState"
   | "patchState"
   | "reportFrontendError"
   | "editPanel"
   | "deletePanel"
   | "answerFrontendRequest"
>;

/** The Session's Frontend state (`frontend/`, panels), Session State and Frontend requests. */
export const frontendFilesApi = (transport: Transport, sessionId: string): FrontendFiles => ({
   frontendRead: async (path) =>
      (
         await expectResult(
            transport,
            { type: "FrontendRead", session_id: sessionId, path },
            "FileContent",
         )
      ).content,
   panelSourceRead: async (name) => {
      const r = await expectResult(
         transport,
         { type: "PanelSourceRead", session_id: sessionId, name },
         "PanelSource",
      );
      return { content: r.content, hash: r.hash, mtime_ms: r.mtime_ms, path: r.path };
   },
   panelSourceChanged: (onChange) =>
      transport.subscribeApp(
         (e) => e.type === "PanelSourceChanged" && e.session_id === sessionId && onChange(e.name),
      ),
   getState: async () =>
      (await expectResult(transport, { type: "GetState", session_id: sessionId }, "State")).state,
   patchState: (ops) => run(transport, { type: "PatchState", session_id: sessionId, ops }),
   reportFrontendError: (tool, item, message) =>
      run(transport, { type: "ReportFrontendError", session_id: sessionId, tool, item, message }),
   editPanel: (item_id, title, icon) =>
      run(transport, { type: "EditPanel", session_id: sessionId, item_id, title, icon }),
   deletePanel: (item_id) =>
      run(transport, { type: "DeletePanel", session_id: sessionId, item_id }),
   answerFrontendRequest: (request_id, answer) =>
      run(transport, {
         type: "AnswerFrontendRequest",
         session_id: sessionId,
         request_id,
         answer,
      }),
   frontendReadImage: async (path) => {
      const r = await expectResult(
         transport,
         { type: "FrontendReadImage", session_id: sessionId, path },
         "Attachment",
      );
      return { mime: r.mime, data: r.data };
   },
   frontendWrite: (path, content) =>
      run(transport, { type: "FrontendWrite", session_id: sessionId, path, content }),
   frontendList: async (dir) =>
      (await expectResult(transport, { type: "FrontendList", session_id: sessionId, dir }, "Files"))
         .files,
});
