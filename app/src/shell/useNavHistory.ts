import { useCallback, useState } from "react";

/** Back/forward history of what the main pane showed; `index`: the entry shown now. */
export type Nav<T> = { entries: T[]; index: number };

const MAX = 100;

/** Shows `item`: drops the forward entries and appends it (same key as now: no change). */
export function navPush<T>(n: Nav<T>, item: T, key: (t: T) => string): Nav<T> {
   if (key(item) === key(n.entries[n.index] as T)) return n;
   const entries = [...n.entries.slice(0, n.index + 1), item].slice(-MAX);
   return { entries, index: entries.length - 1 };
}

/**
 * Index of the next entry in `dir` that can be shown (`ok`, e.g. its Session still exists) and
 * differs from the current one; null: none.
 */
export function navTarget<T>(
   n: Nav<T>,
   dir: -1 | 1,
   ok: (t: T) => boolean,
   key: (t: T) => string,
): number | null {
   const now = key(n.entries[n.index] as T);
   for (let i = n.index + dir; i >= 0 && i < n.entries.length; i += dir) {
      const e = n.entries[i] as T;
      if (ok(e) && key(e) !== now) return i;
   }
   return null;
}

/** In-memory navigation history: `go` records a new entry, `back`/`forward` move through it. */
export function useNavHistory<T>(initial: T, key: (t: T) => string, ok: (t: T) => boolean) {
   const [nav, setNav] = useState<Nav<T>>({ entries: [initial], index: 0 });
   const go = useCallback((item: T) => setNav((n) => navPush(n, item, key)), [key]);
   const step = useCallback(
      (dir: -1 | 1) =>
         setNav((n) => {
            const i = navTarget(n, dir, ok, key);
            return i === null ? n : { ...n, index: i };
         }),
      [ok, key],
   );
   return {
      current: nav.entries[nav.index] as T,
      go,
      back: useCallback(() => step(-1), [step]),
      forward: useCallback(() => step(1), [step]),
      canBack: navTarget(nav, -1, ok, key) !== null,
      canForward: navTarget(nav, 1, ok, key) !== null,
   };
}
