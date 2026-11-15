/**
 * Frontend Tools of the chat Frontend. Serialized into manifest.json by `bun run gen-manifests`.
 *
 * `render_ui` (ADR 0013, 0015): a tree of `{ type, props, children?, on? }` nodes from the catalog
 * (`catalog.ts`). Data binding follows json-render's syntax so we can adopt the library later: any prop
 * can be `{ "$state": "/path" }` or `{ "$template": "Done: ${/checks/done}" }` (read from the
 * Session State), inputs write with `{ "$bindState": "/path" }`, and `on` runs actions
 * (`setState`, `pushState`, `removeState`, plus our `sendMessage`). Inside a Repeat, json-render's
 * repeat scope: `{ "$item": "field" }`, `{ "$index": true }`, `{ "$bindItem": "field" }`, `${field}`.
 *
 * This file only re-exports the parts: `catalog.ts` (the groups' specs), `types.ts`, `schema.ts`
 * (the JSON Schema and the catalog text), `errors.ts`, `sources.ts` (file-backed and Shared nodes)
 * and `frontendTools.ts` (the manifest entries).
 */

export { components } from "./catalog";
export { formatErrors, shortError } from "./errors";
export { frontendTools, RENDER_UI } from "./frontendTools";
/** @internal Exported for tests. */
export { calculatorExample } from "./layout.spec";
export { renderUiSchema } from "./schema";
export { ICONS } from "./shared";
export {
   sharedNode,
   sharedNodeId,
   sharedRef,
   sourceTreeName,
   withSourceRoot,
} from "./sources";
export type {
   ComponentType,
   Placement,
   RawNode,
   RenderUiInput,
   StatePath,
   UiAction,
   UiNode,
   Visible,
} from "./types";
