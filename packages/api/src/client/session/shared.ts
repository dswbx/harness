import type { Transport } from "../../transport/transport";
import { expectResult, run } from "../expect";
import type { SessionApi } from "../session";
import {
   attachSharedArtifact,
   listShared,
   patchArtifactState,
   readShared,
   sharedChanged,
   sharedListChanged,
} from "../shared";

type Shared = Pick<
   SessionApi,
   | "shareArtifact"
   | "shareMarkdown"
   | "attachShared"
   | "detachShared"
   | "listShared"
   | "readShared"
   | "patchArtifactState"
   | "sharedChanged"
   | "sharedListChanged"
>;

/** Shared Artifacts (ADR 0024) as seen from one Session. */
export const sharedApi = (transport: Transport, sessionId: string): Shared => ({
   shareArtifact: async (item_id) =>
      (
         await expectResult(
            transport,
            { type: "ShareArtifact", session_id: sessionId, item_id },
            "SharedArtifactInfo",
         )
      ).meta,
   shareMarkdown: async (markdown, title = null, origin = null) =>
      (
         await expectResult(
            transport,
            { type: "ShareMarkdown", session_id: sessionId, markdown, title, origin },
            "SharedArtifactInfo",
         )
      ).meta,
   attachShared: (id) => attachSharedArtifact(transport, sessionId, id),
   detachShared: (id) =>
      run(transport, { type: "DetachSharedArtifact", session_id: sessionId, id }),
   listShared: (query) => listShared(transport, query),
   readShared: (id) => readShared(transport, id),
   patchArtifactState: (id, ops) => patchArtifactState(transport, id, ops, sessionId),
   sharedChanged: (onChange) => sharedChanged(transport, onChange),
   sharedListChanged: (onChange) => sharedListChanged(transport, onChange),
});
