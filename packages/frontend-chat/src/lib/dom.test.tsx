import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

test("*.test.tsx runs in happy-dom", () => {
   expect(typeof document).toBe("object");
   expect(renderToStaticMarkup(<b>x</b>)).toBe("<b>x</b>");
});
