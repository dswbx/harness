import { expect, it } from "vitest";
import { hashText } from "./hash";

it("is stable, short, and tells documents apart", () => {
   const big = `<div>${"x".repeat(100_000)}</div>`;
   expect(hashText(big)).toBe(hashText(big));
   expect(hashText(big).length).toBeLessThan(30);
   expect(hashText(big)).not.toBe(hashText(`${big} `));
   expect(hashText("<b>a</b>")).not.toBe(hashText("<b>b</b>"));
   expect(hashText("")).toBe(hashText(""));
});
