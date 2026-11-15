import { HarnessClient, revealPath, type Transport } from "@harness/api";
import { useEffect } from "react";
import { useNotify, useReportError } from "./toast";

/** Shows each settings file the core had to reset, once, until dismissed. Mount in one window only. */
export function StartupNotices({ transport }: { transport: Transport }) {
   const notify = useNotify();
   const report = useReportError();
   useEffect(() => {
      const client = new HarnessClient(transport);
      let stop = false;
      let off: (() => void) | undefined;
      // The core hands each notice out once, so a second take (an event while one runs) is safe.
      const take = () =>
         client
            .takeNotices()
            .then((list) => {
               if (stop) return;
               for (const n of list) {
                  const shown = n.copy ?? n.path;
                  notify(n.message, {
                     label: "Show file",
                     run: () =>
                        void revealPath(shown).catch((e) => report("Could not show the file", e)),
                  });
               }
            })
            .catch((e) => report("Could not check for reset settings", e));
      // Subscribe first, then take: a notice that arrives in between is announced.
      void transport
         .subscribeApp((e) => {
            if (e.type === "NoticesChanged") void take();
         })
         .then((u) => (stop ? u() : (off = u)))
         .then(take);
      return () => {
         stop = true;
         off?.();
      };
   }, [transport, notify, report]);
   return null;
}
