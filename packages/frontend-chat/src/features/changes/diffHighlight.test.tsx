import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { highlightLines, languageOf } from "../markdown/highlight";
import { DiffViewer } from "./DiffViewer";
import { splitPatch } from "./diff";

afterEach(cleanup);

// The view measures text with a canvas; happy-dom has none.
HTMLCanvasElement.prototype.getContext = (() => ({
   font: "",
   measureText: () => ({ width: 8 }),
})) as never;

const patch = (path: string, body: string) =>
   `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,2 @@\n${body
      .split("\n")
      .map((l) => `+${l}`)
      .join("\n")}\n`;

/** The diff view's token classes for a new file at `path`. */
function diffTokens(path: string, body: string) {
   const [file] = splitPatch(patch(path, body));
   const { container } = render(<DiffViewer file={file!} mode="unified" />);
   return [...container.querySelectorAll("[class*='hljs-']")].map((e) => e.className);
}

describe("diff and file view highlight a path the same way", () => {
   it("tokens come out of the diff for every path the file view knows", () => {
      // `.vue` was plain in the diff and xml in the file view.
      for (const [path, body] of [
         ["App.vue", '<div class="a">x</div>\n<span>y</span>'],
         ["a.toml", "[a]\nb = 1"],
         ["a.c", "int main() {\nreturn 0;\n}"],
         ["a.ts", "const x = 1;\nexport {};"],
      ] as const) {
         expect(languageOf(path)).not.toBeNull();
         const fileView = highlightLines(languageOf(path), body.split("\n")).flat();
         expect(fileView.some((r) => r.cls)).toBe(true);
         expect([path, diffTokens(path, body).length > 0]).toEqual([path, true]);
      }
   });

   it("an unknown file stays plain in the diff", () => {
      expect(diffTokens("notes.unknownext", "const x = 1;\nfoo bar")).toEqual([]);
   });
});
