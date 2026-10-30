import { describe, expect, it } from "vitest";
import { baseName, fitWithin, fromPath, fromPickedPath, isImageName } from "./attachments";

describe("attachments", () => {
  it("fits the longer side within the max, never upscales", () => {
    expect(fitWithin(4000, 3000, 2000)).toEqual([2000, 1500]);
    expect(fitWithin(1000, 3000, 2000)).toEqual([667, 2000]);
    expect(fitWithin(800, 600, 2000)).toEqual([800, 600]);
  });

  it("path inputs: name and kind from the file name", () => {
    expect(baseName("/Users/me/shot.PNG")).toBe("shot.PNG");
    expect(isImageName("a.jpeg") && isImageName("b.webp") && !isImageName("c.svg") && !isImageName("d.pdf")).toBe(true);
    expect(fromPath("/tmp/x/notes.md")).toMatchObject({ name: "notes.md", kind: "file", input: { type: "path", path: "/tmp/x/notes.md" } });
    expect(fromPath("/tmp/x/s.png").kind).toBe("image");
  });

  it("picked paths: non-images skip reading; unreadable images fall back to the path; too large is an error", async () => {
    const read = async (): Promise<{ mime: string; data: string }> => { throw new Error("no file access"); };
    let called = false;
    expect(await fromPickedPath("/a/notes.md", async () => { called = true; return { mime: "", data: "" }; })).toMatchObject({ kind: "file" });
    expect(called).toBe(false);
    expect(await fromPickedPath("/a/s.png", read)).toMatchObject({ kind: "image", input: { type: "path", path: "/a/s.png" } });
    await expect(fromPickedPath("/a/big.png", async () => { throw new Error("/a/big.png is too large (25 MB max)"); })).rejects.toThrow("too large");
  });
});
