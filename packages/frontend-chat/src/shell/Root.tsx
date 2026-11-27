import type { InstructionsScope } from "@harness/api";
import { DiffWindow } from "../features/changes/DiffWindow";
import { FileRefProvider } from "../features/files/FileRef";
import { FilesPanel } from "../features/files/FilesPanel";
import { OpenInstructions } from "../lib/OpenInstructions";
import { OpenSession } from "../lib/OpenSession";
import { diffScope, filesWindow, filesWindowFirst, panelWindowId } from "./routes";
import { type ChatProps, ChatView } from "./View";

/**
 * The Frontend's View: this page's window. A pop-out Diff window or Files window boots like a solo View
 * window, with `pane=diff` or `pane=files` in its URL (`routes.ts`). A panel window (`pane=panel`) is the
 * chat View showing only that panel; anything else is the chat.
 */
export function View({
   onOpenSession,
   onOpenInstructions,
   ...props
}: ChatProps & {
   onOpenSession?: (sessionId: string) => void;
   onOpenInstructions?: (scope: InstructionsScope) => void;
}) {
   const { api } = props;
   return diffScope ? (
      <DiffWindow source={{ kind: "session", api }} scope={diffScope} />
   ) : filesWindow ? (
      <FileRefProvider api={api}>
         <FilesPanel api={api} target={filesWindowFirst} popout />
      </FileRefProvider>
   ) : (
      <OpenSession.Provider value={onOpenSession ?? null}>
         <OpenInstructions.Provider value={onOpenInstructions ?? null}>
            <ChatView {...props} popout={panelWindowId ?? undefined} />
         </OpenInstructions.Provider>
      </OpenSession.Provider>
   );
}
