import type { Frontend } from "@harness/api";
import manifest from "../manifest.json";
import { ArtifactRequest } from "./features/artifacts/ArtifactRequest";
import { View } from "./shell/Root";

export const frontend: Frontend = { manifest, View, Request: ArtifactRequest };
export { RenderUiGallery } from "./features/artifacts/Gallery";
export { SharedArtifactView } from "./features/artifacts/SharedArtifactView";
export { setWrapCode, useWrapCode } from "./features/markdown/CodeBlock";
export { setGuessInlineCode, useGuessInlineCode } from "./features/markdown/inlineCode";
export {
   components,
   frontendTools,
   type RenderUiInput,
   renderUiSchema,
   type UiNode,
} from "./features/renderUi/tools";
export { setOptionIsMeta, useOptionIsMeta } from "./features/terminal/terminalOptions";
export { setToolDisplay, toolDisplays, useToolDisplay } from "./features/toolDisplay";
