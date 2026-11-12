import { useCallback, useState } from "react";

/** A localStorage-backed value (per-window convenience: falls back to `initial`, ignores write errors). */
export function useStored<T>(key: string, initial: T, valid: (v: unknown) => v is T) {
   const [value, setValue] = useState<T>(() => {
      try {
         const raw = localStorage.getItem(key);
         const v: unknown = raw === null ? null : JSON.parse(raw);
         return valid(v) ? v : initial;
      } catch {
         return initial;
      }
   });
   const set = useCallback(
      (v: T) => {
         setValue(v);
         try {
            localStorage.setItem(key, JSON.stringify(v));
         } catch {
            /* per-window convenience only */
         }
      },
      [key],
   );
   return [value, set] as const;
}
