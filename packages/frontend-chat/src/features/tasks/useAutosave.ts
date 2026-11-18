import { errText, isCommandError } from "@harness/api";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

/**
 * `pending`: changed, the save waits. `conflict`: the save was refused because the value changed elsewhere
 * (`base_hash`, `base_updated_ms`); nothing saves until `reset`.
 */
export type AutosaveStatus = "idle" | "pending" | "saving" | "saved" | "conflict" | "error";

/** How long after the last change a save starts. */
export const AUTOSAVE_DELAY_MS = 600;

/**
 * Saves the last value given to `change`: `delayMs` after the last change, at once on `flush` (blur, Mod+Enter) and on
 * unmount. One save runs at a time; a change made while it runs is saved after it. `save` is read fresh each time, so
 * it can close over the latest base hash. A failed save keeps its value for the next try.
 */
export function useAutosave<T>(save: (value: T) => Promise<void>, delayMs = AUTOSAVE_DELAY_MS) {
   const saveRef = useRef(save);
   useLayoutEffect(() => {
      saveRef.current = save;
   });
   const [status, setStatus] = useState<AutosaveStatus>("idle");
   const [error, setError] = useState<string | null>(null);
   const pending = useRef<{ value: T } | null>(null);
   const running = useRef<Promise<void> | null>(null);
   const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
   const blocked = useRef(false);
   const mounted = useRef(true);

   const show = useCallback((s: AutosaveStatus, e: string | null = null) => {
      if (!mounted.current) return;
      setStatus(s);
      setError(e);
   }, []);

   const flush = useCallback((): Promise<void> => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      if (running.current) return running.current.then(flush);
      const next = pending.current;
      if (!next || blocked.current) return Promise.resolve();
      pending.current = null;
      show("saving");
      const run = saveRef.current(next.value).then(
         () => {
            running.current = null;
            if (pending.current) return flush();
            show("saved");
         },
         (e: unknown) => {
            running.current = null;
            if (isCommandError(e, "conflict")) {
               blocked.current = true;
               return show("conflict", errText(e));
            }
            pending.current ??= next;
            show("error", errText(e));
         },
      );
      running.current = run;
      return run;
   }, [show]);

   const change = useCallback(
      (value: T) => {
         pending.current = { value };
         if (blocked.current) return;
         show("pending");
         if (timer.current) clearTimeout(timer.current);
         timer.current = setTimeout(() => void flush(), delayMs);
      },
      [delayMs, flush, show],
   );

   /** Drops what waits and saving starts again (after the caller reloaded the value). */
   const reset = useCallback(() => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      pending.current = null;
      blocked.current = false;
      show("idle");
   }, [show]);

   /** Whether a change is not saved yet (waiting or saving). */
   const dirty = useCallback(() => !!pending.current || !!running.current, []);

   useEffect(() => {
      mounted.current = true;
      return () => {
         mounted.current = false;
         void flush();
      };
   }, [flush]);

   return useMemo(
      () => ({ status, error, change, flush, reset, dirty }),
      [status, error, change, flush, reset, dirty],
   );
}
