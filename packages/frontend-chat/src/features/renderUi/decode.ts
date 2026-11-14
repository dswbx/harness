import type { DecodedRenderUi, ToolDecoder } from "../../state/types";
import {
   formatErrors,
   RENDER_UI,
   type RenderUiInput,
   renderUiSchema,
   withSourceRoot,
} from "./tools";

/** The reducer's `ToolDecoder` (injected, see `chatReducer.ts`): validates `render_ui` inputs, null for other tools. */
export const decodeTool: ToolDecoder = (tool, input) => {
   if (tool !== RENDER_UI) return null;
   const r = renderUiSchema.validate(input);
   return r.valid
      ? { ok: true, value: withSourceRoot(input as RenderUiInput) }
      : { ok: false, errors: formatErrors(r.errors, input) };
};

/** A decoded input as its real type: `decodeTool` made it from a `RenderUiInput`. */
export const asRenderUi = (v: DecodedRenderUi) => v as RenderUiInput;
