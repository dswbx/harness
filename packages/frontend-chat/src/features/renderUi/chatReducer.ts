import { createReducer } from "../../state/reducer";
import { decodeTool } from "./decode";

/** The chat Frontend's reducer: `createReducer` with the real `render_ui` decoder. The app imports it from here. */
export const { init, reduce, reduceBatch } = createReducer({ decodeTool });
