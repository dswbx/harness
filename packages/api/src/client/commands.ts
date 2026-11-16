import type { Editor } from "../generated";
import type { Transport } from "../transport/transport";
import { expectResult, run } from "./expect";

// Commands both `HarnessClient` (by Session id) and `SessionApi` (bound to one Session) issue.

export const archiveSession = (transport: Transport, sessionId: string) =>
   run(transport, { type: "ArchiveSession", session_id: sessionId });

export const markSessionSeen = (transport: Transport, sessionId: string) =>
   run(transport, { type: "MarkSessionSeen", session_id: sessionId });

export const unarchiveSession = (transport: Transport, sessionId: string) =>
   run(transport, { type: "UnarchiveSession", session_id: sessionId });

export const deleteSession = (transport: Transport, sessionId: string, force: boolean) =>
   run(transport, { type: "DeleteSession", session_id: sessionId, force });

export const openInEditor = (
   transport: Transport,
   sessionId: string,
   path?: string,
   line?: number,
) =>
   run(transport, {
      type: "OpenInEditor",
      session_id: sessionId,
      path: path ?? null,
      line: line ?? null,
   });

export const getEditor = async (transport: Transport): Promise<Editor | null> =>
   (await expectResult(transport, { type: "GetEditor" }, "Editor")).editor;
