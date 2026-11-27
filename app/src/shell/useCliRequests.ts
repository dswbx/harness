import { inTauri } from "@harness/api";
import { useEffect, useRef } from "react";
import { listenHost } from "../overlay/overlayHost";
import type { CliRequest } from "../platform/generated";

/** How the hook reaches the host: the `cli_take` command and the `cli-request` poke. */
export type CliHost = {
   take: () => Promise<CliRequest[]>;
   /** Calls `onPoke` on each poke; `onListening` once registered. Returns a cleanup. */
   listen: (onPoke: () => void, onListening: () => void) => () => void;
};

const tauriHost: CliHost = {
   take: async () =>
      inTauri() ? (await import("@tauri-apps/api/core")).invoke<CliRequest[]>("cli_take") : [],
   listen: (onPoke, onListening) => listenHost("cli-request", onPoke, onListening),
};

/**
 * Requests from the `harness` command (ADR 0030): the host queues them and pokes the main window.
 * Takes the queue once listening (a request may have come before the page loaded) and on each poke.
 */
export function useCliRequests(on: (r: CliRequest) => void, host: CliHost = tauriHost) {
   const handler = useRef(on);
   useEffect(() => {
      handler.current = on;
   }, [on]);
   useEffect(() => {
      const take = () =>
         host.take().then(
            // Taken requests are gone from the host: hand them on even after unmount.
            (rs) => {
               for (const r of rs) handler.current(r);
            },
            (e) => console.error("cli_take failed", e),
         );
      return host.listen(take, take);
   }, [host]);
}
