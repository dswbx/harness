import { lru } from "./lru";

/**
 * Image data URLs by what they were read from. Bounded mainly by bytes: a long Session's images do not all stay
 * in memory, while a gallery of many small ones is not read again.
 */
const images = lru<Promise<string>>({ maxEntries: 512, maxBytes: 48 * 1024 * 1024 });

/** The data URL of an image, read once while it is among the recent ones. A failed read is not kept. */
export function cachedImage(
   key: string,
   read: () => Promise<{ mime: string; data: string }>,
): Promise<string> {
   let p = images.get(key);
   if (!p) {
      const mine: Promise<string> = read().then((r) => `data:${r.mime};base64,${r.data}`);
      p = mine;
      images.set(key, mine);
      // Settling touches the entry only while it is still this read (it may be evicted and read again).
      mine.then(
         (url) => images.peek(key) === mine && images.resize(key, url.length),
         () => images.peek(key) === mine && images.delete(key),
      );
   }
   return p;
}
