import type { LineCommentState, SessionApi } from "@harness/api";
import { TooltipProvider } from "@harness/ui";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DiffViewer } from "./DiffViewer";
import { splitPatch } from "./diff";

afterEach(cleanup);

// The view measures text with a canvas; happy-dom has none.
HTMLCanvasElement.prototype.getContext = (() => ({
   font: "",
   measureText: () => ({ width: 8 }),
})) as never;
// The view renders an extend line only once its table has a width; happy-dom has no layout.
Element.prototype.getBoundingClientRect = () => ({ width: 400, height: 20 }) as DOMRect;

const patch =
   "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n keep\n-old line\n+new line\n";

const comment = {
   id: "c1",
   path: "a.ts",
   line: 2,
   side: "new",
   code: "new line",
   text: "please rename this",
   by: "user",
   status: "pending",
   resolvedBy: null,
   note: null,
} as unknown as LineCommentState;

describe("split diff with a review comment", () => {
   it("renders the comment, with no data on the other side", async () => {
      const [file] = splitPatch(patch);
      render(
         <TooltipProvider>
            <DiffViewer file={file!} mode="split" api={{} as SessionApi} comments={[comment]} />
         </TooltipProvider>,
      );
      expect(await screen.findByText("please rename this")).toBeTruthy();
   });
});
