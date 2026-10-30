import { describe, expect, it } from "vitest";
import { parseAnsi } from "./ansi";

const E = "\u001b";

describe("parseAnsi", () => {
  it("keeps plain text and applies SGR colors and styles", () => {
    expect(parseAnsi(`ok ${E}[1;32mpass${E}[0m done`)).toEqual([
      { text: "ok " },
      { text: "pass", bold: true, fg: "var(--ansi-2)" },
      { text: " done" },
    ]);
  });
  it("handles bright, 256 and true colors, and resets one attribute", () => {
    const s = parseAnsi(`${E}[91ma${E}[38;5;196mb${E}[38;2;1;2;3mc${E}[39md`);
    expect(s.map((x) => x.fg)).toEqual(["var(--ansi-9)", "rgb(255, 0, 0)", "rgb(1, 2, 3)", undefined]);
  });
  it("drops cursor moves and terminal titles", () => {
    expect(parseAnsi(`${E}]0;title\u0007a${E}[2Kb${E}[1Ac`).map((x) => x.text).join("")).toBe("abc");
  });
});
