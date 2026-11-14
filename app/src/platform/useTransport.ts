import type { Transport } from "@harness/api";
import { HarnessClient as Client } from "@harness/api";
import { useEffect, useState } from "react";
import { syncAppearance } from "../appearance/appearance";
import { makeTransport } from "./transport";

export function useTransport() {
   const [t, setT] = useState<Transport | null>(null);
   useEffect(() => {
      let cancelled = false; // StrictMode runs the effect twice: only the last run's transport is used
      void makeTransport().then((t) => {
         if (cancelled) return;
         // Appearance and imported themes live in the core; the local copy painted the first frame.
         void syncAppearance(new Client(t)).catch(() => {});
         setT(t);
      });
      return () => {
         cancelled = true;
      };
   }, []);
   return t;
}
