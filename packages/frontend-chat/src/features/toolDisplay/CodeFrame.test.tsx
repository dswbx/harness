import { TooltipProvider } from "@harness/ui";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Markdown } from "../markdown/Markdown";
import { CodeFrame } from "./CodeFrame";

afterEach(cleanup);

const frame = (code: string, lang?: string) =>
   render(
      <TooltipProvider>
         <CodeFrame label="x" code={code} lang={lang} />
      </TooltipProvider>,
   ).container;

describe("CodeFrame", () => {
   // What it showed when it wrapped the code in a Markdown fence.
   const asFence = (code: string, lang: string) =>
      render(
         <TooltipProvider>
            <Markdown plainCode>{`\`\`\`\`${lang}\n${code}\n\`\`\`\``}</Markdown>
         </TooltipProvider>,
      ).container.querySelector("pre")!.outerHTML;

   it("renders the same code markup as a Markdown fence did", () => {
      for (const [code, lang] of [
         ["const x: number = 1;\nreturn x;", "ts"],
         ["plain text\nsecond", ""],
         ["a b", "nonesuch"],
         ["$ ls\nfile", "console"],
         ['{\n  "a": 1\n}', "json"],
      ] as const) {
         expect(frame(code, lang || undefined).querySelector("pre")!.outerHTML).toBe(
            asFence(code, lang),
         );
      }
   });

   it("shows ansi output as colors", () => {
      const pre = frame("\u001b[31mred\u001b[0m", "ansi").querySelector("pre")!;
      expect(pre.textContent).toBe("red");
      expect(pre.querySelector("[style]")).not.toBeNull();
   });

   it("shows code that has a line of backticks, whole", () => {
      const code = "before\n````\nafter `inline`\n```\nend";
      const pre = frame(code, "md").querySelector("pre")!;
      expect(pre.textContent).toBe(`${code}\n`);
   });

   it("highlights by the language it is given", () => {
      const pre = frame("const x = 1;", "typescript").querySelector("pre")!;
      expect(pre.querySelector(".hljs-keyword")?.textContent).toBe("const");
   });
});
