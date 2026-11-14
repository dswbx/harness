import type { SessionApi } from "@harness/api";
import { useMemo } from "react";
import type { ChatState } from "../../state/reducer";
import type { UiEnv } from "./RenderUi";
import { RENDER_UI } from "./tools";

/** What the Session's render_ui items run against: its state, its Agent calls and the shared artifacts (`Env`, `runtime.tsx`). */
export function useUiEnv(api: SessionApi, uiState: ChatState["uiState"]): UiEnv {
   return useMemo<UiEnv>(
      () => ({
         state: uiState,
         patch: (ops) => api.patchState(ops),
         report: (item, message) => {
            api.reportFrontendError(RENDER_UI, item, message).catch(() => {});
         },
         send: (text) => api.prompt(text),
         files: {},
         readImage: (p) => api.frontendReadImage(p),
         open: (p, line) => api.openInEditor(p, line),
         readSource: (name) => api.panelSourceRead(name),
         watchSources: (onChange) => api.panelSourceChanged(onChange),
         readShared: (id) => api.readShared(id),
         watchShared: (onChange) => api.sharedChanged(onChange),
         patchShared: (id, ops) => api.patchArtifactState(id, ops),
         scope: api.sessionId,
      }),
      [api, uiState],
   );
}
