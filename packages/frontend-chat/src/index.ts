import type { Frontend } from "@harness/api";
import manifest from "../manifest.json";
import { ArtifactRequest } from "./features/artifacts/ArtifactRequest";
import { RenderUiGallery } from "./features/artifacts/Gallery";
import { SharedArtifactView } from "./features/artifacts/SharedArtifactView";
import { setWrapCode, useWrapCode } from "./features/markdown/CodeBlock";
import { setGuessInlineCode, useGuessInlineCode } from "./features/markdown/inlineCode";
import { setOptionIsMeta, useOptionIsMeta } from "./features/terminal/terminalOptions";
import { View } from "./shell/Root";

export const frontend: Frontend = {
   manifest,
   View,
   Request: ArtifactRequest,
   SharedView: SharedArtifactView,
   Gallery: RenderUiGallery,
   toggles: [
      {
         id: "guess-inline-code",
         group: "chat",
         label: "Inline code",
         toggleLabel: "Guess the language",
         help: "From the message's code blocks and file names, else TypeScript",
         useValue: useGuessInlineCode,
         set: setGuessInlineCode,
      },
      {
         id: "wrap-code",
         group: "chat",
         label: "Code blocks",
         toggleLabel: "Wrap long lines",
         help: "Same as the wrap button on any code block",
         useValue: useWrapCode,
         set: setWrapCode,
      },
      {
         id: "option-is-meta",
         group: "terminal",
         label: "Option key",
         toggleLabel: "Use as Meta key",
         help: "On: Option sends Esc for shell shortcuts (Opt+B). Off: Option types characters like @ [ ] { }",
         useValue: useOptionIsMeta,
         set: setOptionIsMeta,
      },
   ],
};
export {
   components,
   frontendTools,
   type RenderUiInput,
   renderUiSchema,
   type UiNode,
} from "./features/renderUi/tools";

// Cards were removed; drop the stored tool display choice. Can go after a few releases.
try {
   localStorage.removeItem("harness.chat.toolDisplay");
} catch {
   /* storage unavailable */
}
