import type { SessionApi } from "@harness/api";
import { useSharedArtifacts } from "@harness/api";
import { useMemo } from "react";

/** Shared Artifacts (ADR 0024): the meta of each, by id, for titles and Session counts. */
export function useSharedMetas(api: SessionApi) {
   const source = useMemo(
      () => ({
         list: () => api.listShared(),
         onListChanged: (f: () => void) => api.sharedListChanged(f),
      }),
      [api],
   );
   const list = useSharedArtifacts(source);
   return useMemo(() => new Map((list ?? []).map((e) => [e.meta.id, e.meta])), [list]);
}
