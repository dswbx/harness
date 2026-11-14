import { DiffWindow } from "../features/changes/DiffWindow";
import { FileRefProvider } from "../features/files/FileRef";
import { FilesPanel } from "../features/files/FilesPanel";
import { OpenSession } from "../lib/OpenSession";
import { diffScope, filesWindow, filesWindowFirst } from "./routes";
import { type ChatProps, ChatView } from "./View";

/**
 * The Frontend's View: this page's window. A pop-out Diff window or Files window boots like a solo View
 * window, with `pane=diff` or `pane=files` in its URL (`routes.ts`); anything else is the chat.
 */
export function View({
   onOpenSession,
   ...props
}: ChatProps & { onOpenSession?: (sessionId: string) => void }) {
   const { api } = props;
   return diffScope ? (
      <DiffWindow api={api} scope={diffScope} />
   ) : filesWindow ? (
      <FileRefProvider api={api}>
         <FilesPanel api={api} target={filesWindowFirst} popout />
      </FileRefProvider>
   ) : (
      <OpenSession.Provider value={onOpenSession ?? null}>
         <ChatView {...props} />
      </OpenSession.Provider>
   );
}
