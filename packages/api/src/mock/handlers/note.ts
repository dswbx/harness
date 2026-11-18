import { CommandError } from "../../errors";
import type { Note } from "../../generated";
import type { MockTransport } from "../mock";
import type { Handlers } from "./types";

// The core's Session Note (`session/note.rs`), in memory.

/** A stand-in for the core's sha256: any string that changes with the content. */
function hash(content: string): string {
   let h = 0x811c9dc5;
   for (let i = 0; i < content.length; i++) h = Math.imul(h ^ content.charCodeAt(i), 0x01000193);
   return `${(h >>> 0).toString(16)}-${content.length}`;
}

export type MockNote = { content: string; updated_ms: number | null; images: string[] };

function note(mock: MockTransport, sessionId: string): Note {
   mock.session(sessionId);
   const n = mock.notes.get(sessionId) ?? { content: "", updated_ms: null, images: [] };
   return {
      content: n.content,
      hash: hash(n.content),
      updated_ms: n.updated_ms,
      images: [...n.images],
   };
}

function changed(mock: MockTransport, sessionId: string): Note {
   mock.emitApp({ type: "NoteChanged", session_id: sessionId });
   return note(mock, sessionId);
}

export const noteHandlers = {
   ReadNote: (mock, cmd) => ({ type: "Note", note: note(mock, cmd.session_id) }),
   WriteNote: (mock, cmd) => {
      const cur = note(mock, cmd.session_id);
      if (cmd.base_hash != null && cmd.base_hash !== cur.hash)
         throw new CommandError("conflict", "the note changed elsewhere: reload it");
      mock.notes.set(cmd.session_id, {
         content: cmd.content,
         updated_ms: Date.now(),
         images: cur.images,
      });
      return { type: "Note", note: changed(mock, cmd.session_id) };
   },
   AddNoteImages: (mock, cmd) => {
      const cur = note(mock, cmd.session_id);
      if (cmd.files.length === 0) throw new CommandError("invalid", "no files");
      const images = [...cur.images];
      for (const f of cmd.files) {
         // Path inputs have no bytes in the browser.
         const [name, mime, data] =
            f.type === "data"
               ? [f.name, f.mime, f.data]
               : [f.path.split("/").pop() || "image", "image/png", ""];
         if (!mime.startsWith("image/"))
            throw new CommandError("invalid", `${name} is not an image`);
         const path = `/mock/sessions/${cmd.session_id}/attachments/note/${crypto.randomUUID()}-${name}`;
         mock.attachments.set(path, { mime, data });
         images.push(path);
      }
      mock.notes.set(cmd.session_id, { content: cur.content, updated_ms: cur.updated_ms, images });
      return { type: "Note", note: changed(mock, cmd.session_id) };
   },
} satisfies Partial<Handlers>;
