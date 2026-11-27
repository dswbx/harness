import { folderDiffWindow } from "@harness/api";
import { Overlay } from "./overlay/Overlay";
import { FrontendRequests } from "./platform/FrontendRequests";
import { StartupNotices } from "./platform/StartupNotices";
import { ToastProvider } from "./platform/toast";
import { useTransport } from "./platform/useTransport";
import { FolderDiffWindow } from "./shell/FolderDiffWindow";
import { Shell } from "./shell/Shell";
import { Solo } from "./shell/Solo";

const params = new URLSearchParams(window.location.search);
/** A Folder Diff window: `?folder=<abs>&pane=diff`, no Session. */
const diffFolder = folderDiffWindow(window.location.search);

export function App() {
   const transport = useTransport();
   if (!transport) return null;
   if (diffFolder)
      return (
         <ToastProvider>
            <FolderDiffWindow transport={transport} folder={diffFolder} />
         </ToastProvider>
      );
   const solo = params.get("solo") === "1" && params.get("session");
   if (params.get("overlay") === "1")
      return (
         <ToastProvider>
            <Overlay transport={transport} />
         </ToastProvider>
      );
   return (
      <ToastProvider>
         {solo ? (
            <Solo transport={transport} sessionId={params.get("session")!} />
         ) : (
            <Shell transport={transport} />
         )}
         {!params.get("pane") && <FrontendRequests transport={transport} />}
         {!solo && !params.get("pane") && <StartupNotices transport={transport} />}
      </ToastProvider>
   );
}
