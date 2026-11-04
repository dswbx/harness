import type { Frontend } from "@harness/api";
import manifest from "../manifest.json";
import { ArtifactRequest } from "./ArtifactRequest";
import { View } from "./View";

export const frontend: Frontend = { manifest, View, Request: ArtifactRequest };
export { setWrapCode, useWrapCode } from "./CodeBlock";
export { RenderUiGallery } from "./Gallery";
export { setGuessInlineCode, useGuessInlineCode } from "./inlineCode";
export { setOptionIsMeta, useOptionIsMeta } from "./terminalOptions";
export { setToolDisplay, toolDisplays, useToolDisplay } from "./toolDisplay";
export {
   components,
   frontendTools,
   type RenderUiInput,
   renderUiSchema,
   type UiNode,
} from "./tools";
