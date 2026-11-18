import { lru } from "./lru";

/**
 * Image data URLs by what they were read from. Bounded mainly by bytes: a long Session's images do not all stay
 * in memory, while a gallery of many small ones is not read again.
 */
const images = lru<Promise<string>>({ maxEntries: 512, maxBytes: 48 * 1024 * 1024 });
/** Settled reads, so a remounted row (the chat's virtual list) shows its image at once, at its height. */
const settled = new WeakMap<Promise<string>, { url: string; ratio?: number }>();

/** The data URL of `key` and its width/height if its read has already settled, else undefined. */
export function cachedImageNow(key: string): { url: string; ratio?: number } | undefined {
   const p = images.peek(key);
   return p && settled.get(p);
}

/**
 * Decodes the image before its URL is handed out: an `<img>` of a decoded image has its size when it
 * is laid out. Else WebKit lays it out empty and grows it a frame later, and in the chat's virtual
 * list the rows below jump. Also gives the width/height ratio. Nothing in a non-browser test.
 */
async function decode(url: string): Promise<number | undefined> {
   if (typeof Image === "undefined") return undefined;
   const img = new Image();
   img.src = url;
   try {
      await img.decode();
   } catch {
      return undefined;
   }
   return img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : undefined;
}

/** The data URL of an image, read once while it is among the recent ones. A failed read is not kept. */
export function cachedImage(
   key: string,
   read: () => Promise<{ mime: string; data: string }>,
): Promise<string> {
   let p = images.get(key);
   if (!p) {
      const mine: Promise<string> = read().then(async (r) => {
         const url = `data:${r.mime};base64,${r.data}`;
         const ratio = await decode(url);
         settled.set(mine, { url, ratio });
         return url;
      });
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
