import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "./Markdown";

// Each render of ReactMarkdown is a full parse of its text.
const parses = vi.hoisted(() => ({ n: 0 }));
vi.mock("react-markdown", () => ({
   default: ({ children }: { children: string }) => {
      parses.n++;
      return <p>{children}</p>;
   },
}));

afterEach(cleanup);

/** A parent that re-renders on every Event (a panel), with the same file text each time. */
function Panel({ tick, text }: { tick: number; text: string }) {
   return (
      <div data-tick={tick}>
         <Markdown html>{text}</Markdown>
      </div>
   );
}

describe("Markdown", () => {
   it("does not parse its text again when only its parent re-renders", () => {
      const big = "| a | b |\n| - | - |\n| 1 | 2 |\n".repeat(5000);
      const ui = render(<Panel tick={0} text={big} />);
      expect(parses.n).toBe(1);
      for (let tick = 1; tick <= 10; tick++) ui.rerender(<Panel tick={tick} text={big} />);
      expect(parses.n).toBe(1);
      // A new text (the Agent wrote the file) is parsed once.
      ui.rerender(<Panel tick={11} text={`${big}| 3 | 4 |\n`} />);
      expect(parses.n).toBe(2);
   });
});
