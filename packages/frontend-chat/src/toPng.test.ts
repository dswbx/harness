import { describe, expect, it } from "vitest";
import { FREEZE_ANIMATIONS, frameSvg } from "./toPng";

// WKWebView draws an SVG image at time 0 of its CSS animations: an Html frame with an entry animation
// (`from { opacity: 0 }`) came out blank in `view_artifact`. The rule shows each animation at its end.
describe("frameSvg", () => {
   it("shows CSS animations at their end", () => {
      const svg = frameSvg(
         '<html xmlns="http://www.w3.org/1999/xhtml"><body>x</body></html>',
         900,
         200,
      );
      expect(svg.xml).toContain(`<style>${FREEZE_ANIMATIONS}</style><foreignObject`);
      expect(svg).toMatchObject({ width: 900, height: 200 });
   });
});

describe("FREEZE_ANIMATIONS", () => {
   it("ends each animation at once and keeps its end state, over the Agent's own rules", () => {
      for (const d of [
         "animation-duration: 0s !important",
         "animation-delay: 0s !important",
         "animation-iteration-count: 1 !important",
         "animation-fill-mode: forwards !important",
      ])
         expect(FREEZE_ANIMATIONS).toContain(d);
      // `animation: none` would show the base style, blank for `opacity: 0; animation: show forwards`.
      expect(FREEZE_ANIMATIONS).not.toContain("animation: none");
      expect(FREEZE_ANIMATIONS).toMatch(/^\*, \*::before, \*::after \{/);
   });
});
