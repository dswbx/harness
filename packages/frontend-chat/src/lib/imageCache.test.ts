import { expect, it, vi } from "vitest";
import { cachedImage } from "./imageCache";

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
   for (let i = 0; i < 100; i++) await cachedImage(`t:many${i}`, read);
   await new Promise((r) => setTimeout(r));
   read.mockClear();
   await cachedImage("t:many0", read);
   expect(read).toHaveBeenCalledTimes(1);
   await cachedImage("t:many99", read);
   expect(read).toHaveBeenCalledTimes(1);
});
