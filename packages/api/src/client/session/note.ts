import type { Transport } from "../../transport/transport";
import { expectResult } from "../expect";
import type { SessionApi } from "../session";

type NoteApi = Pick<
   SessionApi,
   "readNote" | "writeNote" | "addNoteImages" | "removeNoteImage" | "noteChanged"
>;

/** The Session Note (ADR 0028): `note.md` in the Session Directory, images in `attachments/note/`. */
export const noteApi = (transport: Transport, sessionId: string): NoteApi => ({
   readNote: async () =>
      (await expectResult(transport, { type: "ReadNote", session_id: sessionId }, "Note")).note,
   writeNote: async (content, baseHash = null) =>
      (
         await expectResult(
            transport,
            { type: "WriteNote", session_id: sessionId, content, base_hash: baseHash },
            "Note",
         )
      ).note,
   addNoteImages: async (files) =>
      (
         await expectResult(
            transport,
            { type: "AddNoteImages", session_id: sessionId, files },
            "Note",
         )
      ).note,
   removeNoteImage: async (path) =>
      (
         await expectResult(
            transport,
            { type: "RemoveNoteImage", session_id: sessionId, path },
            "Note",
         )
      ).note,
   noteChanged: (onChange) =>
      transport.subscribeApp(
         (e) => e.type === "NoteChanged" && e.session_id === sessionId && onChange(),
      ),
});
