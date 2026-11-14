/**
 * A small cache that drops its least recently used entries past `maxEntries` or `maxBytes` (the sizes
 * `set` was given). For values that are large strings (images, documents) and would otherwise stay for
 * the window's lifetime. The newest entry always stays, however big.
 */
export function lru<V>({ maxEntries, maxBytes }: { maxEntries: number; maxBytes: number }) {
   const map = new Map<string, { value: V; bytes: number }>();
   let total = 0;
   const trim = () => {
      for (const [key, e] of map) {
         if (map.size <= 1 || (map.size <= maxEntries && total <= maxBytes)) return;
         map.delete(key);
         total -= e.bytes;
      }
   };
   return {
      get(key: string): V | undefined {
         const e = map.get(key);
         if (!e) return undefined;
         map.delete(key);
         map.set(key, e);
         return e.value;
      },
      /** Without counting as a use. */
      peek(key: string): V | undefined {
         return map.get(key)?.value;
      },
      /** `bytes`: what the value holds; unknown yet (a pending load): 0, then `resize`. */
      set(key: string, value: V, bytes = 0) {
         const old = map.get(key);
         if (old) total -= old.bytes;
         map.delete(key);
         map.set(key, { value, bytes });
         total += bytes;
         trim();
      },
      resize(key: string, bytes: number) {
         const e = map.get(key);
         if (!e) return;
         total += bytes - e.bytes;
         e.bytes = bytes;
         trim();
      },
      delete(key: string) {
         const e = map.get(key);
         if (!e) return;
         map.delete(key);
         total -= e.bytes;
      },
      get size() {
         return map.size;
      },
      get bytes() {
         return total;
      },
   };
}
