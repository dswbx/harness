import { createSessionApi, type FrontendRequest, type Transport } from "@harness/api";
import { useEffect, useState } from "react";
import { registry } from "./registry";

/** Lets Frontends answer the requests of Frontend Tools with `replies`, in any window. The core takes the first answer. */
export function FrontendRequests({ transport }: { transport: Transport }) {
   const [requests, setRequests] = useState<FrontendRequest[]>([]);
   useEffect(() => {
      let stop = false;
      let off: (() => void) | undefined;
      void transport
         .subscribeApp((e) => {
            if (e.type === "FrontendRequest") setRequests((l) => [...l, e]);
         })
         .then((u) => (stop ? u() : (off = u)));
      return () => {
         stop = true;
         off?.();
      };
   }, [transport]);
   return requests.map((request) => {
      const Request = Object.values(registry).find((fe) =>
         fe.manifest.frontend_tools?.some((t) => t.name === request.tool && t.replies),
      )?.Request;
      if (!Request) return null;
      return (
         <Request
            key={request.request_id}
            api={createSessionApi(transport, request.session_id)}
            request={request}
            onDone={() => setRequests((l) => l.filter((r) => r !== request))}
         />
      );
   });
}
