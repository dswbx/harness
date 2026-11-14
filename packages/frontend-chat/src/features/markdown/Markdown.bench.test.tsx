// @vitest-environment happy-dom
import { TooltipProvider } from "@harness/ui";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";

afterEach(cleanup);

const PROSE = "Some prose that explains what changed and why, with `code` and **emphasis**. ";
const BODY = `${PROSE.repeat(6)}\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n\`\`\`ts\nconst x: number = 1;\nfunction f() { return x; }\n\`\`\`\n\n${PROSE.repeat(6)}`;

const Md = ({ text }: { text: string }) => (
   <TooltipProvider>
      <Markdown>{text}</Markdown>
   </TooltipProvider>
);

describe("Markdown render cost", () => {
   it("a repeated render of a message with code is cheap (shared processor and highlighter)", () => {
      const view = render(<Md text={BODY} />);
      // Best of several batches: other work on the machine only ever adds time.
      let ms = Infinity;
      for (let r = 0; r < 8; r++) {
         const t0 = performance.now();
         for (let i = 0; i < 20; i++) view.rerender(<Md text={`${BODY} ${r}-${i}`} />);
         ms = Math.min(ms, (performance.now() - t0) / 20);
      }
      console.log(
         `markdown: ${ms.toFixed(2)} ms per re-render of a 1 KB message with a code block`,
      );
      expect(ms).toBeLessThan(100);
   }, 30_000);
});
