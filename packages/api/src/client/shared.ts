import type { CommandResult, SharedArtifactMeta, StatePatchOp } from "../generated";
import type { Transport } from "../transport/transport";
import { expectResult, run } from "./expect";

/** A Shared Artifact as read (ADR 0024): meta, content (`ui.json` text for kind `ui`), hash, state and folder. */
export type SharedArtifactData = Omit<Extract<CommandResult, { type: "SharedArtifact" }>, "type">;

export const listShared = async (transport: Transport, query?: string | null) => {
   const r = await expectResult(
      transport,
      { type: "ListSharedArtifacts", query: query || null },
      "SharedArtifactList",
   );
   return r.artifacts;
};

export const readShared = async (transport: Transport, id: string): Promise<SharedArtifactData> => {
   const r = await expectResult(transport, { type: "SharedArtifactRead", id }, "SharedArtifact");
   const { type: _, ...data } = r;
   return data;
};

export const sharedChanged = (transport: Transport, onChange: (id: string) => void) =>
   transport.subscribeApp((e) => e.type === "SharedArtifactChanged" && onChange(e.id));

export const sharedListChanged = (transport: Transport, onChange: () => void) =>
   transport.subscribeApp((e) => e.type === "SharedArtifactsChanged" && onChange());

/** `sessionId` null: no Session (nothing is logged). */
export const patchArtifactState = (
   transport: Transport,
   id: string,
   ops: StatePatchOp[],
   sessionId: string | null,
) => run(transport, { type: "PatchArtifactState", id, ops, session_id: sessionId });

export const attachSharedArtifact = async (
   transport: Transport,
   sessionId: string,
   id: string,
): Promise<SharedArtifactMeta> =>
   (
      await expectResult(
         transport,
         { type: "AttachSharedArtifact", session_id: sessionId, id },
         "SharedArtifactInfo",
      )
   ).meta;
