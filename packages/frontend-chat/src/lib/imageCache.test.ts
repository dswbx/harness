import { afterEach, expect, it, vi } from "vitest";
import { cachedImage, cachedImageNow } from "./imageCache";

afterEach(() => {
   vi.unstubAllGlobals();
   vi.useRealTimers();
});

it("reads an image once, as a data URL, and again after a failure", async () => {
   const read = vi.fn(async () => ({ mime: "image/png", data: "AAAA" }));
   expect(await cachedImage("t:one", read)).toBe("data:image/png;base64,AAAA");
   await cachedImage("t:one", read);
   expect(read).toHaveBeenCalledTimes(1);

   const bad = vi
      .fn<() => Promise<{ mime: string; data: string }>>()
      .mockRejectedValueOnce(new Error("gone"))
      .mockResolvedValue({ mime: "image/png", data: "BB" });
   await expect(cachedImage("t:two", bad)).rejects.toThrow("gone");
   await new Promise((r) => setTimeout(r));
   expect(await cachedImage("t:two", bad)).toBe("data:image/png;base64,BB");
});

it("does not hold more than a bounded number of images", async () => {
   const read = vi.fn(async () => ({ mime: "image/png", data: "x" }));
   for (let i = 0; i < 600; i++) await cachedImage(`t:many${i}`, read);
   await new Promise((r) => setTimeout(r));
   read.mockClear();
   await cachedImage("t:many0", read);
   expect(read).toHaveBeenCalledTimes(1);
   await cachedImage("t:many599", read);
   expect(read).toHaveBeenCalledTimes(1);
});

it("a read evicted before it settles does not touch the newer entry for its key", async () => {
   let late!: (r: { mime: string; data: string }) => void;
   const slow = new Promise<{ mime: string; data: string }>((r) => {
      late = r;
   });
   const first = cachedImage("t:evict", () => slow);
   // Push it out (more entries than the cache holds), then read the key again.
   for (let i = 0; i < 600; i++)
      await cachedImage(`t:fill${i}`, async () => ({ mime: "image/png", data: "x" }));
   const again = vi.fn(async () => ({ mime: "image/png", data: "NEW" }));
   expect(await cachedImage("t:evict", again)).toBe("data:image/png;base64,NEW");
   late({ mime: "image/png", data: "OLD" });
   await first;
   await new Promise((r) => setTimeout(r));
   // Still the new one, and not read a third time.
   expect(await cachedImage("t:evict", again)).toBe("data:image/png;base64,NEW");
   expect(again).toHaveBeenCalledTimes(1);
});

/** A browser `Image` whose `decode` does what the test says. */
function stubImage(decode: () => Promise<void>, size = { naturalWidth: 400, naturalHeight: 200 }) {
   vi.stubGlobal(
      "Image",
      class {
         src = "";
         naturalWidth = size.naturalWidth;
         naturalHeight = size.naturalHeight;
         decode = decode;
      },
   );
}
const png = async () => ({ mime: "image/png", data: "AAAA" });

it("hands out a decoded image with its ratio, at once for a later mount", async () => {
   stubImage(async () => {});
   expect(cachedImageNow("t:decoded")).toBeUndefined();
   const url = await cachedImage("t:decoded", png);
   expect(cachedImageNow("t:decoded")).toEqual({ url, ratio: 2 });
});

it("still hands out an image that cannot be decoded (broken, too large), without a ratio", async () => {
   stubImage(async () => {
      throw new Error("EncodingError");
   });
   const url = await cachedImage("t:broken", png);
   expect(url).toBe("data:image/png;base64,AAAA");
   expect(cachedImageNow("t:broken")).toEqual({ url, ratio: undefined });
});

it("does not wait forever for a decode that never settles", async () => {
   vi.useFakeTimers();
   stubImage(() => new Promise(() => {}));
   const p = cachedImage("t:hung", png);
   await vi.advanceTimersByTimeAsync(2000);
   expect(cachedImageNow("t:hung")).toBeUndefined();
   await vi.advanceTimersByTimeAsync(1500);
   expect(await p).toBe("data:image/png;base64,AAAA");
   expect(vi.getTimerCount()).toBe(0);
});
