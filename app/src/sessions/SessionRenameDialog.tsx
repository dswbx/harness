import type { HarnessClient, SessionSummary } from "@harness/api";
import { RenameDialog } from "@harness/ui";
import { useRef } from "react";

/** The one dialog behind every "Rename…" entry: the row menus and the header. */
export function SessionRenameDialog({
   client,
   session,
   onClose,
}: {
   client: HarnessClient;
   /** The Session being renamed; null: closed. */
   session: SessionSummary | null;
   onClose: () => void;
}) {
   // Keeps the last Session while the dialog fades out.
   const last = useRef(session);
   if (session) last.current = session;
   const shown = last.current;
   return (
      <RenameDialog
         open={session !== null}
         onOpenChange={(o) => !o && onClose()}
         title="Rename Session"
         label="Title"
         maxLength={80}
         value={shown?.title ?? ""}
         onSave={(title) => (shown ? client.setSessionTitle(shown.id, title) : undefined)}
      />
   );
}
