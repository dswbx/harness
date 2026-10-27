import type { Frontend } from "@harness/api";
import manifest from "../manifest.json";
import { View } from "./View";

export const frontend: Frontend = { manifest, View };
export { jsonRenderSchema, frontendTools, type JsonRenderInput } from "./tools";
