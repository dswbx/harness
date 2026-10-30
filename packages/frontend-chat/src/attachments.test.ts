import { describe, expect, it } from "vitest";
import { baseName, fitWithin, fromPath, isImageName } from "./attachments";

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
});
