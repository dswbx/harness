import { lru } from "./lru";

/** Image data URLs by what they were read from. Bounded: a long Session's images do not all stay in memory. */
const images = lru<Promise<string>>({ maxEntries: 64, maxBytes: 48 * 1024 * 1024 });

/** The data URL of an image, read once while it is among the recent ones. A failed read is not kept. */
export function cachedImage(
   key: string,
   read: () => Promise<{ mime: string; data: string }>,
): Promise<string> {
   let p = images.get(key);
   if (!p) {
      p = read().then((r) => `data:${r.mime};base64,${r.data}`);
      images.set(key, p);
      p.then(
         (url) => images.resize(key, url.length),
         () => images.delete(key),
      );
   }
   return p;
}
