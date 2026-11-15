import { storedValue } from "@harness/api";
import { useCallback, useState } from "react";

/** A localStorage-backed value (per-window convenience: falls back to `initial`, a failed write keeps the value in memory). */
export function useStored<T>(key: string, initial: T, valid: (v: unknown) => v is T) {
   // `key`, `initial` and `valid` are fixed per call site.
   const [store] = useState(() =>
      storedValue<T>({
         key,
         scope: "app",
         parse: (raw) => {
            try {
               const v: unknown = raw === null ? null : JSON.parse(raw);
               return valid(v) ? v : initial;
            } catch {
               return initial;
            }
         },
         sync: false,
      }),
   );
   const [value, setValue] = useState<T>(store.get);
   const set = useCallback(
      (v: T) => {
         setValue(v);
         store.set(v);
      },
      [store],
   );
   return [value, set] as const;
}
